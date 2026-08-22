/**
 * S7-T3 — Roster re-migration (DATA UMAT (19Aug2026).xlsx -> public.people).
 *
 * Two modes:
 *   --mode=dry-run   (default) — read-only. Classifies every row, prints a
 *                     PII-safe report (surrogate keys / column names / bucket
 *                     counts only — never a name/phone/email/birth value).
 *   --mode=apply     — writes. Finalized in S7-T3.3 (payload guard, split
 *                     audit actions, mandatory post-write re-verify — see
 *                     the "Apply" section below). Rehearsed once against a
 *                     local scratch restore in S7-T3.3, including a second
 *                     back-to-back run proving idempotency. STILL NEVER RUN
 *                     AGAINST PROD as of this revision — the preflight guard
 *                     enforces branch/ref agreement for any non-local target,
 *                     but that is a backstop, not an invitation to point this
 *                     at prod without a separate, explicit decision to do so.
 *                     --any-active-admin resolves any active admin from
 *                     app_users as the audit actor without ever fetching or
 *                     printing an email — intended for a scratch restore
 *                     where no admin email is known in advance; prefer
 *                     --admin-email / IMPORT_ADMIN_EMAIL for a real apply.
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
 * WRITE vs. BUCKET (S7-T3.2 revision, FIX 2) — the write is computed once,
 * per-column, independent of which bucket a matched-active row is labeled
 * with: fillFields (existing null -> form value, per column) and the consent
 * tuple (when eligible) are ALWAYS combined into that row's updatePayload,
 * even when the row also has a conflicting column. A conflict on one column
 * must never suppress a fill or consent write on another. The bucket is a
 * COUNT LABEL ONLY, chosen by priority (would-conflict > matched-fill >
 * matched-consent-move > matched-no-op) purely so the 11-bucket
 * reconciliation stays a one-bucket-per-row partition summing to 227 — it
 * does not gate what gets written. Every matched-active row's report line
 * carries conflicts=[...] will-fill=[...] will-consent=X regardless of its
 * bucket, so a would-conflict row's real write is always visible.
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

function stripPhoneSeparators(str: string): string {
  return str.replace(/[\s\-().]+/g, '')
}

/** S7-T3.2 revision, FIX 1 -- replaces the old "prepend 0 unless starts with
 *  0/+" rule, which mangled a numeric cell that already carried the 62
 *  country code (row 100: e.g. raw number 6281234567890 -> old code produced
 *  '062...' garbage since it only special-cased '0'/'+', never '62'). Ladder,
 *  checked after stripping separators: '+' -> parse as-is; '62' (no '+') ->
 *  prepend '+'; '0' -> parse as-is (ID national format); '8' (dropped leading
 *  zero) -> prepend '0'; anything else -> prepend '0' as a last resort.
 *  libphonenumber-js still validates every branch, so genuine garbage still
 *  fails safe into phone-normalize-failed -- this only widens which raw
 *  shapes get a fair shot at validating. */
function normalizeRosterPhone(raw: unknown): ReturnType<typeof normalizePhone> {
  const initial = raw === null || raw === undefined ? '' : typeof raw === 'number' ? String(raw) : String(raw).trim()
  const str = stripPhoneSeparators(initial.trim())
  if (!str) return { ok: false, reason: 'empty' }
  if (str.startsWith('+')) return normalizePhone(str, 'ID')
  if (str.startsWith('62')) return normalizePhone('+' + str, 'ID')
  if (str.startsWith('0')) return normalizePhone(str, 'ID')
  if (str.startsWith('8')) return normalizePhone('0' + str, 'ID')
  return normalizePhone('0' + str, 'ID')
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

/** S7-T3.3 FIX 4 -- pre/post-write snapshot shape for the mandatory
 *  re-verify. Deliberately narrower than ExistingPersonRow (no phone_e164 --
 *  the re-verify never needs to print or match on it, only compare by id). */
interface PreImageRow {
  id: string
  photo_consent_state: 'granted' | 'refused' | 'unknown'
  photo_publish_consent: boolean
  birth_date: string | null
  birth_place: string | null
  marital_status: MaritalStatus | null
  photo_url: string | null
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

/** Whole-day difference between two 'YYYY-MM-DD' strings (file minus
 *  existing), or null if either fails to parse. Never printed as a date --
 *  only ever surfaced as a signed integer delta. */
function dayDiff(existingIso: string, fileIso: string): number | null {
  const a = Date.parse(existingIso + 'T00:00:00Z')
  const b = Date.parse(fileIso + 'T00:00:00Z')
  if (Number.isNaN(a) || Number.isNaN(b)) return null
  return Math.round((b - a) / 86400000)
}

/** birth_place / marital_status / photo_url ONLY -- generic fill-only-if-
 *  empty, non-null differing => conflict, unchanged from S7-T3.2. birth_date
 *  is deliberately excluded here and handled by decideBirthDate below. */
const GENERIC_FILLABLE_FIELDS = ['birth_place', 'marital_status', 'photo_url'] as const satisfies readonly FillableField[]
type GenericFillableField = (typeof GENERIC_FILLABLE_FIELDS)[number]

function computeFillAndConflict(
  existing: ExistingPersonRow,
  form: FormFillValues,
): { fillFields: GenericFillableField[]; conflictFields: GenericFillableField[] } {
  const fillFields: GenericFillableField[] = []
  const conflictFields: GenericFillableField[] = []
  const pairs: [GenericFillableField, string | null, string | null][] = [
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
    if (existingVal !== formVal) conflictFields.push(field)
  }
  return { fillFields, conflictFields }
}

type BirthDateAction = 'fill' | 'nochange' | 'correct' | 'quarantine' | 'file-null'

/** S7-T3.2 rev2 -- birth_date-only model change, replacing plain
 *  fill-only-if-empty for this one column. Rationale: the S7-T3 spot-check
 *  (4/4 known real birthdays, by name, matched this xlsx file's decoded
 *  Tanggal Lahir exactly) confirmed the FILE is ground truth; the near-
 *  uniform +1-day pattern found across ~102 matched rows is existing prod
 *  data sitting one day behind reality -- a pipeline artifact from the
 *  ORIGINAL S6 import of a different source file, not a defect in this file
 *  or this script's decode. So the known +1 offset is corrected outright,
 *  while every OTHER non-zero delta (the +9863/+88/+32/+10/-12 outliers) is
 *  quarantined -- held for a human, never auto-written -- because those do
 *  NOT match the known artifact's signature and could be genuine per-person
 *  disagreements or a distinct data-entry error (e.g. +9863 looks like a
 *  wrong-decade typo, not a pipeline bug). */
function decideBirthDate(existing: string | null, file: string | null): { action: BirthDateAction; delta: number | null } {
  if (file === null || file === '') return { action: 'file-null', delta: null }
  if (existing === null) return { action: 'fill', delta: null }
  if (existing === file) return { action: 'nochange', delta: 0 }
  const delta = dayDiff(existing, file)
  if (delta === 1) return { action: 'correct', delta }
  return { action: 'quarantine', delta }
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
  // Matched-active rows carry ALL of these regardless of which bucket the
  // priority rule below picked for the count/label -- S7-T3.2 revision FIX 2:
  // conflicts no longer suppress fills/consent on OTHER columns.
  filledFields?: FillableField[]
  // rev2: conflictFields is now birth_place/marital_status/photo_url ONLY --
  // birth_date has its own action model (birthDateAction) below.
  conflictFields?: GenericFillableField[]
  willConsent?: string | null
  birthDateAction?: BirthDateAction
  birthDateDelta?: number | null
  birthDateFileValue?: string | null
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

    // FIX 2: the write is computed ONCE, per-column, independent of which
    // bucket the row is labeled with below. A conflict on one field must
    // never suppress a fill on another field, or an eligible consent write
    // (consent is orthogonal to the demographic fill entirely).
    const form: FormFillValues = {
      birth_date: row.birth_date,
      birth_place: row.birth_place,
      marital_status: row.marital_status,
      photo_url: row.photo_url,
    }
    const { fillFields, conflictFields } = computeFillAndConflict(existing, form)
    const { action: birthDateAction, delta: birthDateDelta } = decideBirthDate(existing.birth_date, form.birth_date)
    const consentEligible = computeConsentEligibility(existing)
    const willConsent = consentEligible ? `unknown->${row.consentState}` : null

    const birthDateWrites = birthDateAction === 'fill' || birthDateAction === 'correct'

    const updatePayload: Record<string, unknown> = {}
    for (const f of fillFields) updatePayload[f] = form[f]
    if (birthDateWrites) updatePayload.birth_date = form.birth_date
    if (consentEligible) {
      updatePayload.photo_consent_state = row.consentState
      updatePayload.photo_publish_consent = row.consentState === 'granted'
    }
    const hasWrite = fillFields.length > 0 || birthDateWrites || consentEligible
    if (hasWrite) updatePayload.updated_at = new Date().toISOString()

    // Bucket is a COUNT LABEL ONLY (priority would-conflict > matched-fill >
    // matched-consent-move > matched-no-op) so the 11-bucket reconciliation
    // stays a one-bucket-per-row partition summing to 227. It does NOT gate
    // what gets written -- updatePayload above already reflects the real
    // per-column write regardless of this label. rev2: a quarantined
    // birth_date is a blocker for bucket purposes exactly like a
    // birth_place/marital_status/photo_url conflict was before.
    const hasBlocker = conflictFields.length > 0 || birthDateAction === 'quarantine'
    const bucket: Bucket = hasBlocker ? 'would-conflict' : fillFields.length > 0 || birthDateWrites ? 'matched-fill' : consentEligible ? 'matched-consent-move' : 'matched-no-op'

    const reportFillFields: FillableField[] = birthDateWrites ? ['birth_date', ...fillFields] : [...fillFields]

    return {
      ...base,
      bucket,
      personId: existing.id,
      filledFields: reportFillFields,
      conflictFields,
      willConsent,
      birthDateAction,
      birthDateDelta,
      birthDateFileValue: form.birth_date,
      updatePayload: hasWrite ? updatePayload : undefined,
    }
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

function edgeRowSummary(row: ParsedRow | undefined): Record<string, unknown> {
  if (!row) return { country: null, valid: false, e164_length: null }
  if (!row.phoneResult.ok) {
    // Still fails after FIX 1's ladder -- report ONLY cell shape (char length
    // + first 2 digits of the stripped raw cell), never the full digits.
    const stripped = stripPhoneSeparators(cellToTrimmedString(row.phoneRaw))
    return { country: null, valid: false, e164_length: null, cell_char_length: stripped.length, cell_first_2_chars: stripped.slice(0, 2) }
  }
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

  // S7-T3.2 revision FIX 2: every matched-active row (all 4 buckets below)
  // is annotated with everything that applies -- conflicts=[...],
  // will-fill=[...], will-consent=X -- so the actual write (updatePayload)
  // is visible regardless of which bucket the row's priority label landed
  // in. A would-conflict row's will-fill/will-consent make its real write
  // visible even though the row is conflict-labeled.
  function annotate(c: ClassifiedRow): string {
    const bdDelta = c.birthDateAction === 'quarantine' && c.birthDateDelta !== null && c.birthDateDelta !== undefined ? `(${c.birthDateDelta >= 0 ? '+' : ''}${c.birthDateDelta})` : ''
    const bd = c.birthDateAction ? ` birth_date=${c.birthDateAction}${bdDelta}` : ''
    return `conflicts=[${(c.conflictFields ?? []).join(', ')}] will-fill=[${(c.filledFields ?? []).join(', ')}] will-consent=${c.willConsent ?? 'none'}${bd}`
  }

  console.log(`\n-- matched-fill (person id + annotation) --`)
  for (const c of byBucket.get('matched-fill')!) console.log(`  ${c.personId}: ${annotate(c)}`)

  console.log(`\n-- matched-consent-move (person id + annotation) --`)
  for (const c of byBucket.get('matched-consent-move')!) console.log(`  ${c.personId}: ${annotate(c)}`)

  console.log(`\n-- matched-no-op (person id + annotation) --`)
  for (const c of byBucket.get('matched-no-op')!) console.log(`  ${c.personId}: ${annotate(c)}`)

  console.log(`\n-- would-conflict (person id + annotation -- will-fill/will-consent show the REAL write) --`)
  for (const c of byBucket.get('would-conflict')!) console.log(`  ${c.personId}: ${annotate(c)}`)

  const allMatchedActive = [...byBucket.get('matched-fill')!, ...byBucket.get('matched-consent-move')!, ...byBucket.get('matched-no-op')!, ...byBucket.get('would-conflict')!]
  const consentWriteGranted = allMatchedActive.filter((c) => c.willConsent?.endsWith('granted')).length
  const consentWriteRefused = allMatchedActive.filter((c) => c.willConsent?.endsWith('refused')).length
  console.log(`\n-- Consent-write summary (across all matched buckets) --`)
  console.log(`  ->granted: ${consentWriteGranted}, ->refused: ${consentWriteRefused}, total: ${consentWriteGranted + consentWriteRefused}`)

  // rev2: birth_date summary + quarantine list, replacing the old "flag it,
  // don't touch it" discrepancy section now that the model actually resolves
  // the +1 case (correct) and isolates the rest (quarantine).
  const fillCount = allMatchedActive.filter((c) => c.birthDateAction === 'fill').length
  const correctCount = allMatchedActive.filter((c) => c.birthDateAction === 'correct').length
  const quarantineCount = allMatchedActive.filter((c) => c.birthDateAction === 'quarantine').length
  const nochangeCount = allMatchedActive.filter((c) => c.birthDateAction === 'nochange').length
  const fileNullCount = allMatchedActive.filter((c) => c.birthDateAction === 'file-null').length
  const bdActionSum = fillCount + correctCount + quarantineCount + nochangeCount + fileNullCount
  console.log(`\n-- birth_date summary (rev2: file-wins with quarantine) --`)
  console.log(`  fill=${fillCount} correct=${correctCount} quarantine=${quarantineCount} nochange=${nochangeCount} file-null=${fileNullCount}`)
  console.log(`  sum: ${bdActionSum} (matched-row count: ${allMatchedActive.length})`)
  if (bdActionSum !== allMatchedActive.length) {
    console.error(`  RECONCILIATION FAILED: birth_date action sum (${bdActionSum}) != matched-row count (${allMatchedActive.length})`)
    process.exit(1)
  }
  console.log(`  OK -- every matched row has exactly one birth_date action`)

  console.log(`\n-- QUARANTINE (birth_date anomalies, NOT written -- for human review) --`)
  const quarantined = allMatchedActive
    .filter((c) => c.birthDateAction === 'quarantine')
    .sort((a, b) => Math.abs(b.birthDateDelta ?? 0) - Math.abs(a.birthDateDelta ?? 0))
  for (const c of quarantined) {
    const d = c.birthDateDelta ?? 0
    console.log(`  ${c.personId}: delta=${d >= 0 ? '+' : ''}${d}`)
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
// Apply -- finalized in S7-T3.3. All four APPLY-PATH FIXES live here:
//   FIX 1: assertPayloadGuard -- hard-aborts before any write if any row's
//          updatePayload would touch one of its own conflictFields.
//   FIX 2: (see below) writes are idempotent BY CONSTRUCTION, not by any
//          special-cased retry/dedup logic -- relied on, not just asserted.
//   FIX 3: audit action direction (CONSENT_GRANT / CONSENT_REVOKE /
//          PEOPLE_UPDATE), split into two entries when a row does both.
//   FIX 4: snapshotActiveUniverse + reVerifyAndAssert -- mandatory, runs
//          every armed apply, hard-aborts on any violated invariant.
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

/** --any-active-admin (S7-T3.3 rehearsal-only escape hatch, not requested
 *  literally but required to satisfy "audit actor = any active admin ...
 *  resolve its id, do NOT print the email" -- resolveAdminActor above needs
 *  a known email upfront, which doesn't fit a scratch restore where no email
 *  is known in advance). Selects id/role/active only -- email is never
 *  fetched, so it structurally cannot be printed. --admin-email/
 *  IMPORT_ADMIN_EMAIL remains the default, deliberate path for a real apply
 *  where the actor should be named explicitly. */
async function resolveAnyActiveAdmin(supabase: SupabaseClient): Promise<string> {
  const { data, error } = await supabase.from('app_users').select('id, role, active').eq('role', 'admin').eq('active', true).limit(1).maybeSingle()
  if (error) throw new Error(`Any-active-admin lookup failed: ${error.message}`)
  if (!data) throw new Error('No active admin found in app_users.')
  return data.id as string
}

/** FIX 1, revised in S7-T3.2 rev2 -- pre-write payload guard, now runs in
 *  BOTH modes (called from main(), not just inside runApply()) since the
 *  invariant is about the classification plan itself, not specifically the
 *  act of writing. Two separate assertions:
 *   1. No-clobber, scoped to birth_place/marital_status/photo_url ONLY
 *      (unchanged shape from S7-T3.3, narrower field set): none of a row's
 *      conflictFields may appear as an updatePayload key.
 *   2. birth_date, which now has its own model: if 'birth_date' is present
 *      in updatePayload, that row's birthDateAction MUST be 'fill' or
 *      'correct' (never 'quarantine'/'nochange'/'file-null'), and the
 *      payload value MUST equal that row's file value exactly -- guards
 *      against a future edit accidentally writing the EXISTING value back,
 *      or writing during a quarantine.
 *  Pure, no DB access -- hard-aborts the WHOLE run on any violation before
 *  anything else happens (dry-run report, or apply's insert/update/audit). */
function assertPayloadGuard(classified: ClassifiedRow[]): void {
  const violations: string[] = []
  let checked = 0
  for (const c of classified) {
    if (!c.updatePayload) continue
    checked++

    for (const key of Object.keys(c.updatePayload)) {
      if (key === 'birth_date') continue // checked separately below
      if ((c.conflictFields ?? []).includes(key as GenericFillableField)) {
        violations.push(`personId=${c.personId} key="${key}" (no-clobber violation)`)
      }
    }

    if ('birth_date' in c.updatePayload) {
      if (c.birthDateAction !== 'fill' && c.birthDateAction !== 'correct') {
        violations.push(`personId=${c.personId} birth_date present but action="${c.birthDateAction}" (expected fill|correct)`)
      }
      if (c.updatePayload.birth_date !== c.birthDateFileValue) {
        violations.push(`personId=${c.personId} birth_date payload value does not equal the file value`)
      }
    }
  }
  if (violations.length > 0) {
    console.error('PAYLOAD GUARD FAILED:')
    for (const v of violations) console.error(`  ${v}`)
    process.exit(1)
  }
  console.log(`[payload-guard] OK -- ${checked} update payload(s) checked, 0 violations`)
}

/** FIX 2 -- writes are idempotent BY CONSTRUCTION, relied on rather than
 *  special-cased: fill writes are null->value only (a field already filled,
 *  by this run or a prior partial one, never gets re-touched, since
 *  computeFillAndConflict only ever proposes a fill when existing is null);
 *  consent writes fire only when existing state='unknown' AND publish=false
 *  (once moved, re-running finds it no longer eligible); inserts upsert
 *  onConflict phone_e164 with ignoreDuplicates:true (a phone already present
 *  is silently skipped, never re-inserted or overwritten). A partial failure
 *  midway through a real apply is therefore always safe to re-run to
 *  completion -- re-running re-classifies against fresh DB state, and
 *  anything already written simply reclassifies to matched-no-op / a no-op
 *  insert-skip and is left alone. Proven empirically by the S7-T3.3 rehearsal
 *  (identical run twice: 0 inserts / 0 updates the second time). */

/** FIX 4 -- snapshot the full active universe (deleted_at/anonymized_at both
 *  null) BEFORE any write, for the mandatory post-write re-verify. Active-
 *  only matches the same universe definition used throughout S7-T3's recon. */
async function snapshotActiveUniverse(supabase: SupabaseClient): Promise<Map<string, PreImageRow>> {
  const { data, error } = await supabase
    .from('people')
    .select('id, photo_consent_state, photo_publish_consent, birth_date, birth_place, marital_status, photo_url')
    .is('deleted_at', null)
    .is('anonymized_at', null)
  if (error) throw error
  return new Map((data as PreImageRow[]).map((p) => [p.id, p]))
}

/** FIX 4 -- MANDATORY post-write re-verify. Independent re-query (not a
 *  reuse of any in-memory write result) against the same active universe.
 *  PII-SAFE: prints counts, booleans, and surrogate ids ONLY -- never a
 *  birth_date/birth_place/marital_status/photo_url VALUE, pre or post. Any
 *  failed assertion prints FAIL and hard-exits non-zero. */
async function reVerifyAndAssert(
  supabase: SupabaseClient,
  preImage: Map<string, PreImageRow>,
  classified: ClassifiedRow[],
  insertedCount: number,
): Promise<void> {
  console.log('\n-- POST-WRITE RE-VERIFY (independent re-query, PII-safe: counts/ids only) --')

  const { data: postData, error } = await supabase
    .from('people')
    .select('id, photo_consent_state, photo_publish_consent, birth_date, birth_place, marital_status, photo_url')
    .is('deleted_at', null)
    .is('anonymized_at', null)
  if (error) throw error
  const post = postData as PreImageRow[]
  const postById = new Map(post.map((p) => [p.id, p]))

  let failures = 0

  const total = post.length
  const granted = post.filter((p) => p.photo_consent_state === 'granted').length
  const refused = post.filter((p) => p.photo_consent_state === 'refused').length
  const unknown = post.filter((p) => p.photo_consent_state === 'unknown').length
  console.log(`  people total: ${total}`)
  console.log(`  consent: granted=${granted} refused=${refused} unknown=${unknown} (sum=${granted + refused + unknown})`)
  if (granted + refused + unknown !== total) {
    console.error('  FAIL: consent group sum != total')
    failures++
  }

  const coherenceViolations = post.filter((p) => p.photo_publish_consent !== (p.photo_consent_state === 'granted')).length
  const publishTrueCount = post.filter((p) => p.photo_publish_consent === true).length
  console.log(`  coherence violations (publish != (state==='granted')): ${coherenceViolations}`)
  console.log(`  publish=true count: ${publishTrueCount} (expect == granted count)`)
  if (coherenceViolations !== 0) {
    console.error('  FAIL: coherence violations != 0')
    failures++
  }
  if (publishTrueCount !== granted) {
    console.error('  FAIL: publish=true count != granted count')
    failures++
  }

  // NEVER-FLIP: every id already granted or already refused pre-write must
  // be byte-identical on (state, publish) post-write.
  const preGranted = [...preImage.values()].filter((p) => p.photo_consent_state === 'granted' && p.photo_publish_consent === true)
  const preRefused = [...preImage.values()].filter((p) => p.photo_consent_state === 'refused' && p.photo_publish_consent === false)
  let neverFlipViolations = 0
  for (const pre of preGranted) {
    const now = postById.get(pre.id)
    if (!now || now.photo_consent_state !== 'granted' || now.photo_publish_consent !== true) neverFlipViolations++
  }
  for (const pre of preRefused) {
    const now = postById.get(pre.id)
    if (!now || now.photo_consent_state !== 'refused' || now.photo_publish_consent !== false) neverFlipViolations++
  }
  console.log(`  NEVER-FLIP: pre-granted=${preGranted.length} pre-refused=${preRefused.length} -- violations: ${neverFlipViolations}`)
  if (neverFlipViolations !== 0) {
    console.error('  FAIL: NEVER-FLIP violated')
    failures++
  }

  // NO NON-NULL CLOBBER: rev2 scopes this to birth_place/marital_status/
  // photo_url ONLY -- birth_date now has its own model (a 'correct' action
  // is a DELIBERATE, expected overwrite of a non-null value, not a clobber).
  let clobberViolations = 0
  for (const [id, pre] of preImage) {
    const now = postById.get(id)
    if (!now) continue
    for (const f of GENERIC_FILLABLE_FIELDS) {
      if (pre[f] !== null && now[f] !== pre[f]) clobberViolations++
    }
  }
  console.log(`  NO-CLOBBER (birth_place/marital_status/photo_url): violations: ${clobberViolations}`)
  if (clobberViolations !== 0) {
    console.error('  FAIL: a non-null value was clobbered')
    failures++
  }

  // birth_date, by action: fill/correct rows MUST now equal that row's file
  // value; quarantine/nochange/file-null rows MUST be byte-identical to
  // pre-image (untouched).
  let birthDateFillCount = 0
  let birthDateCorrectCount = 0
  let birthDateWrongWrite = 0
  let birthDateWronglyUnchanged = 0
  let birthDateQuarantineChanged = 0
  for (const c of classified) {
    if (!c.personId || !c.birthDateAction) continue
    const pre = preImage.get(c.personId)
    const now = postById.get(c.personId)
    if (!pre || !now) continue
    if (c.birthDateAction === 'fill') {
      birthDateFillCount++
      if (now.birth_date !== c.birthDateFileValue) birthDateWrongWrite++
    } else if (c.birthDateAction === 'correct') {
      birthDateCorrectCount++
      if (now.birth_date !== c.birthDateFileValue) birthDateWrongWrite++
    } else if (c.birthDateAction === 'quarantine') {
      if (now.birth_date !== pre.birth_date) birthDateQuarantineChanged++
    } else {
      // nochange / file-null -- also must be untouched
      if (now.birth_date !== pre.birth_date) birthDateWronglyUnchanged++
    }
  }
  console.log(`  birth_date fill=${birthDateFillCount} correct=${birthDateCorrectCount} -- wrong-write violations: ${birthDateWrongWrite}`)
  console.log(`  birth_date quarantine changed post-write: ${birthDateQuarantineChanged} (expect 0)`)
  console.log(`  birth_date nochange/file-null changed post-write: ${birthDateWronglyUnchanged} (expect 0)`)
  if (birthDateWrongWrite !== 0) {
    console.error('  FAIL: a fill|correct row did not end up with the file value')
    failures++
  }
  if (birthDateQuarantineChanged !== 0) {
    console.error('  FAIL: a quarantined birth_date was written')
    failures++
  }
  if (birthDateWronglyUnchanged !== 0) {
    console.error('  FAIL: a nochange/file-null birth_date changed unexpectedly')
    failures++
  }

  // Edge rows.
  const row82 = classified.find((c) => c.sourceRowNumber === 82)
  const row82Phone = row82?.insertPayload?.phone_e164 as string | undefined
  if (row82Phone) {
    const { data: row82Person, error: row82Err } = await supabase.from('people').select('id, phone_e164').eq('phone_e164', row82Phone).maybeSingle()
    if (row82Err) throw row82Err
    const ok = !!row82Person && (row82Person.phone_e164 as string).startsWith('+61')
    console.log(`  row 82 (new-insert) +61 intl phone preserved: ${ok}`)
    if (!ok) {
      console.error('  FAIL: row 82 phone not found post-write, or not +61 intl')
      failures++
    }
  } else {
    console.log('  row 82: not a new-insert this run (already migrated -- expected on a re-run)')
  }

  // rev2: row 100's expectation is now action-dependent -- fill/correct
  // means the file value SHOULD land, quarantine/nochange/file-null means it
  // must stay untouched. No longer a blanket "never written" (that was the
  // pre-rev2 assumption, only true when row 100 isn't a +1-day correction).
  const row100 = classified.find((c) => c.sourceRowNumber === 100)
  if (row100?.personId && row100.birthDateAction) {
    const pre = preImage.get(row100.personId)
    const now = postById.get(row100.personId)
    const shouldWrite = row100.birthDateAction === 'fill' || row100.birthDateAction === 'correct'
    const ok = !!pre && !!now && (shouldWrite ? now.birth_date === row100.birthDateFileValue : now.birth_date === pre.birth_date)
    console.log(`  row 100 (matched, birth_date action=${row100.birthDateAction}) outcome as expected: ${ok}`)
    if (!ok) {
      console.error('  FAIL: row 100 birth_date was modified')
      failures++
    }
  }

  console.log(`  inserted this run: ${insertedCount}`)

  if (failures > 0) {
    console.error(`\n  RE-VERIFY FAILED: ${failures} assertion(s) failed.`)
    process.exit(1)
  }
  console.log('\n  RE-VERIFY OK -- all assertions passed.')
}

async function runApply(supabase: SupabaseClient, classified: ClassifiedRow[], args: string[]): Promise<void> {
  const armed = args.includes('--confirm-apply')
  const adminId = args.includes('--any-active-admin') ? await resolveAnyActiveAdmin(supabase) : await resolveAdminActor(supabase, resolveAdminEmailArg(args))

  const inserts = classified.filter((c) => c.bucket === 'new-insert')
  // FIX 2: the write is decoupled from the bucket label -- ANY matched-active
  // row (including would-conflict ones) with a non-empty updatePayload gets
  // written. matched-no-op rows never have one (hasWrite was false).
  const updates = classified.filter((c) => c.updatePayload !== undefined)

  console.log(`[apply] would insert ${inserts.length}, update ${updates.length} (across matched-fill/matched-consent-move/would-conflict rows with a non-empty per-column write)`)

  if (!armed) {
    console.log('[apply] DRY (not armed) -- pass --confirm-apply to actually write. No DB writes made.')
    return
  }

  const preImage = await snapshotActiveUniverse(supabase) // FIX 4 -- BEFORE any write

  const importId = crypto.randomUUID()
  let insertedCount = 0

  if (inserts.length > 0) {
    const payload = inserts.map((c) => c.insertPayload!)
    const { data, error } = await supabase.from('people').upsert(payload, { onConflict: 'phone_e164', ignoreDuplicates: true }).select('id')
    if (error) throw error
    insertedCount = data?.length ?? 0
    await logAudit(
      { actorUserId: adminId, action: AUDIT_ACTIONS.IMPORT_COMMIT, entityType: 'import', entityId: importId, detailsJson: { kind: 's7-t3-roster-remigrate-insert', count: insertedCount } },
      supabase,
    )
  }

  // FIX 3 -- audit direction: fills -> PEOPLE_UPDATE, unknown->granted ->
  // CONSENT_GRANT, unknown->refused -> CONSENT_REVOKE (only existing
  // consent-direction constant available -- lib/audit.ts has no dedicated
  // "first-time refusal" action, only GRANT/REVOKE; REVOKE is a semantic
  // stretch here since this is never actually undoing a prior grant, only
  // ever moving out of 'unknown'. Flagged per instructions, not invented
  // around.) A row doing both a fill AND a consent move emits BOTH entries.
  for (const c of updates) {
    const { error } = await supabase.from('people').update(c.updatePayload!).eq('id', c.personId!)
    if (error) throw error

    if (c.filledFields && c.filledFields.length > 0) {
      await logAudit(
        {
          actorUserId: adminId,
          action: AUDIT_ACTIONS.PEOPLE_UPDATE,
          entityType: 'people',
          entityId: c.personId!,
          detailsJson: { kind: 's7-t3-roster-remigrate-fill', bucket: c.bucket, fields: c.filledFields, importId },
        },
        supabase,
      )
    }
    if (c.willConsent) {
      const isGrant = c.willConsent.endsWith('granted')
      await logAudit(
        {
          actorUserId: adminId,
          action: isGrant ? AUDIT_ACTIONS.CONSENT_GRANT : AUDIT_ACTIONS.CONSENT_REVOKE,
          entityType: 'people',
          entityId: c.personId!,
          detailsJson: { kind: 's7-t3-roster-remigrate-consent', bucket: c.bucket, consentTransition: c.willConsent, importId },
        },
        supabase,
      )
    }
  }

  console.log(`[apply] DONE -- importId=${importId}, inserted=${insertedCount}, updated=${updates.length}`)

  await reVerifyAndAssert(supabase, preImage, classified, insertedCount) // FIX 4 -- MANDATORY
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

  assertPayloadGuard(classified) // FIX 1, rev2 -- both modes; pure, no DB access, before the report or any write

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
