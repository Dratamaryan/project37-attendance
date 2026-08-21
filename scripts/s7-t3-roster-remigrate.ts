/**
 * S7-T3.2 — Roster re-migration (DATA UMAT (19Aug2026).xlsx -> public.people).
 *
 * Two modes:
 *   --mode=dry-run   (default) — read-only. Classifies every row, prints a
 *                     PII-safe report (surrogate keys / column names / bucket
 *                     counts only — never a name/phone/email/birth value).
 *   --mode=apply     — writes. Built and type-checked here, but this task
 *                     never invokes it: T3.2's job is the script + a local
 *                     dry-run, not a real or rehearsal write.
 *
 * RUNTIME WARNING — do NOT run this with `tsx` or `node --import tsx`.
 * normalizePhone (libphonenumber-js's `/min` subpath) fails SILENT under
 * tsx/esbuild's ESM loader: every valid phone comes back invalid, no thrown
 * error. See memory/feedback_collab.md ("Sprint 4 Task 2") and
 * scripts/repair-roster-birthdates.ts's header. This script self-asserts two
 * known-good phone results at startup (assertPhoneUtilTrustworthy) and
 * hard-exits if the runtime can't be trusted — that is the backstop, not a
 * substitute for the correct invocation:
 *
 *   npx tsc -p scripts/tsconfig.s7-t3.json
 *   node --env-file=.env.local scripts/.build/scripts/s7-t3-roster-remigrate.js [--mode=dry-run]
 *   node --env-file=.env.local scripts/.build/scripts/s7-t3-roster-remigrate.js --mode=apply --confirm-apply
 *
 * Required env (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) is read
 * from process.env, not loaded by this script — pass --env-file or export
 * manually. This mirrors scripts/s6-t6-import-commit.ts and, deliberately,
 * the preflight guard itself (RELEASE.md: "the guard process does not load
 * .env.local").
 *
 * GUARD: runPreflightGuard('roster-apply') runs first, in-process, before any
 * Supabase client is constructed — dynamic-imports scripts/preflight/guard.mjs
 * and resolve-ref.mjs (both plain Node ESM) rather than duplicating evaluate()
 * or resolveRef(). A local target (localhost/127.0.0.1) is allowed via the
 * S7-T3.1 exemption in evaluate(); a prod target still requires branch/ref
 * agreement. Aborts hard on guard failure, in both modes.
 *
 * COLUMN MAP (sheet "Form responses 1" -> people), per the S7-T3 field-mapping
 * recon: col1 Nama Lengkap -> full_name; col2 Nama Panggilan -> nickname
 * (fallback: first whitespace token of col1); col3 Nomor HP -> phone_e164
 * (match key); col4 Tempat Lahir -> birth_place; col5 Tanggal Lahir ->
 * birth_date; col7 Status Pernikahan -> marital_status; col12 (consent
 * question) -> consent; col13 Foto Diri Sendiri -> photo_url. Cols 0
 * (Timestamp, dedup key only, never written), 8, 9, 10, 11, 14 are read where
 * needed but never written to `people` — wedding/spouse/children/couple-photo
 * are deferred to S8 per project_overview.md.
 *
 * CONSENT (T3's own map, "3a" — deliberately NOT lib/import/normalize.ts's
 * mapConsentState, whose blank/'?' -> 'unknown' contradicts this sprint's
 * rule): trim+casefold(col12) === 'ya' -> granted; everything else (Tidak, ?,
 * blank) -> refused. There is no form-derived 'unknown' in T3 — 'unknown'
 * only ever exists as the pre-existing DB state on a matched row.
 *
 * MATCH ELIGIBILITY: a matched row's consent is touched ONLY when the
 * existing target state is photo_consent_state='unknown' AND
 * photo_publish_consent=false — this is what protects a person who already
 * granted consent through the S6 check-in flow (write-contract recon:
 * createPerson can leave photo_consent_state at its 'unknown' DB default
 * while photo_publish_consent is already true) from ever being downgraded by
 * a stale form answer.
 *
 * BUCKET PRIORITY (an explicit design decision, not directly specified) — a
 * matched-active row can independently qualify for a demographic fill AND a
 * consent move at once (e.g. birth_date is null AND consent is eligible).
 * Buckets must partition all 227 rows exactly once for the reconciliation
 * rail, so priority is: would-conflict > matched-fill > matched-consent-move
 * > matched-no-op. A matched-fill row that ALSO has an eligible consent move
 * carries that transition as an annotation on its report line (and, in apply
 * mode, in its UPDATE payload) so the move is never silently dropped by the
 * priority choice — only the bucket COUNT reflects fill as primary.
 *
 * Similarly, phone validity is checked before full_name (matching requires a
 * phone key; you cannot decide match-vs-insert without one), so a fully
 * blank row (blank name AND blank phone) lands in 'no-phone', not 'no-name'.
 * The ~100 "blank" rows this file is known to contain (S7-T3 recon) are
 * therefore folded into 'no-phone' for the 11-bucket reconciliation; the
 * "answered/blank" split reported separately is an orthogonal diagnostic
 * computed straight off the raw cells (full_name blank AND phone raw blank),
 * not a bucket membership.
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import * as XLSX from 'xlsx'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import { normalizePhone } from '../lib/utils/phone'
import { AUDIT_ACTIONS, logAudit } from '../lib/audit'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FILE_PATH = path.resolve(process.cwd(), 'docs/migration/DATA UMAT (19Aug2026).xlsx')
const EXPECTED_SHEET_COUNT = 1

type MaritalStatus = 'single' | 'married'
type ConsentState = 'granted' | 'refused'
type FillableField = 'birth_date' | 'birth_place' | 'marital_status' | 'photo_url'
const FILLABLE_FIELDS: FillableField[] = ['birth_date', 'birth_place', 'marital_status', 'photo_url']

const HEADER_ALIASES = {
  full_name: 'Nama Lengkap',
  nickname: 'Nama Panggilan',
  phone: 'Nomor HP',
  birth_place: 'Tempat Lahir',
  birth_date: 'Tanggal Lahir',
  marital_status: 'Status Pernikahan',
  consent: 'Apakah kamu setuju untuk foto / data di publish di group WA Project 37 untuk ucapan-ucapan ?',
  photo_url: 'Foto Diri Sendiri',
} as const
type FieldKey = keyof typeof HEADER_ALIASES

// ---------------------------------------------------------------------------
// cellToTrimmedString — reimplemented here (verbatim 3-line shape), not
// imported: lib/import/normalize.ts's own copy is module-private (not
// exported). Deviation, flagged by name per the task instructions: this is
// the one helper duplicated rather than reused, because reuse would require
// touching lib/import/normalize.ts (a production import path) to export a
// helper solely for this one-off script. normalizePhone (the actual landmine
// helper) IS imported for real, from lib/utils/phone.
// ---------------------------------------------------------------------------

function cellToTrimmedString(raw: unknown): string {
  if (raw === null || raw === undefined) return ''
  return String(raw).trim()
}

// ---------------------------------------------------------------------------
// Phone-util self-assert (backstop for the tsx/esbuild ESM-loader bug)
// ---------------------------------------------------------------------------

function assertPhoneUtilTrustworthy(): void {
  const idResult = normalizePhone('081234567890', 'ID')
  const idOk = idResult.ok && idResult.e164 === '+6281234567890'

  // '+' prefix must be parsed as international -- the 'ID' hint must NOT be
  // forced onto an already-international number.
  const auResult = normalizePhone('+61412345678', 'ID')
  const auOk = auResult.ok && auResult.e164 === '+61412345678' && auResult.e164.startsWith('+61')

  if (!idOk || !auOk) {
    console.error(
      `FATAL: phone-util self-assert failed -- ID: ${JSON.stringify(idResult)}, AU: ${JSON.stringify(auResult)}. ` +
        `This runtime cannot be trusted for phone matching (likely running under tsx -- see the RUNTIME WARNING ` +
        `at the top of this file). Refusing to process any row.`,
    )
    process.exit(1)
  }
  console.log('[phone-util-guard] OK -- ID and AU known-good phones normalized correctly under this runtime')
}

// Per-cell recovery rule: numeric cells String()'d; digits not starting with
// '0' or '+' get a '0' prepended (ID dropped-leading-zero recovery) before
// normalizing. A '+' prefix is parsed international, untouched.
function normalizeRosterPhone(raw: unknown): ReturnType<typeof normalizePhone> {
  let str = raw === null || raw === undefined ? '' : typeof raw === 'number' ? String(raw) : String(raw).trim()
  str = str.trim()
  if (!str) return { ok: false, reason: 'empty' }
  if (!str.startsWith('0') && !str.startsWith('+')) {
    str = '0' + str
  }
  return normalizePhone(str, 'ID')
}

// ---------------------------------------------------------------------------
// Preflight guard -- dynamic-imports the real guard.mjs/resolve-ref.mjs
// (plain Node ESM, not compiled by this script's tsconfig) rather than
// duplicating evaluate()/resolveRef(). getBranch()/loadMap() ARE duplicated
// below (tiny, ~10 lines total) because guard.mjs does not export them --
// only evaluate and matchBranchRef are exported for library use.
// ---------------------------------------------------------------------------

interface ResolvedRef {
  ref: string | null
  local: boolean
  sources: Record<string, string | null>
  disagree: boolean
}
interface EvaluateArgs {
  branch: string
  op?: string
  resolved: ResolvedRef | null
  map: unknown
}
interface EvaluateResult {
  ok: boolean
  reason: string | null
}
type EvaluateFn = (args: EvaluateArgs) => EvaluateResult
type ResolveRefFn = (args: { op?: string }) => ResolvedRef

function getBranch(): string {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function loadMap(): unknown {
  const mapPath = path.resolve(process.cwd(), 'supabase/preflight.branch-ref.json')
  try {
    if (!existsSync(mapPath)) return null
    return JSON.parse(readFileSync(mapPath, 'utf8'))
  } catch {
    return null
  }
}

async function runPreflightGuard(op: string): Promise<void> {
  // Plain absolute filesystem paths, NOT file:// URLs -- module=commonjs
  // compiles this dynamic import() to require(), and Node's require()
  // accepts a bare absolute path but not a file:// URL string.
  const guardPath = path.resolve(process.cwd(), 'scripts/preflight/guard.mjs')
  const resolveRefPath = path.resolve(process.cwd(), 'scripts/preflight/resolve-ref.mjs')

  const guardMod = (await import(guardPath)) as { evaluate: EvaluateFn }
  const resolveRefMod = (await import(resolveRefPath)) as { resolveRef: ResolveRefFn }

  const branch = getBranch()
  const map = loadMap()
  const resolved = resolveRefMod.resolveRef({ op })
  const result = guardMod.evaluate({ branch, op, resolved, map })

  if (!result.ok) {
    console.error('')
    console.error('==================== PREFLIGHT ABORT (s7-t3-roster-remigrate) ====================')
    console.error(`  branch:        ${branch || '(empty/detached)'}`)
    console.error(`  op:            ${op}`)
    console.error(`  resolved ref:  ${resolved.ref ?? '(none)'} (local=${resolved.local})`)
    console.error(`  reason:        ${result.reason}`)
    console.error('====================================================================================')
    console.error('')
    process.exit(1)
  }
  console.log(`[preflight] OK -- branch=${branch} op=${op} ref=${resolved.ref} local=${resolved.local}`)
}

// ---------------------------------------------------------------------------
// Date coercion -- DD/MM/YYYY (ID locale), per T3's explicit spec. NOT
// reused from lib/import/normalize.ts's coerceDate, which is MM/DD/YYYY
// (US month-first, per that file's own comment) -- a different source
// format entirely, not merely a private-helper visibility issue.
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

interface DateCoercionResult {
  value: string | null
  unparseable: boolean
}

function coerceBirthDate(raw: unknown): DateCoercionResult {
  if (raw === null || raw === undefined || raw === '') return { value: null, unparseable: false }

  if (typeof raw === 'number') {
    const code = XLSX.SSF.parse_date_code(raw)
    if (!code) return { value: null, unparseable: true }
    return { value: `${code.y}-${pad2(code.m)}-${pad2(code.d)}`, unparseable: false }
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed)
    if (!match) return { value: null, unparseable: true }
    const day = Number(match[1])
    const month = Number(match[2])
    const year = Number(match[3])
    if (month < 1 || month > 12 || day < 1 || day > 31) return { value: null, unparseable: true }
    return { value: `${year}-${pad2(month)}-${pad2(day)}`, unparseable: false }
  }

  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return { value: null, unparseable: true }
    return {
      value: `${raw.getUTCFullYear()}-${pad2(raw.getUTCMonth() + 1)}-${pad2(raw.getUTCDate())}`,
      unparseable: false,
    }
  }

  return { value: null, unparseable: true }
}

const MARITAL_STATUS_MAP: Record<string, MaritalStatus> = {
  'belum menikah': 'single',
  'sudah menikah': 'married',
}

function mapMaritalStatus(raw: unknown): { value: MaritalStatus | null; unmapped: boolean } {
  const str = cellToTrimmedString(raw)
  if (!str) return { value: null, unmapped: false }
  const mapped = MARITAL_STATUS_MAP[str.toLowerCase()]
  if (mapped) return { value: mapped, unmapped: false }
  return { value: null, unmapped: true } // T3's map only defines 3 outcomes; anything else -> NULL, same as blank
}

// T3's own consent map (3a) -- deliberately not mapConsentState.
function mapConsent(raw: unknown): ConsentState {
  const str = cellToTrimmedString(raw).toLowerCase()
  return str === 'ya' ? 'granted' : 'refused'
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

interface ParsedRow {
  sourceRowNumber: number // 0-indexed sheet row (header=row 0), matching the S7-T3 recon's own indexing
  timestampSerial: number | null
  full_name: string | null
  nicknameRaw: string
  phoneRaw: unknown
  phoneResult: ReturnType<typeof normalizePhone>
  birth_place: string | null
  birth_date: string | null
  birthDateUnparseable: boolean
  marital_status: MaritalStatus | null
  maritalUnmapped: boolean
  photo_url: string | null
  consentState: ConsentState
  isBlank: boolean // diagnostic only: full_name AND phone raw both blank
}

function findColumnIndices(headerRow: unknown[]): Record<FieldKey, number> {
  const normalized = headerRow.map((c) => cellToTrimmedString(c))
  const result = {} as Record<FieldKey, number>
  const missing: string[] = []
  for (const [key, alias] of Object.entries(HEADER_ALIASES) as [FieldKey, string][]) {
    const idx = normalized.findIndex((cell) => cell === alias)
    if (idx < 0) missing.push(alias)
    else result[key] = idx
  }
  if (missing.length > 0) {
    throw new Error(`COLUMN MAP FAILED: header(s) not found in row 0: ${missing.join(', ')}`)
  }
  return result
}

function parseWorkbook(buffer: Buffer): { rows: ParsedRow[]; totalRows: number } {
  // cellDates: true -- matches lib/import/commit.impl.ts/dry-run.impl.ts's own
  // XLSX.read call exactly. Without it, a date-formatted numeric cell decoded
  // via XLSX.SSF.parse_date_code directly comes out ONE DAY AHEAD of what the
  // existing DB holds (which was imported through the cellDates:true + `raw
  // instanceof Date` + UTC-extraction path) -- a real SheetJS discrepancy
  // between its own two date-decoding paths, caught empirically here as a
  // suspiciously uniform +1-day 'would-conflict' on ~all matched birth_dates
  // before this fix. Matching the proven path eliminates it.
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true })
  if (wb.SheetNames.length !== EXPECTED_SHEET_COUNT) {
    throw new Error(`SHEET GUARD FAILED: expected ${EXPECTED_SHEET_COUNT} sheet, got ${wb.SheetNames.length}: ${wb.SheetNames.join(', ')}`)
  }
  const ws = wb.Sheets[wb.SheetNames[0]]
  const ref = ws['!ref']
  if (!ref) throw new Error('SHEET GUARD FAILED: empty sheet, no !ref')
  const range = XLSX.utils.decode_range(ref)
  const headerRowIdx = range.s.r

  const headerRow: unknown[] = []
  for (let c = range.s.c; c <= range.e.c; c++) {
    const cell = ws[XLSX.utils.encode_cell({ r: headerRowIdx, c })]
    headerRow.push(cell ? cell.v : null)
  }
  const colIdx = findColumnIndices(headerRow)

  function cellAt(r: number, field: FieldKey): unknown {
    const c = colIdx[field]
    const cell = ws[XLSX.utils.encode_cell({ r, c })]
    return cell ? cell.v : null
  }
  function timestampAt(r: number): unknown {
    const cell = ws[XLSX.utils.encode_cell({ r, c: 0 })]
    return cell ? cell.v : null
  }

  const rows: ParsedRow[] = []
  let count = 0
  // Every row index from headerRowIdx+1 through range.e.r counts as one data
  // row, full stop -- including physically fully-blank ones. This matches the
  // S7-T3 recon's own definition (227 = range.e.r - headerRowIdx) exactly, and
  // is required for the reconciliation rail below to hit 227, not a
  // post-filtered subset. A fully-blank row still flows through
  // classification and lands in 'no-phone' (phone is checked before
  // full_name -- see the header comment's BUCKET PRIORITY note).
  for (let r = headerRowIdx + 1; r <= range.e.r; r++) {
    count++

    const fullNameRaw = cellAt(r, 'full_name')
    const fullNameStr = cellToTrimmedString(fullNameRaw)
    const phoneRaw = cellAt(r, 'phone')
    const phoneRawStr = cellToTrimmedString(phoneRaw)
    const nicknameRawStr = cellToTrimmedString(cellAt(r, 'nickname'))
    const birthPlaceStr = cellToTrimmedString(cellAt(r, 'birth_place'))
    const dateResult = coerceBirthDate(cellAt(r, 'birth_date'))
    const maritalResult = mapMaritalStatus(cellAt(r, 'marital_status'))
    const photoUrlStr = cellToTrimmedString(cellAt(r, 'photo_url'))
    const consentState = mapConsent(cellAt(r, 'consent'))
    const tsRaw = timestampAt(r)

    rows.push({
      sourceRowNumber: r,
      timestampSerial: typeof tsRaw === 'number' ? tsRaw : null,
      full_name: fullNameStr || null,
      nicknameRaw: nicknameRawStr,
      phoneRaw,
      phoneResult: normalizeRosterPhone(phoneRaw),
      birth_place: birthPlaceStr || null,
      birth_date: dateResult.value,
      birthDateUnparseable: dateResult.unparseable,
      marital_status: maritalResult.value,
      maritalUnmapped: maritalResult.unmapped,
      photo_url: photoUrlStr || null,
      consentState,
      isBlank: fullNameStr === '' && phoneRawStr === '',
    })
  }

  return { rows, totalRows: count }
}

function deriveNickname(fullName: string, nicknameRaw: string): string {
  return nicknameRaw || fullName.split(/\s+/)[0]
}

// ---------------------------------------------------------------------------
// Dedup -- by normalized phone, keep latest by col0 Timestamp (numeric serial
// for every non-blank Timestamp cell in this file -- confirmed during
// development; a missing/non-numeric timestamp sorts as -Infinity so it can
// never beat a sibling that has one).
// ---------------------------------------------------------------------------

interface DedupOutcome {
  survivors: ParsedRow[]
  superseded: ParsedRow[]
}

function dedupByPhone(rows: ParsedRow[]): DedupOutcome {
  const groups = new Map<string, ParsedRow[]>()
  const passthrough: ParsedRow[] = []

  for (const row of rows) {
    if (!row.phoneResult.ok) {
      passthrough.push(row)
      continue
    }
    const key = row.phoneResult.e164
    const group = groups.get(key)
    if (group) group.push(row)
    else groups.set(key, [row])
  }

  const survivors: ParsedRow[] = [...passthrough]
  const superseded: ParsedRow[] = []

  for (const group of groups.values()) {
    if (group.length === 1) {
      survivors.push(group[0])
      continue
    }
    const sorted = [...group].sort((a, b) => (b.timestampSerial ?? -Infinity) - (a.timestampSerial ?? -Infinity))
    survivors.push(sorted[0])
    superseded.push(...sorted.slice(1))
  }

  // Restore original row order for stable, re-derivable output.
  survivors.sort((a, b) => a.sourceRowNumber - b.sourceRowNumber)
  return { survivors, superseded }
}

// ---------------------------------------------------------------------------
// Target lookup -- ALL rows incl. inactive (anonymized/deleted), one batched
// query. people_phone_e164_key guarantees <=1 match per phone.
// ---------------------------------------------------------------------------

interface ExistingPersonRow {
  id: string
  phone_e164: string
  anonymized_at: string | null
  deleted_at: string | null
  birth_date: string | null
  birth_place: string | null
  marital_status: MaritalStatus | null
  photo_url: string | null
  photo_consent_state: 'granted' | 'refused' | 'unknown'
  photo_publish_consent: boolean
}

async function lookupExisting(supabase: SupabaseClient, phones: string[]): Promise<Map<string, ExistingPersonRow>> {
  const unique = [...new Set(phones)]
  const result = new Map<string, ExistingPersonRow>()
  if (unique.length === 0) return result

  const { data, error } = await supabase
    .from('people')
    .select('id, phone_e164, anonymized_at, deleted_at, birth_date, birth_place, marital_status, photo_url, photo_consent_state, photo_publish_consent')
    .in('phone_e164', unique)

  if (error) throw error
  for (const person of (data ?? []) as ExistingPersonRow[]) {
    result.set(person.phone_e164, person)
  }
  return result
}

// ---------------------------------------------------------------------------
// Fill / conflict / consent-move computation
// ---------------------------------------------------------------------------

interface FormFillValues {
  birth_date: string | null
  birth_place: string | null
  marital_status: MaritalStatus | null
  photo_url: string | null
}

/** Whole-day difference between two 'YYYY-MM-DD' strings (form minus existing),
 *  or null if either fails to parse. Used only to detect the suspected
 *  systematic date-serial discrepancy below -- not printed as a date. */
function dayDiff(existingIso: string, formIso: string): number | null {
  const a = Date.parse(existingIso + 'T00:00:00Z')
  const b = Date.parse(formIso + 'T00:00:00Z')
  if (Number.isNaN(a) || Number.isNaN(b)) return null
  return Math.round((b - a) / 86400000)
}

function computeFillAndConflict(
  existing: ExistingPersonRow,
  form: FormFillValues,
): { fillFields: FillableField[]; conflictFields: FillableField[]; birthDateDayDiff: number | null } {
  const fillFields: FillableField[] = []
  const conflictFields: FillableField[] = []
  let birthDateDayDiff: number | null = null
  const pairs: [FillableField, string | null, string | null][] = [
    ['birth_date', existing.birth_date, form.birth_date],
    ['birth_place', existing.birth_place, form.birth_place],
    ['marital_status', existing.marital_status, form.marital_status],
    ['photo_url', existing.photo_url, form.photo_url],
  ]
  for (const [field, existingVal, formVal] of pairs) {
    if (formVal === null || formVal === '') continue
    if (existingVal === null) {
      fillFields.push(field)
      continue
    }
    if (existingVal !== formVal) {
      conflictFields.push(field)
      if (field === 'birth_date') birthDateDayDiff = dayDiff(existingVal, formVal)
    }
  }
  return { fillFields, conflictFields, birthDateDayDiff }
}

function computeConsentEligibility(existing: ExistingPersonRow): boolean {
  return existing.photo_consent_state === 'unknown' && existing.photo_publish_consent === false
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

type Bucket =
  | 'matched-fill'
  | 'matched-consent-move'
  | 'matched-no-op'
  | 'would-conflict'
  | 'new-insert'
  | 'no-phone'
  | 'no-name'
  | 'phone-normalize-failed'
  | 'duplicate-superseded'
  | 'matched-anonymized'
  | 'matched-deleted'

const ALL_BUCKETS: Bucket[] = [
  'matched-fill',
  'matched-consent-move',
  'matched-no-op',
  'would-conflict',
  'new-insert',
  'no-phone',
  'no-name',
  'phone-normalize-failed',
  'duplicate-superseded',
  'matched-anonymized',
  'matched-deleted',
]

interface ClassifiedRow {
  bucket: Bucket
  sourceRowNumber: number
  personId?: string
  filledFields?: FillableField[]
  alsoConsentTransition?: string | null
  conflictFields?: FillableField[]
  birthDateDayDiff?: number | null
  consentTransition?: string
  presentColumns?: string[]
  consentDecision?: ConsentState
  insertPayload?: Record<string, unknown>
  updatePayload?: Record<string, unknown>
}

function classifyRow(row: ParsedRow, existingByPhone: Map<string, ExistingPersonRow>): ClassifiedRow {
  const base = { sourceRowNumber: row.sourceRowNumber }

  if (!row.phoneResult.ok) {
    return { ...base, bucket: row.phoneResult.reason === 'empty' ? 'no-phone' : 'phone-normalize-failed' }
  }

  const e164 = row.phoneResult.e164
  const existing = existingByPhone.get(e164)

  if (existing) {
    if (existing.anonymized_at !== null) return { ...base, bucket: 'matched-anonymized', personId: existing.id }
    if (existing.deleted_at !== null) return { ...base, bucket: 'matched-deleted', personId: existing.id }

    const form: FormFillValues = {
      birth_date: row.birth_date,
      birth_place: row.birth_place,
      marital_status: row.marital_status,
      photo_url: row.photo_url,
    }
    const { fillFields, conflictFields, birthDateDayDiff } = computeFillAndConflict(existing, form)
    const consentEligible = computeConsentEligibility(existing)
    const transition = consentEligible ? `unknown->${row.consentState}` : undefined

    if (conflictFields.length > 0) {
      return { ...base, bucket: 'would-conflict', personId: existing.id, conflictFields, birthDateDayDiff }
    }
    if (fillFields.length > 0) {
      const updatePayload: Record<string, unknown> = { updated_at: new Date().toISOString() }
      for (const f of fillFields) updatePayload[f] = form[f]
      if (consentEligible) {
        updatePayload.photo_consent_state = row.consentState
        updatePayload.photo_publish_consent = row.consentState === 'granted'
      }
      return {
        ...base,
        bucket: 'matched-fill',
        personId: existing.id,
        filledFields: fillFields,
        alsoConsentTransition: transition ?? null,
        updatePayload,
      }
    }
    if (consentEligible) {
      return {
        ...base,
        bucket: 'matched-consent-move',
        personId: existing.id,
        consentTransition: transition,
        updatePayload: {
          photo_consent_state: row.consentState,
          photo_publish_consent: row.consentState === 'granted',
          updated_at: new Date().toISOString(),
        },
      }
    }
    return { ...base, bucket: 'matched-no-op', personId: existing.id }
  }

  // No match -> candidate insert.
  if (!row.full_name) return { ...base, bucket: 'no-name' }

  const nickname = deriveNickname(row.full_name, row.nicknameRaw)
  const presentColumns = ['phone_e164', 'full_name', 'nickname']
  const insertPayload: Record<string, unknown> = {
    phone_e164: e164,
    full_name: row.full_name,
    nickname,
    photo_consent_state: row.consentState,
    photo_publish_consent: row.consentState === 'granted',
  }
  for (const f of FILLABLE_FIELDS) {
    const val = row[f]
    if (val !== null) {
      insertPayload[f] = val
      presentColumns.push(f)
    }
  }

  return {
    ...base,
    bucket: 'new-insert',
    presentColumns,
    consentDecision: row.consentState,
    insertPayload,
  }
}

// ---------------------------------------------------------------------------
// Edge-row report (sheet rows 82 and 100) -- {country, valid, e164_length}
// ONLY, never digits.
// ---------------------------------------------------------------------------

function edgeRowSummary(row: ParsedRow | undefined): { country: string | null; valid: boolean; e164_length: number | null } {
  if (!row) return { country: null, valid: false, e164_length: null }
  if (!row.phoneResult.ok) return { country: null, valid: false, e164_length: null }
  const e164 = row.phoneResult.e164
  const country = e164.startsWith('+62') ? 'ID' : e164.startsWith('+61') ? 'AU' : e164.startsWith('+65') ? 'SG' : e164.startsWith('+60') ? 'MY' : e164.startsWith('+64') ? 'NZ' : 'OTHER'
  return { country, valid: true, e164_length: e164.length }
}

// ---------------------------------------------------------------------------
// Dry-run report (PII-SAFE: surrogate keys / column names / counts only)
// ---------------------------------------------------------------------------

async function universeCounts(supabase: SupabaseClient): Promise<{ total: number; anonymized: number; deleted: number }> {
  const { count: total, error: e1 } = await supabase.from('people').select('id', { count: 'exact', head: true })
  if (e1) throw e1
  const { count: anonymized, error: e2 } = await supabase.from('people').select('id', { count: 'exact', head: true }).not('anonymized_at', 'is', null)
  if (e2) throw e2
  const { count: deleted, error: e3 } = await supabase.from('people').select('id', { count: 'exact', head: true }).not('deleted_at', 'is', null)
  if (e3) throw e3
  return { total: total ?? 0, anonymized: anonymized ?? 0, deleted: deleted ?? 0 }
}

function printDryRunReport(
  allRows: ParsedRow[],
  totalRows: number,
  classified: ClassifiedRow[],
  universe: { total: number; anonymized: number; deleted: number },
  unparseableBirthDateCount: number,
  unmappedMaritalCount: number,
): void {
  const byBucket = new Map<Bucket, ClassifiedRow[]>()
  for (const b of ALL_BUCKETS) byBucket.set(b, [])
  for (const c of classified) byBucket.get(c.bucket)!.push(c)

  console.log('\n================ S7-T3.2 ROSTER RE-MIGRATION -- DRY RUN (PII-SAFE) ================\n')

  console.log('-- Bucket counts --')
  for (const b of ALL_BUCKETS) console.log(`  ${b}: ${byBucket.get(b)!.length}`)

  const sum = ALL_BUCKETS.reduce((acc, b) => acc + byBucket.get(b)!.length, 0)
  console.log(`\n-- Reconciliation --`)
  console.log(`  sum of all buckets: ${sum}`)
  console.log(`  totalRows parsed:   ${totalRows}`)
  if (sum !== totalRows) {
    console.error(`  RECONCILIATION FAILED: bucket sum (${sum}) !== totalRows (${totalRows})`)
    process.exit(1)
  }
  console.log(`  OK -- every row landed in exactly one bucket`)

  const blankCount = allRows.filter((r) => r.isBlank).length
  const answeredCount = totalRows - blankCount
  console.log(`\n-- Answered/blank split (diagnostic, orthogonal to bucket membership) --`)
  console.log(`  answered: ${answeredCount}, blank: ${blankCount}`)
  if (blankCount < 95 || blankCount > 105) {
    console.error(`  FLAG: skipped-blank (${blankCount}) drifts from the expected ~100`)
  } else {
    console.log(`  OK -- within expected ~100 blank range`)
  }

  console.log(`\n-- matched-fill (person id + filled columns) --`)
  for (const c of byBucket.get('matched-fill')!) {
    const also = c.alsoConsentTransition ? ` also-consent:${c.alsoConsentTransition}` : ''
    console.log(`  ${c.personId}: [${c.filledFields!.join(', ')}]${also}`)
  }

  console.log(`\n-- matched-consent-move (person id + transition) --`)
  for (const c of byBucket.get('matched-consent-move')!) {
    console.log(`  ${c.personId}: ${c.consentTransition}`)
  }

  console.log(`\n-- would-conflict (person id + conflicting columns) --`)
  for (const c of byBucket.get('would-conflict')!) {
    const diff = c.conflictFields!.includes('birth_date') && c.birthDateDayDiff !== null && c.birthDateDayDiff !== undefined ? ` (birth_date day-diff: ${c.birthDateDayDiff >= 0 ? '+' : ''}${c.birthDateDayDiff})` : ''
    console.log(`  ${c.personId}: [${c.conflictFields!.join(', ')}]${diff}`)
  }

  const birthDateConflicts = byBucket.get('would-conflict')!.filter((c) => c.conflictFields!.includes('birth_date'))
  const plusOneDay = birthDateConflicts.filter((c) => c.birthDateDayDiff === 1).length
  const otherDiff = birthDateConflicts.length - plusOneDay
  if (birthDateConflicts.length > 0) {
    console.log(`\n-- SUSPECTED SYSTEMATIC DATE-SERIAL DISCREPANCY (flagged, not auto-corrected) --`)
    console.log(`  birth_date conflicts: ${birthDateConflicts.length} total`)
    console.log(`  exactly +1 day (form ahead of existing): ${plusOneDay}`)
    console.log(`  other day-diff (more likely genuine): ${otherDiff}`)
    if (plusOneDay >= birthDateConflicts.length * 0.8) {
      console.error(
        `  FLAG: ${plusOneDay}/${birthDateConflicts.length} birth_date conflicts are a UNIFORM +1 day. This does not look like ` +
          `per-person data disagreement -- it looks like a systematic date-serial encoding discrepancy between this xlsx file ` +
          `and whatever produced the existing DB values (both this script's raw-serial and cellDates decode paths agree with ` +
          `each other and still show it). NOT auto-corrected here. Needs a human decision on which side is right before any ` +
          `apply -- an unverified -1/+1 day correction could silently corrupt real birth dates.`,
      )
    }
  }

  console.log(`\n-- new-insert (sheet row + present columns + consent decision) --`)
  for (const c of byBucket.get('new-insert')!) {
    console.log(`  row ${c.sourceRowNumber}: [${c.presentColumns!.join(', ')}] consent=${c.consentDecision}`)
  }

  console.log(`\n-- Edge rows (country / valid / e164_length only) --`)
  const row82 = allRows.find((r) => r.sourceRowNumber === 82)
  const row100 = allRows.find((r) => r.sourceRowNumber === 100)
  console.log(`  row 82:  ${JSON.stringify(edgeRowSummary(row82))}`)
  console.log(`  row 100: ${JSON.stringify(edgeRowSummary(row100))}`)

  console.log(`\n-- Other diagnostics --`)
  console.log(`  unparseable birth_date cells: ${unparseableBirthDateCount}`)
  console.log(`  unmapped marital_status values (-> NULL, same as blank): ${unmappedMaritalCount}`)

  console.log(`\n-- Universe counts (target, read fresh) --`)
  console.log(`  total: ${universe.total}, anonymized_at NOT NULL: ${universe.anonymized}, deleted_at NOT NULL: ${universe.deleted}`)

  console.log('\n================================= END REPORT =================================\n')
}

// ---------------------------------------------------------------------------
// Apply (built, type-checked -- NOT invoked by S7-T3.2)
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var: ${name}`)
  return v
}

function resolveAdminEmailArg(args: string[]): string {
  const idx = args.indexOf('--admin-email')
  if (idx >= 0 && args[idx + 1]) return args[idx + 1]
  const envVal = process.env.IMPORT_ADMIN_EMAIL
  if (envVal) return envVal
  throw new Error('Missing admin email for apply mode: pass --admin-email <email> or set IMPORT_ADMIN_EMAIL in env.')
}

async function resolveAdminActor(supabase: SupabaseClient, adminEmail: string): Promise<string> {
  const { data, error } = await supabase.from('app_users').select('id, role, active').eq('email', adminEmail).maybeSingle()
  if (error) throw new Error(`Admin actor lookup failed: ${error.message}`)
  if (!data) throw new Error(`No app_users row for ${adminEmail}`)
  if (data.role !== 'admin' || !data.active) throw new Error(`${adminEmail} is not an active admin (role=${data.role}, active=${data.active})`)
  return data.id as string
}

async function runApply(supabase: SupabaseClient, classified: ClassifiedRow[], args: string[]): Promise<void> {
  const armed = args.includes('--confirm-apply')
  const adminEmail = resolveAdminEmailArg(args)
  const adminId = await resolveAdminActor(supabase, adminEmail)

  const inserts = classified.filter((c) => c.bucket === 'new-insert')
  const fills = classified.filter((c) => c.bucket === 'matched-fill')
  const consentMoves = classified.filter((c) => c.bucket === 'matched-consent-move')

  console.log(`[apply] would insert ${inserts.length}, update (fill) ${fills.length}, update (consent-move) ${consentMoves.length}`)

  if (!armed) {
    console.log('[apply] DRY (not armed) -- pass --confirm-apply to actually write. No DB writes made.')
    return
  }

  const importId = crypto.randomUUID()

  if (inserts.length > 0) {
    const payload = inserts.map((c) => c.insertPayload!)
    const { data, error } = await supabase.from('people').upsert(payload, { onConflict: 'phone_e164', ignoreDuplicates: true }).select('id')
    if (error) throw error
    await logAudit(
      { actorUserId: adminId, action: AUDIT_ACTIONS.IMPORT_COMMIT, entityType: 'import', entityId: importId, detailsJson: { kind: 's7-t3-roster-remigrate-insert', count: data?.length ?? 0 } },
      supabase,
    )
  }

  for (const c of [...fills, ...consentMoves]) {
    const { error } = await supabase.from('people').update(c.updatePayload!).eq('id', c.personId!)
    if (error) throw error
    await logAudit(
      {
        actorUserId: adminId,
        action: c.bucket === 'matched-fill' ? AUDIT_ACTIONS.PEOPLE_UPDATE : AUDIT_ACTIONS.CONSENT_GRANT,
        entityType: 'people',
        entityId: c.personId!,
        detailsJson: { kind: 's7-t3-roster-remigrate', bucket: c.bucket, fields: c.filledFields ?? null, consentTransition: c.consentTransition ?? c.alsoConsentTransition ?? null, importId },
      },
      supabase,
    )
  }

  console.log(`[apply] DONE -- importId=${importId}`)
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  assertPhoneUtilTrustworthy()

  const args = process.argv.slice(2)
  const modeArg = args.find((a) => a.startsWith('--mode='))
  const mode = modeArg ? modeArg.slice('--mode='.length) : 'dry-run'
  if (mode !== 'dry-run' && mode !== 'apply') {
    console.error(`FATAL: unknown --mode=${mode}, expected dry-run or apply`)
    process.exit(1)
  }

  await runPreflightGuard('roster-apply')

  if (!existsSync(FILE_PATH)) {
    console.error(`FATAL: roster file not found: ${FILE_PATH}`)
    process.exit(1)
  }
  const buffer = readFileSync(FILE_PATH)
  const { rows, totalRows } = parseWorkbook(buffer)

  const { survivors, superseded } = dedupByPhone(rows)

  const url = requireEnv('NEXT_PUBLIC_SUPABASE_URL')
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY')
  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })

  const survivorPhones = survivors.filter((r) => r.phoneResult.ok).map((r) => (r.phoneResult as { ok: true; e164: string }).e164)
  const existingByPhone = await lookupExisting(supabase, survivorPhones)

  const classified: ClassifiedRow[] = [
    ...superseded.map((r): ClassifiedRow => ({ bucket: 'duplicate-superseded', sourceRowNumber: r.sourceRowNumber })),
    ...survivors.map((r) => classifyRow(r, existingByPhone)),
  ]
  classified.sort((a, b) => a.sourceRowNumber - b.sourceRowNumber)

  const unparseableBirthDateCount = rows.filter((r) => r.birthDateUnparseable).length
  const unmappedMaritalCount = rows.filter((r) => r.maritalUnmapped).length
  const universe = await universeCounts(supabase)

  printDryRunReport(rows, totalRows, classified, universe, unparseableBirthDateCount, unmappedMaritalCount)

  if (mode === 'apply') {
    await runApply(supabase, classified, args)
  } else {
    console.log('[mode] dry-run complete -- no DB writes made.')
  }
}

main().catch((err) => {
  console.error('FATAL:', err instanceof Error ? err.stack ?? err.message : err)
  process.exit(1)
})
