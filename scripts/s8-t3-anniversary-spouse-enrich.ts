/**
 * S8-T3 — Anniversary / spouse enrichment (DATA UMAT (19Aug2026).xlsx ->
 * people.wedding_anniversary / people.spouse_name), fill-empty only.
 *
 * Modes:
 *   --mode=dry-run   (default) — read-only. Plans every row, prints a PII-safe
 *                     aggregate report, writes surrogate-only diff/quarantine
 *                     files under scripts/.local-dumps/s8-t3/<runId>/.
 *   --mode=apply     — no-op unless --confirm-apply is also passed. Armed:
 *                     one guarded UPDATE per touched row (IS NULL per column in
 *                     SQL), one people.update audit row per filled row, then a
 *                     MANDATORY independent re-verify.
 *   --spot-check-rows=4,17,...
 *                   — prints the decoded anniversary for those row indexes ONLY
 *                     (owner calendar-day check), then exits. No env, no guard,
 *                     no DB connection. Refuses an empty/invalid list. This is
 *                     the ONLY mode that prints a date, and only to the terminal.
 *
 * Never writes anniversary_consent_state / anniversary_consent_at, or any
 * column other than wedding_anniversary, spouse_name, updated_at.
 *
 * RUNTIME WARNING — do NOT run this with `tsx` or `node --import tsx`.
 * normalizePhone fails SILENT under tsx/esbuild's ESM loader (see
 * memory/feedback_collab.md "Sprint 4 Task 2"). assertPhoneUtilTrustworthy()
 * is the startup backstop:
 *
 *   npx tsc -p scripts/tsconfig.s8-t3.json
 *   node --env-file=.env.rehearsal.local scripts/.build/scripts/s8-t3-anniversary-spouse-enrich.js [--mode=dry-run]
 *   node --env-file=.env.rehearsal.local scripts/.build/scripts/s8-t3-anniversary-spouse-enrich.js --mode=apply --confirm-apply --any-active-admin
 *   node scripts/.build/scripts/s8-t3-anniversary-spouse-enrich.js --spot-check-rows=4,17
 *
 * ENV: read from process.env, never loaded by this script. Outside spot-check
 * mode it hard-aborts unless an explicit --env-file= is on the node command
 * line. The resolved Supabase host (host only) is printed right after the
 * guard. --any-active-admin is refused unless that host is localhost/127.0.0.1.
 *
 * GUARD: runPreflightGuard(OP) before any client exists. evaluate() does not
 * whitelist ops; any non-CLI op resolves its ref from NEXT_PUBLIC_SUPABASE_URL.
 *
 * PARITY RAILS: hard-exit unless the sheet has exactly 227 data rows and
 * exactly 127 phones normalize valid (the S8-T3 recon census), and on any
 * duplicate valid phone.
 *
 * OUTPUT: counts, surrogate person ids, sheet row indexes, field names and
 * reason codes only. Never a name, phone or date (spot-check mode excepted).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as XLSX from 'xlsx'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import { normalizePhone } from '../lib/utils/phone'
import { AUDIT_ACTIONS, logAudit } from '../lib/audit'
import {
  ENRICH_FIELDS,
  anniversarySource,
  assertPayloadGuard,
  guardedFillUpdate,
  normalizeSpouse,
  parseAnniversaryCell,
  planRow,
  spouseSource,
  type AnniversaryParse,
  type ApplyOutcome,
  type EnrichField,
  type FieldOutcome,
  type RowPlan,
  type SnapshotRow,
  type SourceValue,
} from './lib/anniversary-spouse-enrich'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FILE_PATH = path.resolve(process.cwd(), 'docs/migration/DATA UMAT (19Aug2026).xlsx')
const DUMP_ROOT = path.resolve(process.cwd(), 'scripts/.local-dumps/s8-t3')
const OP = 'anniversary-spouse-enrich'
const AUDIT_KIND = 's8-t3-anniversary-spouse-fill'

const EXPECTED_SHEET_COUNT = 1
const EXPECTED_TOTAL_ROWS = 227
const EXPECTED_VALID_PHONES = 127
const MAX_SPOT_CHECK_ROWS = 5

const HEADER_ALIASES = {
  phone: 'Nomor HP',
  anniversary: 'Tanggal Wedding Anniversary',
  spouse: 'Nama Pasangan',
} as const
type FieldKey = keyof typeof HEADER_ALIASES

// ---------------------------------------------------------------------------
// Copied verbatim from scripts/s7-t3-roster-remigrate.ts (D-B7: copy, no
// shared module): cellToTrimmedString, assertPhoneUtilTrustworthy,
// stripPhoneSeparators, normalizeRosterPhone.
// ---------------------------------------------------------------------------

function cellToTrimmedString(raw: unknown): string {
  if (raw === null || raw === undefined) return ''
  return String(raw).trim()
}

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
// Preflight guard -- copied from S7-T3 (dynamic-imports the real
// guard.mjs/resolve-ref.mjs; getBranch/loadMap duplicated because guard.mjs
// doesn't export them).
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
    console.error('================ PREFLIGHT ABORT (s8-t3-anniversary-spouse-enrich) ================')
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
// Env / actor (copied from S7-T3) + S8-T3 host rails
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

async function resolveAnyActiveAdmin(supabase: SupabaseClient): Promise<string> {
  const { data, error } = await supabase.from('app_users').select('id, role, active').eq('role', 'admin').eq('active', true).limit(1).maybeSingle()
  if (error) throw new Error(`Any-active-admin lookup failed: ${error.message}`)
  if (!data) throw new Error('No active admin found in app_users.')
  return data.id as string
}

function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1'
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

interface ParsedRow {
  rowIndex: number // 0-indexed sheet row (header = row 0), same indexing as the S7-T3/S8-T3 recon
  phoneResult: ReturnType<typeof normalizePhone>
  anniversary: AnniversaryParse
  spouse: string | null
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

function parseWorkbook(buffer: Buffer, todayIso: string): { rows: ParsedRow[]; totalRows: number } {
  // cellDates: true -- same as S7-T3 / S8-T4 / lib/import (see S7-T3's note on
  // the SheetJS +1-day discrepancy between its two date-decoding paths).
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

  const rows: ParsedRow[] = []
  for (let r = headerRowIdx + 1; r <= range.e.r; r++) {
    rows.push({
      rowIndex: r,
      phoneResult: normalizeRosterPhone(cellAt(r, 'phone')),
      anniversary: parseAnniversaryCell(cellAt(r, 'anniversary'), todayIso),
      spouse: normalizeSpouse(cellAt(r, 'spouse')),
    })
  }
  return { rows, totalRows: rows.length }
}

function readRoster(todayIso: string): { rows: ParsedRow[]; totalRows: number } {
  if (!existsSync(FILE_PATH)) {
    console.error(`FATAL: roster file not found: ${FILE_PATH}`)
    process.exit(1)
  }
  return parseWorkbook(readFileSync(FILE_PATH), todayIso)
}

// ---------------------------------------------------------------------------
// Spot-check mode (owner calendar-day verification) -- terminal only, no DB.
// ---------------------------------------------------------------------------

function parseSpotCheckRows(arg: string): number[] | null {
  const list = arg.slice('--spot-check-rows='.length).trim()
  if (list === '') return null
  const parts = list.split(',').map((s) => s.trim())
  const nums: number[] = []
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null
    const n = Number(p)
    if (n < 1 || n > EXPECTED_TOTAL_ROWS) return null
    nums.push(n)
  }
  if (nums.length === 0 || nums.length > MAX_SPOT_CHECK_ROWS || new Set(nums).size !== nums.length) return null
  return nums
}

function runSpotCheck(arg: string, todayIso: string): void {
  const wanted = parseSpotCheckRows(arg)
  if (!wanted) {
    console.error(
      `FATAL: --spot-check-rows needs 1..${MAX_SPOT_CHECK_ROWS} distinct sheet row indexes in 1..${EXPECTED_TOTAL_ROWS}, ` +
        `comma-separated (e.g. --spot-check-rows=4,17). Refusing.`,
    )
    process.exit(1)
  }
  const { rows } = readRoster(todayIso)
  console.log('-- SPOT CHECK (terminal only; do not paste these into any report) --')
  for (const n of wanted) {
    const row = rows.find((r) => r.rowIndex === n)
    if (!row) {
      console.log(`  row ${n}: (no such row)`)
      continue
    }
    const a = row.anniversary
    const shown = a.kind === 'ok' ? a.iso : a.kind === 'quarantine' ? `quarantined:${a.reason}` : a.kind
    console.log(`  row ${n}: wedding_anniversary=${shown}`)
  }
  console.log('[spot-check] done -- no DB connection made.')
}

// ---------------------------------------------------------------------------
// Rails on the parsed file
// ---------------------------------------------------------------------------

function assertFileRails(rows: ParsedRow[], totalRows: number): void {
  const trapped = rows.filter((r) => r.anniversary.kind === 'abort-nonzero-utc-time').map((r) => r.rowIndex)
  if (trapped.length > 0) {
    console.error(`FATAL: anniversary Date cell(s) with non-zero UTC time (+1-day trap signal) at row index(es): ${trapped.join(', ')}. Aborting.`)
    process.exit(1)
  }

  const validPhones = rows.filter((r) => r.phoneResult.ok).length
  console.log(`[parity] sheet rows=${totalRows} (expect ${EXPECTED_TOTAL_ROWS}), valid phones=${validPhones} (expect ${EXPECTED_VALID_PHONES})`)
  if (totalRows !== EXPECTED_TOTAL_ROWS || validPhones !== EXPECTED_VALID_PHONES) {
    console.error('FATAL: parity rail failed -- file or phone normalizer drifted from the S8-T3 recon census. Aborting.')
    process.exit(1)
  }

  const seen = new Map<string, number[]>()
  for (const r of rows) {
    if (!r.phoneResult.ok) continue
    const list = seen.get(r.phoneResult.e164) ?? []
    list.push(r.rowIndex)
    seen.set(r.phoneResult.e164, list)
  }
  const dupRows = [...seen.values()].filter((l) => l.length > 1)
  if (dupRows.length > 0) {
    console.error(`FATAL: duplicate valid phone(s) in source at row index groups: ${dupRows.map((l) => `[${l.join(',')}]`).join(' ')}. Aborting.`)
    process.exit(1)
  }
  console.log('[parity] OK -- no non-zero-UTC anniversary Date, counts match, 0 duplicate phones')
}

// ---------------------------------------------------------------------------
// Lookup + planning
// ---------------------------------------------------------------------------

interface TargetRow extends SnapshotRow {
  phone_e164: string
  deleted_at: string | null
  anonymized_at: string | null
  marital_status: 'married' | 'single' | null
}

type RowBucket = 'no_phone' | 'phone_invalid' | 'unmatched' | 'matched_inactive' | 'matched_active'
const ROW_BUCKETS: RowBucket[] = ['no_phone', 'phone_invalid', 'unmatched', 'matched_inactive', 'matched_active']

async function lookupTargets(supabase: SupabaseClient, phones: string[]): Promise<Map<string, TargetRow>> {
  const result = new Map<string, TargetRow>()
  if (phones.length === 0) return result
  const { data, error } = await supabase
    .from('people')
    .select('id, phone_e164, deleted_at, anonymized_at, marital_status, wedding_anniversary, spouse_name')
    .in('phone_e164', [...new Set(phones)])
  if (error) throw error
  for (const p of (data ?? []) as TargetRow[]) result.set(p.phone_e164, p)
  return result
}

interface Classified {
  rowBuckets: Map<RowBucket, number>
  plans: RowPlan[]
  activeTargets: TargetRow[]
}

function sourcesFor(row: ParsedRow): Record<EnrichField, SourceValue> {
  if (row.anniversary.kind === 'abort-nonzero-utc-time') throw new Error('unreachable: trap rows abort before planning')
  return {
    wedding_anniversary: anniversarySource(row.anniversary),
    spouse_name: spouseSource(row.spouse),
  }
}

function classify(rows: ParsedRow[], targets: Map<string, TargetRow>): Classified {
  const rowBuckets = new Map<RowBucket, number>(ROW_BUCKETS.map((b) => [b, 0]))
  const plans: RowPlan[] = []
  const activeTargets: TargetRow[] = []
  const bump = (b: RowBucket) => rowBuckets.set(b, (rowBuckets.get(b) ?? 0) + 1)

  for (const row of rows) {
    if (!row.phoneResult.ok) {
      bump(row.phoneResult.reason === 'empty' ? 'no_phone' : 'phone_invalid')
      continue
    }
    const target = targets.get(row.phoneResult.e164)
    if (!target) {
      bump('unmatched')
      continue
    }
    if (target.deleted_at !== null || target.anonymized_at !== null) {
      bump('matched_inactive')
      continue
    }
    bump('matched_active')
    activeTargets.push(target)
    plans.push(planRow(target, row.rowIndex, sourcesFor(row)))
  }
  return { rowBuckets, plans, activeTargets }
}

// ---------------------------------------------------------------------------
// Report + surrogate files
// ---------------------------------------------------------------------------

type ReportOutcome = FieldOutcome | ApplyOutcome
const REPORT_OUTCOMES: ReportOutcome[] = ['would_fill', 'filled', 'already_equal', 'conflict', 'quarantined', 'race_skipped', 'source_empty']

function printReport(
  rows: ParsedRow[],
  totalRows: number,
  c: Classified,
  applied: Map<string, ApplyOutcome> | null,
): void {
  console.log('\n============ S8-T3 ANNIVERSARY / SPOUSE ENRICH -- REPORT (PII-SAFE) ============\n')

  console.log('-- Row buckets --')
  let sum = 0
  for (const b of ROW_BUCKETS) {
    const n = c.rowBuckets.get(b) ?? 0
    sum += n
    console.log(`  ${b}: ${n}`)
  }
  console.log(`  sum: ${sum} (sheet rows: ${totalRows})`)
  if (sum !== totalRows) {
    console.error(`  RECONCILIATION FAILED: row bucket sum (${sum}) != sheet rows (${totalRows})`)
    process.exit(1)
  }

  const matched = c.plans.length
  console.log(`\n-- Per-field outcomes (matched_active rows: ${matched}) --`)
  for (const f of ENRICH_FIELDS) {
    const counts = new Map<ReportOutcome, number>(REPORT_OUTCOMES.map((o) => [o, 0]))
    for (const p of c.plans) {
      let o: ReportOutcome = p.outcomes[f]
      if (o === 'would_fill' && applied) o = applied.get(p.personId) ?? 'would_fill'
      counts.set(o, (counts.get(o) ?? 0) + 1)
    }
    const total = [...counts.values()].reduce((a, b) => a + b, 0)
    console.log(`  ${f}: ${REPORT_OUTCOMES.map((o) => `${o}=${counts.get(o)}`).join(' ')} (sum=${total})`)
    if (total !== matched) {
      console.error(`  RECONCILIATION FAILED: ${f} outcome sum (${total}) != matched_active (${matched})`)
      process.exit(1)
    }
  }

  const quarantineByReason = new Map<string, number>()
  for (const r of rows) {
    if (r.anniversary.kind === 'quarantine') quarantineByReason.set(r.anniversary.reason, (quarantineByReason.get(r.anniversary.reason) ?? 0) + 1)
  }
  console.log('\n-- Source diagnostics (all sheet rows) --')
  console.log(`  anniversary ok: ${rows.filter((r) => r.anniversary.kind === 'ok').length}, empty: ${rows.filter((r) => r.anniversary.kind === 'empty').length}`)
  console.log(`  anniversary quarantined by reason: ${JSON.stringify(Object.fromEntries(quarantineByReason))}`)
  const spouseLens = rows.filter((r) => r.spouse !== null).map((r) => (r.spouse as string).length)
  console.log(`  spouse non-empty: ${spouseLens.length}, max_len: ${spouseLens.length > 0 ? Math.max(...spouseLens) : 0}`)

  const notMarriedNull = c.activeTargets.filter((t) => t.marital_status === null).length
  const notMarriedSingle = c.activeTargets.filter((t) => t.marital_status === 'single').length
  console.log('\n-- Observation (no gate): matched_active rows whose prod marital_status is not married --')
  console.log(`  null: ${notMarriedNull}, single: ${notMarriedSingle}`)

  console.log('\n=================================== END REPORT ===================================\n')
}

function writeSurrogateFiles(runId: string, rows: ParsedRow[], plans: RowPlan[], applied: Map<string, ApplyOutcome> | null): string {
  const dir = path.join(DUMP_ROOT, runId)
  mkdirSync(dir, { recursive: true })
  const diff = plans
    .filter((p) => ENRICH_FIELDS.some((f) => p.outcomes[f] !== 'source_empty'))
    .map((p) => ({
      personId: p.personId,
      rowIndex: p.rowIndex,
      fields: Object.fromEntries(
        ENRICH_FIELDS.map((f) => {
          const o: ReportOutcome = p.outcomes[f] === 'would_fill' && applied ? applied.get(p.personId) ?? 'would_fill' : p.outcomes[f]
          return [f, o]
        }),
      ),
    }))
  const quarantine = rows
    .filter((r) => r.anniversary.kind === 'quarantine')
    .map((r) => ({ rowIndex: r.rowIndex, field: 'wedding_anniversary', reason: (r.anniversary as { reason: string }).reason }))
  writeFileSync(path.join(dir, 'diff.json'), JSON.stringify(diff, null, 2))
  writeFileSync(path.join(dir, 'quarantine.json'), JSON.stringify(quarantine, null, 2))
  return dir
}

// ---------------------------------------------------------------------------
// Apply + re-verify
// ---------------------------------------------------------------------------

interface PreImageRow {
  id: string
  wedding_anniversary: string | null
  spouse_name: string | null
  anniversary_consent_state: string
  anniversary_consent_at: string | null
  updated_at: string
}

const PRE_IMAGE_COLUMNS = 'id, wedding_anniversary, spouse_name, anniversary_consent_state, anniversary_consent_at, updated_at'

async function snapshotActiveUniverse(supabase: SupabaseClient): Promise<Map<string, PreImageRow>> {
  const { data, error } = await supabase.from('people').select(PRE_IMAGE_COLUMNS).is('deleted_at', null).is('anonymized_at', null)
  if (error) throw error
  return new Map((data as PreImageRow[]).map((p) => [p.id, p]))
}

/** MANDATORY post-write re-verify. Independent re-query; counts/ids only. */
async function reVerifyAndAssert(
  supabase: SupabaseClient,
  preImage: Map<string, PreImageRow>,
  plans: RowPlan[],
  applied: Map<string, ApplyOutcome>,
  importId: string,
): Promise<void> {
  console.log('\n-- POST-WRITE RE-VERIFY (independent re-query, PII-safe: counts/ids only) --')
  const post = await snapshotActiveUniverse(supabase)
  const planById = new Map(plans.map((p) => [p.personId, p]))
  let failures = 0
  const fail = (msg: string) => {
    console.error(`  FAIL: ${msg}`)
    failures++
  }

  // 1. FILLED: every filled field now equals the planned value.
  let filledRows = 0
  let filledMismatch = 0
  for (const [id, outcome] of applied) {
    if (outcome !== 'filled') continue
    filledRows++
    const plan = planById.get(id)
    const now = post.get(id)
    if (!plan?.payload || !now) {
      filledMismatch++
      continue
    }
    for (const [f, v] of Object.entries(plan.payload)) {
      if (now[f as EnrichField] !== v) filledMismatch++
    }
  }
  console.log(`  FILLED: ${filledRows} rows -- value mismatches: ${filledMismatch}`)
  if (filledMismatch !== 0) fail('a filled field does not equal its planned value')

  // 2. NO-CLOBBER: every pre-image non-null enrich value unchanged.
  let clobber = 0
  for (const [id, pre] of preImage) {
    const now = post.get(id)
    if (!now) continue
    for (const f of ENRICH_FIELDS) if (pre[f] !== null && now[f] !== pre[f]) clobber++
  }
  console.log(`  NO-CLOBBER: violations: ${clobber}`)
  if (clobber !== 0) fail('a non-null enrich value changed')

  // 3. UNTOUCHED: rows not filled (incl. race_skipped) byte-identical on all 5 columns.
  let untouchedDrift = 0
  let untouchedRows = 0
  for (const [id, pre] of preImage) {
    if (applied.get(id) === 'filled') continue
    untouchedRows++
    const now = post.get(id)
    if (
      !now ||
      now.wedding_anniversary !== pre.wedding_anniversary ||
      now.spouse_name !== pre.spouse_name ||
      now.anniversary_consent_state !== pre.anniversary_consent_state ||
      now.anniversary_consent_at !== pre.anniversary_consent_at ||
      now.updated_at !== pre.updated_at
    ) {
      untouchedDrift++
    }
  }
  console.log(`  UNTOUCHED: ${untouchedRows} rows -- drift: ${untouchedDrift}`)
  if (untouchedDrift !== 0) fail('a row this run did not fill changed')

  // 4. F1: anniversary consent pair unchanged on every active row.
  let consentDrift = 0
  for (const [id, pre] of preImage) {
    const now = post.get(id)
    if (!now || now.anniversary_consent_state !== pre.anniversary_consent_state || now.anniversary_consent_at !== pre.anniversary_consent_at) consentDrift++
  }
  console.log(`  F1 consent pair unchanged: drift: ${consentDrift}`)
  if (consentDrift !== 0) fail('anniversary_consent_state/at changed')

  // 5. AUDIT: one people.update per filled row for this importId, field names only.
  const { data: auditRows, error: auditErr } = await supabase
    .from('audit_log')
    .select('id, entity_id, details_json')
    .eq('action', AUDIT_ACTIONS.PEOPLE_UPDATE)
    .eq('details_json->>importId', importId)
  if (auditErr) throw auditErr
  const rowsA = (auditRows ?? []) as { entity_id: string; details_json: { kind?: string; fields?: unknown } }[]
  const allowed = new Set<string>(ENRICH_FIELDS)
  const badShape = rowsA.filter(
    (r) =>
      r.details_json?.kind !== AUDIT_KIND ||
      !Array.isArray(r.details_json.fields) ||
      (r.details_json.fields as unknown[]).length === 0 ||
      !(r.details_json.fields as unknown[]).every((x) => typeof x === 'string' && allowed.has(x)),
  ).length
  console.log(`  AUDIT: rows for importId=${rowsA.length} (expect ${filledRows}), bad shape: ${badShape}`)
  if (rowsA.length !== filledRows) fail('audit row count != filled row count')
  if (badShape !== 0) fail('audit details_json has an unexpected shape')

  if (failures > 0) {
    console.error(`\n  RE-VERIFY FAILED: ${failures} assertion(s) failed.`)
    process.exit(1)
  }
  console.log('\n  RE-VERIFY OK -- all assertions passed.')
}

async function runApply(supabase: SupabaseClient, plans: RowPlan[], args: string[]): Promise<{ applied: Map<string, ApplyOutcome>; importId: string } | null> {
  const armed = args.includes('--confirm-apply')
  const writes = plans.filter((p) => p.payload !== null)
  console.log(`[apply] would update ${writes.length} row(s)`)
  if (!armed) {
    console.log('[apply] DRY (not armed) -- pass --confirm-apply to actually write. No DB writes made.')
    return null
  }

  const adminId = args.includes('--any-active-admin') ? await resolveAnyActiveAdmin(supabase) : await resolveAdminActor(supabase, resolveAdminEmailArg(args))

  const preImage = await snapshotActiveUniverse(supabase) // BEFORE any write
  const importId = randomUUID()
  const applied = new Map<string, ApplyOutcome>()

  for (const p of writes) {
    const outcome = await guardedFillUpdate(supabase, p.personId, p.payload!, new Date().toISOString())
    applied.set(p.personId, outcome)
    if (outcome === 'filled') {
      await logAudit(
        {
          actorUserId: adminId,
          action: AUDIT_ACTIONS.PEOPLE_UPDATE,
          entityType: 'people',
          entityId: p.personId,
          detailsJson: { kind: AUDIT_KIND, fields: Object.keys(p.payload!), importId },
        },
        supabase,
      )
    }
  }

  const filled = [...applied.values()].filter((o) => o === 'filled').length
  console.log(`[apply] DONE -- importId=${importId}, filled=${filled}, race_skipped=${applied.size - filled}`)

  await reVerifyAndAssert(supabase, preImage, plans, applied, importId) // MANDATORY
  return { applied, importId }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  assertPhoneUtilTrustworthy()

  const args = process.argv.slice(2)
  const todayIso = new Date().toISOString().slice(0, 10)

  const spotArg = args.find((a) => a.startsWith('--spot-check-rows'))
  if (spotArg !== undefined) {
    runSpotCheck(spotArg.includes('=') ? spotArg : '--spot-check-rows=', todayIso)
    return
  }

  const modeArg = args.find((a) => a.startsWith('--mode='))
  const mode = modeArg ? modeArg.slice('--mode='.length) : 'dry-run'
  if (mode !== 'dry-run' && mode !== 'apply') {
    console.error(`FATAL: unknown --mode=${mode}, expected dry-run or apply`)
    process.exit(1)
  }

  if (!process.execArgv.some((a) => a.startsWith('--env-file='))) {
    console.error('FATAL: run with an explicit node --env-file=<file>. Refusing to use ambient env.')
    process.exit(1)
  }

  await runPreflightGuard(OP)

  const url = requireEnv('NEXT_PUBLIC_SUPABASE_URL')
  const host = new URL(url).host
  console.log(`[target] supabase host: ${host}`)
  if (args.includes('--any-active-admin') && !isLocalHostname(new URL(url).hostname)) {
    console.error('FATAL: --any-active-admin is only allowed against localhost/127.0.0.1. Refusing.')
    process.exit(1)
  }

  const { rows, totalRows } = readRoster(todayIso)
  assertFileRails(rows, totalRows)

  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY')
  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })

  const phones = rows.filter((r) => r.phoneResult.ok).map((r) => (r.phoneResult as { ok: true; e164: string }).e164)
  const targets = await lookupTargets(supabase, phones)
  const classified = classify(rows, targets)

  const snapshotById = new Map(classified.activeTargets.map((t) => [t.id, t]))
  const violations = assertPayloadGuard(classified.plans, snapshotById)
  if (violations.length > 0) {
    console.error('PAYLOAD GUARD FAILED:')
    for (const v of violations) console.error(`  ${v}`)
    process.exit(1)
  }
  console.log(`[payload-guard] OK -- ${classified.plans.filter((p) => p.payload).length} payload(s) checked, 0 violations`)

  const runId = new Date().toISOString().replace(/[:.]/g, '-')

  if (mode === 'apply') {
    printReport(rows, totalRows, classified, null)
    const result = await runApply(supabase, classified.plans, args)
    if (result) printReport(rows, totalRows, classified, result.applied)
    const dir = writeSurrogateFiles(runId, rows, classified.plans, result?.applied ?? null)
    console.log(`[files] surrogate diff + quarantine written to ${path.relative(process.cwd(), dir)}/`)
  } else {
    printReport(rows, totalRows, classified, null)
    const dir = writeSurrogateFiles(runId, rows, classified.plans, null)
    console.log(`[files] surrogate diff + quarantine written to ${path.relative(process.cwd(), dir)}/`)
    console.log('[mode] dry-run complete -- no DB writes made.')
  }
}

main().catch((err) => {
  console.error('FATAL:', err instanceof Error ? err.stack ?? err.message : err)
  process.exit(1)
})
