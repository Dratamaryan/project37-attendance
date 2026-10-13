/**
 * S8-T3 — pure logic for scripts/s8-t3-anniversary-spouse-enrich.ts.
 *
 * Everything here is pure (no fs, no env, no xlsx) EXCEPT guardedFillUpdate,
 * the one DB helper. It lives here, not in the entry point, so
 * tests/integration/s8-t3-enrich-guard.test.ts exercises the exact query the
 * apply path runs instead of a re-implementation.
 *
 * Dates: an anniversary is accepted ONLY from a JS Date cell (SheetJS
 * cellDates:true) sitting at exactly 00:00:00.000 UTC, and is emitted as
 * 'YYYY-MM-DD' built from its UTC parts. A Date is never constructed from a
 * string here (same discipline as lib/utils/date-display.ts). A Date with any
 * non-zero UTC time is the +1-day trap signal and aborts the whole run; every
 * other shape is quarantined with a reason code, never parsed.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export const ENRICH_FIELDS = ['wedding_anniversary', 'spouse_name'] as const
export type EnrichField = (typeof ENRICH_FIELDS)[number]

export const QUARANTINE_REASONS = {
  STRING_CELL: 'string-cell',
  NUMBER_CELL: 'number-cell',
  INVALID_DATE: 'invalid-date',
  YEAR_OUT_OF_RANGE: 'year-out-of-range',
  FUTURE_DATE: 'future-date',
  OTHER_CELL: 'other-cell',
} as const
export type QuarantineReason = (typeof QUARANTINE_REASONS)[keyof typeof QUARANTINE_REASONS]

export const MIN_ANNIVERSARY_YEAR = 1950

export type AnniversaryParse =
  | { kind: 'empty' }
  | { kind: 'ok'; iso: string }
  | { kind: 'quarantine'; reason: QuarantineReason }
  | { kind: 'abort-nonzero-utc-time' }

/** Source value for one field, after parsing/normalizing. */
export type SourceValue =
  | { kind: 'empty' }
  | { kind: 'value'; value: string }
  | { kind: 'quarantine'; reason: QuarantineReason }

export type FieldOutcome = 'would_fill' | 'already_equal' | 'conflict' | 'quarantined' | 'source_empty'
export type ApplyOutcome = 'filled' | 'race_skipped'

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * todayIso is 'YYYY-MM-DD' (UTC date at run start), injected so tests control
 * "now". Year bound and future check are both derived from it.
 */
export function parseAnniversaryCell(raw: unknown, todayIso: string): AnniversaryParse {
  if (raw === null || raw === undefined) return { kind: 'empty' }
  if (typeof raw === 'string') {
    return raw.trim() === '' ? { kind: 'empty' } : { kind: 'quarantine', reason: QUARANTINE_REASONS.STRING_CELL }
  }
  if (typeof raw === 'number') return { kind: 'quarantine', reason: QUARANTINE_REASONS.NUMBER_CELL }
  if (!(raw instanceof Date)) return { kind: 'quarantine', reason: QUARANTINE_REASONS.OTHER_CELL }

  if (Number.isNaN(raw.getTime())) return { kind: 'quarantine', reason: QUARANTINE_REASONS.INVALID_DATE }
  if (raw.getUTCHours() !== 0 || raw.getUTCMinutes() !== 0 || raw.getUTCSeconds() !== 0 || raw.getUTCMilliseconds() !== 0) {
    return { kind: 'abort-nonzero-utc-time' }
  }

  const year = raw.getUTCFullYear()
  const currentYear = Number(todayIso.slice(0, 4))
  if (year < MIN_ANNIVERSARY_YEAR || year > currentYear) {
    return { kind: 'quarantine', reason: QUARANTINE_REASONS.YEAR_OUT_OF_RANGE }
  }
  const iso = `${year}-${pad2(raw.getUTCMonth() + 1)}-${pad2(raw.getUTCDate())}`
  if (iso > todayIso) return { kind: 'quarantine', reason: QUARANTINE_REASONS.FUTURE_DATE }
  return { kind: 'ok', iso }
}

/** Trim + collapse internal whitespace runs to one space. No case change. Empty -> null. */
export function normalizeSpouse(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  const s = String(raw).trim().replace(/\s+/g, ' ')
  return s === '' ? null : s
}

export function anniversarySource(p: Exclude<AnniversaryParse, { kind: 'abort-nonzero-utc-time' }>): SourceValue {
  if (p.kind === 'ok') return { kind: 'value', value: p.iso }
  return p
}

export function spouseSource(normalized: string | null): SourceValue {
  return normalized === null ? { kind: 'empty' } : { kind: 'value', value: normalized }
}

export function decideField(snapshot: string | null, source: SourceValue): FieldOutcome {
  if (source.kind === 'quarantine') return 'quarantined'
  if (source.kind === 'empty') return 'source_empty'
  if (snapshot === null) return 'would_fill'
  return snapshot === source.value ? 'already_equal' : 'conflict'
}

export interface SnapshotRow {
  id: string
  wedding_anniversary: string | null
  spouse_name: string | null
}

export type FillPayload = Partial<Record<EnrichField, string>>

export interface RowPlan {
  personId: string
  rowIndex: number
  outcomes: Record<EnrichField, FieldOutcome>
  /** Only fields whose snapshot value is NULL and source has a value. null when nothing to write. */
  payload: FillPayload | null
}

export function planRow(
  snapshot: SnapshotRow,
  rowIndex: number,
  sources: Record<EnrichField, SourceValue>,
): RowPlan {
  const outcomes = {} as Record<EnrichField, FieldOutcome>
  const payload: FillPayload = {}
  for (const f of ENRICH_FIELDS) {
    const outcome = decideField(snapshot[f], sources[f])
    outcomes[f] = outcome
    const src = sources[f]
    if (outcome === 'would_fill' && src.kind === 'value') payload[f] = src.value
  }
  return {
    personId: snapshot.id,
    rowIndex,
    outcomes,
    payload: Object.keys(payload).length > 0 ? payload : null,
  }
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Pure pre-write guard over the whole plan. Returns violation strings (surrogate
 * ids + field names only); the caller hard-aborts on any. Enforces:
 *   - payload keys are a subset of ENRICH_FIELDS (never anniversary_consent_*,
 *     never anything else -- updated_at is added by guardedFillUpdate only)
 *   - every payload key's snapshot value is NULL and its outcome is would_fill
 *   - wedding_anniversary is 'YYYY-MM-DD'; spouse_name is non-empty + normalized
 */
export function assertPayloadGuard(plans: RowPlan[], snapshotById: Map<string, SnapshotRow>): string[] {
  const violations: string[] = []
  const allowed = new Set<string>(ENRICH_FIELDS)
  for (const p of plans) {
    if (!p.payload) continue
    const snap = snapshotById.get(p.personId)
    if (!snap) {
      violations.push(`personId=${p.personId} no snapshot row`)
      continue
    }
    for (const [key, value] of Object.entries(p.payload)) {
      if (!allowed.has(key)) {
        violations.push(`personId=${p.personId} key="${key}" not an enrich field`)
        continue
      }
      const f = key as EnrichField
      if (snap[f] !== null) violations.push(`personId=${p.personId} key="${f}" snapshot not NULL`)
      if (p.outcomes[f] !== 'would_fill') violations.push(`personId=${p.personId} key="${f}" outcome=${p.outcomes[f]} (expected would_fill)`)
      if (typeof value !== 'string') {
        violations.push(`personId=${p.personId} key="${f}" non-string value`)
        continue
      }
      if (f === 'wedding_anniversary' && !ISO_DATE_RE.test(value)) {
        violations.push(`personId=${p.personId} key="${f}" not YYYY-MM-DD`)
      }
      if (f === 'spouse_name' && normalizeSpouse(value) !== value) {
        violations.push(`personId=${p.personId} key="${f}" empty or not normalized`)
      }
    }
  }
  return violations
}

/**
 * The guarded fill-empty write: one UPDATE, only the payload's columns, each
 * additionally filtered `IS NULL` in SQL, plus updated_at set explicitly
 * (people has no updated_at trigger). 0 rows matched -> 'race_skipped' (the
 * caller never retries); 1 -> 'filled'; anything else throws.
 */
export async function guardedFillUpdate(
  supabase: SupabaseClient,
  personId: string,
  payload: FillPayload,
  updatedAtIso: string,
): Promise<ApplyOutcome> {
  const cols = Object.keys(payload)
  if (cols.length === 0) throw new Error('guardedFillUpdate: empty payload')
  for (const c of cols) {
    if (!(ENRICH_FIELDS as readonly string[]).includes(c)) throw new Error(`guardedFillUpdate: forbidden column "${c}"`)
  }

  let q = supabase
    .from('people')
    .update({ ...payload, updated_at: updatedAtIso })
    .eq('id', personId)
  for (const c of cols) q = q.is(c, null)

  const { data, error } = await q.select('id')
  if (error) throw new Error(`guardedFillUpdate: ${error.message}`)
  const n = data?.length ?? 0
  if (n === 0) return 'race_skipped'
  if (n === 1) return 'filled'
  throw new Error(`guardedFillUpdate: expected 0 or 1 row, got ${n}`)
}
