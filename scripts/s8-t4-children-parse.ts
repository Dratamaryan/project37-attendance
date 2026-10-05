/**
 * S8-T4 — Children free-text parse (DATA UMAT (19Aug2026).xlsx -> public.children).
 *
 * Reads the roster's "Nama & Tanggal Lahir Anak" column for every row whose
 * "Apakah memiliki Anak?" answer is 'ya', phone-matches the row to its parent
 * in public.people, parses the free text with scripts/lib/children-parse.ts
 * (pure, unit-tested with synthetic fixtures), and inserts structured
 * children rows.
 *
 * Two modes (mirrors scripts/s7-t3-roster-remigrate.ts):
 *   --mode=dry-run   (default) — read-only. Classifies every 'ya' row and
 *                     prints a PII-safe report: sheet row numbers, person ids
 *                     (uuids), bucket counts and structural shape tags only —
 *                     never a name, birth date, phone or raw cell text.
 *   --mode=apply     — writes, but only when ALSO passed --confirm-apply
 *                     (otherwise prints what it would do and exits). Audit
 *                     actor: --admin-email <email> / IMPORT_ADMIN_EMAIL, or
 *                     --any-active-admin for a scratch restore where no admin
 *                     email is known in advance (email never fetched/printed).
 *
 * RUNTIME — do NOT run this with `tsx` or `node --import tsx`. Parent
 * matching goes through normalizePhone (libphonenumber-js's `/min` subpath),
 * which fails SILENT under tsx/esbuild's ESM loader: every valid phone comes
 * back invalid, no thrown error, so every parent would land in
 * parent-not-found. assertPhoneUtilTrustworthy() hard-exits if the runtime
 * can't be trusted -- a backstop, not a substitute for the correct invocation:
 *
 *   npx tsc -p scripts/tsconfig.s8-t4.json
 *   node --env-file=.env.local scripts/.build/scripts/s8-t4-children-parse.js [--mode=dry-run]
 *   node --env-file=.env.local scripts/.build/scripts/s8-t4-children-parse.js --mode=apply --confirm-apply --admin-email <email>
 *
 * ASSUMES MIGRATIONS-BEFORE-RUN: public.children (S8-T1,
 * 20261005120000_sprint8_task1_children_child_attendance.sql) must already
 * exist on the target. A missing table fails the first children query loudly.
 *
 * GUARD + SERVICE ROLE: runPreflightGuard('children-parse') runs first,
 * in-process, before any Supabase client is constructed (branch<->ref
 * agreement for a remote target; local targets exempt per S7-T3.1). Writes use
 * the service-role key (RLS bypass) — this is an operator script, never
 * imported by app code. Required env (NEXT_PUBLIC_SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY) is read from process.env, not loaded here.
 *
 * IDEMPOTENCY — OPTION A (parent-level skip). public.children has no natural
 * unique key (no phone; names can parse differently across parser revisions),
 * so re-runnability is enforced per PARENT: any parent who already has >= 1
 * non-deleted child is skipped whole (bucket parent-already-has-children).
 * A partial apply is therefore safe to re-run: parents already written are
 * skipped, the rest are processed. Inserts are one statement per parent, so a
 * parent is never half-written. Residual: a crash between a parent's insert
 * and its audit writes leaves those children without CHILD_CREATE rows (a
 * re-run skips the parent); the post-write re-verify's audit count catches
 * this on any run that completes.
 *
 * REHEARSE ON A LOCAL RESTORE, NOT STAGING. Staging carries a synthetic seed
 * only — real roster phones match nothing there, so every row would land in
 * parent-not-found and prove nothing. Rehearse against a local scratch restore
 * of a fresh prod data-only dump (docs/backups/RUNBOOK.md), as S7-T3 did.
 *
 * PARENT CLASSIFICATION — never inserts under an unusable parent:
 *   phone empty/invalid or no people row -> parent-not-found
 *   people.anonymized_at set             -> parent-anonymized
 *   people.deleted_at set                -> parent-deleted
 * all three are skip + report only.
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import * as XLSX from 'xlsx'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import { normalizePhone } from '../lib/utils/phone'
import { AUDIT_ACTIONS, logAudit } from '../lib/audit'
import { parseChildrenCell, parkReasonOf, isValidIsoDate, type ChildrenParseResult } from './lib/children-parse'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FILE_PATH = path.resolve(process.cwd(), 'docs/migration/DATA UMAT (19Aug2026).xlsx')
const EXPECTED_SHEET_COUNT = 1
/** S8-T4 recon: 49 'ya' rows, every one with non-empty children text. */
const EXPECTED_YA_ROWS = 49

// Matched after trimming BOTH sides -- the real children header carries a
// trailing space.
const HEADER_ALIASES = {
  phone: 'Nomor HP',
  birth_place: 'Tempat Lahir',
  has_children: 'Apakah memiliki Anak?',
  children_text: 'Nama & Tanggal Lahir Anak',
} as const
type FieldKey = keyof typeof HEADER_ALIASES

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
        `This runtime cannot be trusted for phone matching (likely running under tsx -- see the RUNTIME warning ` +
        `at the top of this file). Refusing to process any row.`,
    )
    process.exit(1)
  }
  console.log('[phone-util-guard] OK -- ID and AU known-good phones normalized correctly under this runtime')
}

function stripPhoneSeparators(str: string): string {
  return str.replace(/[\s\-().]+/g, '')
}

/** Same coercion ladder as S7-T3's normalizeRosterPhone (same source file,
 *  same raw phone shapes): '+' -> as-is; '62' -> '+' prefix; '0' -> as-is;
 *  '8' -> '0' prefix; else '0' prefix. libphonenumber-js validates every
 *  branch, so garbage still fails safe. */
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
// (plain Node ESM). getBranch()/loadMap() duplicated from S7-T3 because
// guard.mjs only exports evaluate/matchBranchRef.
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
  // compiles this dynamic import() to require(), which accepts a bare
  // absolute path but not a file:// URL string.
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
    console.error('==================== PREFLIGHT ABORT (s8-t4-children-parse) ====================')
    console.error(`  branch:        ${branch || '(empty/detached)'}`)
    console.error(`  op:            ${op}`)
    console.error(`  resolved ref:  ${resolved.ref ?? '(none)'} (local=${resolved.local})`)
    console.error(`  reason:        ${result.reason}`)
    console.error('==================================================================================')
    console.error('')
    process.exit(1)
  }
  console.log(`[preflight] OK -- branch=${branch} op=${op} ref=${resolved.ref} local=${resolved.local}`)
}

// ---------------------------------------------------------------------------
// Workbook read
// ---------------------------------------------------------------------------

interface YaRow {
  sourceRowNumber: number // 0-indexed sheet row (header = row 0), same indexing as S7-T3 / S8-T4 recon
  phoneResult: ReturnType<typeof normalizePhone>
  parentBirthplace: string | null
  childrenText: string
}

function findColumnIndices(headerRow: unknown[]): Record<FieldKey, number> {
  const normalized = headerRow.map((c) => cellToTrimmedString(c))
  const result = {} as Record<FieldKey, number>
  const missing: string[] = []
  for (const [key, alias] of Object.entries(HEADER_ALIASES) as [FieldKey, string][]) {
    const idx = normalized.findIndex((cell) => cell === alias.trim())
    if (idx < 0) missing.push(alias)
    else result[key] = idx
  }
  if (missing.length > 0) {
    throw new Error(`COLUMN MAP FAILED: header(s) not found in row 0: ${missing.join(', ')}`)
  }
  return result
}

function readWorkbook(buffer: Buffer): { yaRows: YaRow[]; totalRows: number; textWithoutYa: number } {
  // cellDates: true -- matches S7-T3 / lib/import exactly. The children column
  // is free text (string cells), so this only matters for consistency.
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true })
  if (wb.SheetNames.length !== EXPECTED_SHEET_COUNT) {
    throw new Error(`SHEET GUARD FAILED: expected ${EXPECTED_SHEET_COUNT} sheet, got ${wb.SheetNames.length}`)
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
    const cell = ws[XLSX.utils.encode_cell({ r, c: colIdx[field] })]
    return cell ? cell.v : null
  }

  const yaRows: YaRow[] = []
  let totalRows = 0
  let textWithoutYa = 0
  for (let r = headerRowIdx + 1; r <= range.e.r; r++) {
    totalRows++
    const isYa = cellToTrimmedString(cellAt(r, 'has_children')).toLowerCase() === 'ya'
    const childrenText = cellToTrimmedString(cellAt(r, 'children_text'))
    if (!isYa) {
      if (childrenText) textWithoutYa++
      continue
    }
    const birthPlace = cellToTrimmedString(cellAt(r, 'birth_place'))
    yaRows.push({
      sourceRowNumber: r,
      phoneResult: normalizeRosterPhone(cellAt(r, 'phone')),
      parentBirthplace: birthPlace || null,
      childrenText,
    })
  }
  return { yaRows, totalRows, textWithoutYa }
}

/** Two 'ya' rows resolving to the same parent would defeat Option A within a
 *  single run (the second row's existing-children check can't see the first
 *  row's not-yet-written inserts). The recon found none; abort loudly if the
 *  file ever has one rather than guessing which row wins. */
function assertNoDuplicateParentPhones(rows: YaRow[]): void {
  const byPhone = new Map<string, number[]>()
  for (const row of rows) {
    if (!row.phoneResult.ok) continue
    const list = byPhone.get(row.phoneResult.e164) ?? []
    list.push(row.sourceRowNumber)
    byPhone.set(row.phoneResult.e164, list)
  }
  const dups = [...byPhone.values()].filter((list) => list.length > 1)
  if (dups.length > 0) {
    console.error('FATAL: duplicate parent phone across ya rows (rows grouped by shared phone):')
    for (const list of dups) console.error(`  rows ${list.join(', ')}`)
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Target lookups
// ---------------------------------------------------------------------------

interface ExistingParentRow {
  id: string
  phone_e164: string
  anonymized_at: string | null
  deleted_at: string | null
}

async function lookupParents(supabase: SupabaseClient, phones: string[]): Promise<Map<string, ExistingParentRow>> {
  const unique = [...new Set(phones)]
  const result = new Map<string, ExistingParentRow>()
  if (unique.length === 0) return result
  const { data, error } = await supabase
    .from('people')
    .select('id, phone_e164, anonymized_at, deleted_at')
    .in('phone_e164', unique)
  if (error) throw error
  for (const person of (data ?? []) as ExistingParentRow[]) result.set(person.phone_e164, person)
  return result
}

/** Option A -- the set of parent ids that already have >= 1 non-deleted child. */
async function lookupParentsWithChildren(supabase: SupabaseClient, parentIds: string[]): Promise<Set<string>> {
  const result = new Set<string>()
  if (parentIds.length === 0) return result
  const { data, error } = await supabase
    .from('children')
    .select('parent_person_id')
    .in('parent_person_id', parentIds)
    .is('deleted_at', null)
  if (error) throw error
  for (const row of (data ?? []) as { parent_person_id: string }[]) result.add(row.parent_person_id)
  return result
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

type Bucket =
  | 'parsed-full'
  | 'parsed-partial-notes'
  | 'unparseable-skipped'
  | 'parent-not-found'
  | 'parent-deleted'
  | 'parent-anonymized'
  | 'parent-already-has-children'

const ALL_BUCKETS: Bucket[] = [
  'parsed-full',
  'parsed-partial-notes',
  'unparseable-skipped',
  'parent-not-found',
  'parent-deleted',
  'parent-anonymized',
  'parent-already-has-children',
]

const WRITE_BUCKETS: ReadonlySet<Bucket> = new Set<Bucket>(['parsed-full', 'parsed-partial-notes'])

interface ChildInsert {
  parent_person_id: string
  full_name: string
  birth_date: string | null
  gender: null
  notes: string | null
}

const INSERT_KEYS = ['parent_person_id', 'full_name', 'birth_date', 'gender', 'notes'] as const

interface ClassifiedRow {
  sourceRowNumber: number
  bucket: Bucket
  personId?: string
  phoneIssue?: string
  parse: ChildrenParseResult
  inserts: ChildInsert[]
}

function isFullParse(parse: ChildrenParseResult): boolean {
  return (
    parse.parked === null &&
    parse.omittedEntries === 0 &&
    parse.children.length > 0 &&
    parse.children.every((c) => c.birth_date !== null && c.notes === null)
  )
}

function classifyRow(
  row: YaRow,
  parentsByPhone: Map<string, ExistingParentRow>,
  parentsWithChildren: Set<string>,
): ClassifiedRow {
  // Parsed for every row (pure) so the shape histogram covers all 49, but the
  // parse never decides a bucket ahead of the parent checks.
  const parse = parseChildrenCell(row.childrenText, row.parentBirthplace)
  const base = { sourceRowNumber: row.sourceRowNumber, parse, inserts: [] as ChildInsert[] }

  if (!row.phoneResult.ok) return { ...base, bucket: 'parent-not-found', phoneIssue: row.phoneResult.reason }
  const parent = parentsByPhone.get(row.phoneResult.e164)
  if (!parent) return { ...base, bucket: 'parent-not-found', phoneIssue: 'no-people-row' }
  if (parent.anonymized_at !== null) return { ...base, bucket: 'parent-anonymized', personId: parent.id }
  if (parent.deleted_at !== null) return { ...base, bucket: 'parent-deleted', personId: parent.id }
  if (parentsWithChildren.has(parent.id)) return { ...base, bucket: 'parent-already-has-children', personId: parent.id }

  if (parse.children.length === 0) return { ...base, bucket: 'unparseable-skipped', personId: parent.id }

  const inserts: ChildInsert[] = parse.children.map((c) => ({
    parent_person_id: parent.id,
    full_name: c.full_name,
    birth_date: c.birth_date,
    gender: null,
    notes: c.notes,
  }))
  return { ...base, bucket: isFullParse(parse) ? 'parsed-full' : 'parsed-partial-notes', personId: parent.id, inserts }
}

/** Pre-write payload guard -- runs in BOTH modes, pure, hard-aborts the whole
 *  run on any violation before the report or any write. Violations print row
 *  numbers and key names only, never values. */
function assertPayloadGuard(classified: ClassifiedRow[], activeEligibleParents: Set<string>): void {
  const violations: string[] = []
  let checked = 0
  for (const c of classified) {
    if (!WRITE_BUCKETS.has(c.bucket)) {
      if (c.inserts.length > 0) violations.push(`row ${c.sourceRowNumber}: inserts present in non-write bucket ${c.bucket}`)
      continue
    }
    if (c.inserts.length === 0) violations.push(`row ${c.sourceRowNumber}: write bucket with zero inserts`)
    for (const ins of c.inserts) {
      checked++
      const keys = Object.keys(ins).sort()
      if (keys.join(',') !== [...INSERT_KEYS].sort().join(',')) violations.push(`row ${c.sourceRowNumber}: unexpected payload keys`)
      if (ins.parent_person_id !== c.personId || !activeEligibleParents.has(ins.parent_person_id)) {
        violations.push(`row ${c.sourceRowNumber}: parent_person_id not an active, child-less matched parent`)
      }
      if (!/[a-zÀ-ɏ]/i.test(ins.full_name) || ins.full_name !== ins.full_name.trim()) {
        violations.push(`row ${c.sourceRowNumber}: full_name empty/untrimmed`)
      }
      if (ins.birth_date !== null && !isValidIsoDate(ins.birth_date)) {
        violations.push(`row ${c.sourceRowNumber}: birth_date not a valid YYYY-MM-DD string`)
      }
      if (ins.gender !== null) violations.push(`row ${c.sourceRowNumber}: gender must be null`)
    }
  }
  if (violations.length > 0) {
    console.error('PAYLOAD GUARD FAILED:')
    for (const v of violations) console.error(`  ${v}`)
    process.exit(1)
  }
  console.log(`[payload-guard] OK -- ${checked} child insert payload(s) checked, 0 violations`)
}

// ---------------------------------------------------------------------------
// Report (PII-safe: row numbers, uuids, counts, structural shape tags)
// ---------------------------------------------------------------------------

function printReport(classified: ClassifiedRow[], totalRows: number, yaCount: number, textWithoutYa: number): void {
  console.log('\n================================ S8-T4 REPORT ================================')
  console.log(`  sheet data rows: ${totalRows}, 'ya' rows: ${yaCount} (expected ${EXPECTED_YA_ROWS})`)
  console.log(`  rows with children text but NOT 'ya' (ignored): ${textWithoutYa}`)

  const byBucket = new Map<Bucket, ClassifiedRow[]>(ALL_BUCKETS.map((b) => [b, []]))
  for (const c of classified) byBucket.get(c.bucket)!.push(c)

  console.log('\n-- Buckets --')
  for (const b of ALL_BUCKETS) console.log(`  ${b}: ${byBucket.get(b)!.length}`)

  const sum = ALL_BUCKETS.reduce((acc, b) => acc + byBucket.get(b)!.length, 0)
  console.log('\n-- Reconciliation --')
  console.log(`  sum of all buckets: ${sum}`)
  console.log(`  'ya' rows:          ${yaCount}`)
  if (sum !== yaCount) {
    console.error(`  FAIL -- bucket sum ${sum} != 'ya' rows ${yaCount}`)
    process.exit(1)
  }
  console.log('  OK -- every ya row landed in exactly one bucket')

  console.log('\n-- Per row --')
  for (const c of classified) {
    const dated = c.parse.children.filter((ch) => ch.birth_date !== null).length
    const withNotes = c.parse.children.filter((ch) => ch.notes !== null).length
    const extras = [
      c.parse.parked ? `park=${parkReasonOf(c.parse.parked)}` : null,
      c.phoneIssue ? `phone=${c.phoneIssue}` : null,
    ].filter((x): x is string => x !== null)
    console.log(
      `  row ${c.sourceRowNumber}: ${c.bucket} parent=${c.personId ?? '-'} children=${c.parse.children.length} ` +
        `dated=${dated} with-notes=${withNotes} omitted=${c.parse.omittedEntries} will-insert=${c.inserts.length} ` +
        `shape=${c.parse.shape}${extras.length > 0 ? ' ' + extras.join(' ') : ''}`,
    )
  }

  const toInsert = classified.flatMap((c) => c.inserts)
  console.log('\n-- Insert plan --')
  console.log(`  children to insert: ${toInsert.length} across ${classified.filter((c) => c.inserts.length > 0).length} parent(s)`)
  console.log(`  with birth_date: ${toInsert.filter((i) => i.birth_date !== null).length}, null birth_date: ${toInsert.filter((i) => i.birth_date === null).length}`)
  console.log(`  with notes: ${toInsert.filter((i) => i.notes !== null).length}`)

  const shapes = new Map<string, number>()
  for (const c of classified) shapes.set(c.parse.shape, (shapes.get(c.parse.shape) ?? 0) + 1)
  console.log('\n-- Shape histogram (all ya rows, structural tags only) --')
  for (const [shape, n] of [...shapes.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n}x ${shape}`)

  console.log('\n================================== END REPORT ==================================\n')
}

// ---------------------------------------------------------------------------
// Apply
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
  if (!data) throw new Error('No app_users row for the given admin email')
  if (data.role !== 'admin' || !data.active) throw new Error(`Given email is not an active admin (role=${data.role}, active=${data.active})`)
  return data.id as string
}

/** Scratch-restore escape hatch (S7-T3.3 precedent): selects id/role/active
 *  only, so the email structurally cannot be printed. */
async function resolveAnyActiveAdmin(supabase: SupabaseClient): Promise<string> {
  const { data, error } = await supabase.from('app_users').select('id, role, active').eq('role', 'admin').eq('active', true).limit(1).maybeSingle()
  if (error) throw new Error(`Any-active-admin lookup failed: ${error.message}`)
  if (!data) throw new Error('No active admin found in app_users.')
  return data.id as string
}

async function countChildren(supabase: SupabaseClient): Promise<number> {
  const { count, error } = await supabase.from('children').select('id', { count: 'exact', head: true })
  if (error) throw error
  return count ?? 0
}

interface InsertedChild {
  id: string
  parent_person_id: string
  full_name: string
  birth_date: string | null
  gender: string | null
  notes: string | null
}

/** Mandatory post-write re-verify -- independent re-queries, never the
 *  insert's own return value. Prints counts / ids only. */
async function reVerifyAndAssert(
  supabase: SupabaseClient,
  writes: ClassifiedRow[],
  inserted: Map<string, ChildInsert>,
  preTotal: number,
  runId: string,
): Promise<void> {
  console.log('\n-- POST-WRITE RE-VERIFY --')
  let failures = 0

  // 1. Per-parent non-deleted child count == intended.
  const parentIds = writes.map((c) => c.personId!)
  const { data: perParent, error: e1 } = await supabase
    .from('children')
    .select('parent_person_id')
    .in('parent_person_id', parentIds)
    .is('deleted_at', null)
  if (e1) throw e1
  const counts = new Map<string, number>()
  for (const row of (perParent ?? []) as { parent_person_id: string }[]) {
    counts.set(row.parent_person_id, (counts.get(row.parent_person_id) ?? 0) + 1)
  }
  let countMismatch = 0
  for (const c of writes) {
    if ((counts.get(c.personId!) ?? 0) !== c.inserts.length) {
      countMismatch++
      console.error(`  FAIL: row ${c.sourceRowNumber} parent=${c.personId} expected ${c.inserts.length}, found ${counts.get(c.personId!) ?? 0}`)
    }
  }
  console.log(`  PER-PARENT COUNT: ${writes.length} parent(s) checked -- mismatches: ${countMismatch}`)
  failures += countMismatch

  // 2. Every inserted row's stored values equal the intended payload.
  const ids = [...inserted.keys()]
  const { data: rows, error: e2 } = await supabase
    .from('children')
    .select('id, parent_person_id, full_name, birth_date, gender, notes')
    .in('id', ids)
  if (e2) throw e2
  let valueMismatch = 0
  const found = new Map(((rows ?? []) as InsertedChild[]).map((r) => [r.id, r]))
  for (const [id, want] of inserted) {
    const got = found.get(id)
    const ok =
      !!got &&
      got.parent_person_id === want.parent_person_id &&
      got.full_name === want.full_name &&
      got.birth_date === want.birth_date &&
      got.gender === null &&
      got.notes === want.notes
    if (!ok) {
      valueMismatch++
      console.error(`  FAIL: child ${id} stored values differ from the intended payload (or row missing)`)
    }
  }
  console.log(`  STORED VALUES: ${ids.length} child row(s) checked -- mismatches: ${valueMismatch}`)
  failures += valueMismatch

  // 3. Table total moved by exactly the inserted count.
  const postTotal = await countChildren(supabase)
  const totalOk = postTotal === preTotal + inserted.size
  console.log(`  TABLE TOTAL: pre=${preTotal} post=${postTotal} inserted=${inserted.size} -- ok: ${totalOk}`)
  if (!totalOk) failures++

  // 4. Zero non-deleted children under a deleted or anonymized parent (global).
  const { data: inactive, error: e3 } = await supabase
    .from('people')
    .select('id')
    .or('deleted_at.not.is.null,anonymized_at.not.is.null')
  if (e3) throw e3
  const inactiveIds = ((inactive ?? []) as { id: string }[]).map((p) => p.id)
  let underInactive = 0
  if (inactiveIds.length > 0) {
    const { count, error: e4 } = await supabase
      .from('children')
      .select('id', { count: 'exact', head: true })
      .in('parent_person_id', inactiveIds)
      .is('deleted_at', null)
    if (e4) throw e4
    underInactive = count ?? 0
  }
  console.log(`  INACTIVE PARENTS: non-deleted children under deleted/anonymized parents: ${underInactive} (expect 0)`)
  if (underInactive !== 0) failures++

  // 5. One CHILD_CREATE audit row per inserted child for this run.
  const { count: auditCount, error: e5 } = await supabase
    .from('audit_log')
    .select('id', { count: 'exact', head: true })
    .eq('action', AUDIT_ACTIONS.CHILD_CREATE)
    .eq('details_json->>run_id', runId)
  if (e5) throw e5
  const auditOk = (auditCount ?? 0) === inserted.size
  console.log(`  AUDIT: child.create rows for run ${runId}: ${auditCount ?? 0} (expect ${inserted.size}) -- ok: ${auditOk}`)
  if (!auditOk) failures++

  if (failures > 0) {
    console.error(`\n  RE-VERIFY FAILED: ${failures} assertion(s) failed.`)
    process.exit(1)
  }
  console.log('\n  RE-VERIFY OK -- all assertions passed.')
}

async function runApply(supabase: SupabaseClient, classified: ClassifiedRow[], args: string[]): Promise<void> {
  const armed = args.includes('--confirm-apply')
  const writes = classified.filter((c) => WRITE_BUCKETS.has(c.bucket))
  const plannedChildren = writes.reduce((acc, c) => acc + c.inserts.length, 0)

  console.log(`[apply] would insert ${plannedChildren} child row(s) across ${writes.length} parent(s)`)
  if (!armed) {
    console.log('[apply] DRY (not armed) -- pass --confirm-apply to actually write. No DB writes made.')
    return
  }

  const adminId = args.includes('--any-active-admin') ? await resolveAnyActiveAdmin(supabase) : await resolveAdminActor(supabase, resolveAdminEmailArg(args))

  // Pre-write snapshot. Re-check Option A immediately before writing: if any
  // target parent gained a child since classification, abort before ANY write.
  const preTotal = await countChildren(supabase)
  const raced = await lookupParentsWithChildren(supabase, writes.map((c) => c.personId!))
  if (raced.size > 0) {
    console.error(`FATAL: ${raced.size} target parent(s) gained a child since classification -- re-run to reclassify. No writes made.`)
    process.exit(1)
  }
  console.log(`[apply] pre-write snapshot: children total=${preTotal}; all ${writes.length} target parent(s) still child-less`)

  const runId = crypto.randomUUID()
  const inserted = new Map<string, ChildInsert>()

  // One INSERT statement per parent: a parent is never half-written.
  for (const c of writes) {
    const { data, error } = await supabase.from('children').insert(c.inserts).select('id, parent_person_id, full_name, birth_date, notes')
    // Never rethrow the raw error: a Postgres constraint error's detail can
    // echo the failing row's values (name / birth date) into the console.
    if (error) throw new Error(`row ${c.sourceRowNumber}: children insert failed (code=${error.code}) -- earlier parents are committed; re-run is safe (Option A)`)
    const rows = (data ?? []) as Omit<InsertedChild, 'gender'>[]
    if (rows.length !== c.inserts.length) {
      throw new Error(`row ${c.sourceRowNumber}: inserted ${rows.length}, expected ${c.inserts.length}`)
    }
    for (const row of rows) {
      // Pair each returned row with its payload by value (order-independent).
      const want = c.inserts.find(
        (i) => i.full_name === row.full_name && i.birth_date === row.birth_date && i.notes === row.notes && ![...inserted.values()].includes(i),
      )
      if (!want) throw new Error(`row ${c.sourceRowNumber}: could not pair an inserted child with its payload`)
      inserted.set(row.id, want)
      await logAudit(
        {
          actorUserId: adminId,
          action: AUDIT_ACTIONS.CHILD_CREATE,
          entityType: 'children',
          entityId: row.id,
          // SURROGATE-KEYED ONLY -- never a name or birth date.
          detailsJson: { child_id: row.id, parent_id: row.parent_person_id, kind: 's8-t4-children-parse', run_id: runId },
        },
        supabase,
      )
    }
  }

  console.log(`[apply] DONE -- run_id=${runId}, inserted=${inserted.size} child row(s) across ${writes.length} parent(s)`)

  await reVerifyAndAssert(supabase, writes, inserted, preTotal, runId) // MANDATORY
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

  await runPreflightGuard('children-parse')

  if (!existsSync(FILE_PATH)) {
    console.error(`FATAL: roster file not found: ${FILE_PATH}`)
    process.exit(1)
  }
  const { yaRows, totalRows, textWithoutYa } = readWorkbook(readFileSync(FILE_PATH))

  if (yaRows.length !== EXPECTED_YA_ROWS) {
    console.error(`FATAL: expected ${EXPECTED_YA_ROWS} 'ya' rows, found ${yaRows.length} -- wrong or changed source file?`)
    process.exit(1)
  }
  assertNoDuplicateParentPhones(yaRows)

  const url = requireEnv('NEXT_PUBLIC_SUPABASE_URL')
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY')
  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })

  const phones = yaRows.filter((r) => r.phoneResult.ok).map((r) => (r.phoneResult as { ok: true; e164: string }).e164)
  const parentsByPhone = await lookupParents(supabase, phones)
  const activeParentIds = [...parentsByPhone.values()].filter((p) => p.anonymized_at === null && p.deleted_at === null).map((p) => p.id)
  const parentsWithChildren = await lookupParentsWithChildren(supabase, activeParentIds)

  const classified = yaRows.map((r) => classifyRow(r, parentsByPhone, parentsWithChildren))
  classified.sort((a, b) => a.sourceRowNumber - b.sourceRowNumber)

  const eligible = new Set(activeParentIds.filter((id) => !parentsWithChildren.has(id)))
  assertPayloadGuard(classified, eligible) // both modes; pure; before the report or any write

  printReport(classified, totalRows, yaRows.length, textWithoutYa)

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
