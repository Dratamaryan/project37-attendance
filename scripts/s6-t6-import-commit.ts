/**
 * S6-T6 — REAL ROSTER IMPORT COMMIT (P0, irreversible, real PII).
 *
 * One-off, prod-only script. Never goes through the deployed HTTP route
 * (app/api/admin/import/people/route.ts has NO prod-ref env-guard — it just
 * trusts whatever NEXT_PUBLIC_SUPABASE_URL the running process resolves,
 * which is fine for the always-guarded admin-session HTTP path but not
 * strong enough for a one-off irreversible ~188-row real-PII bulk write).
 * This script calls runImportDryRun / runImportCommit (lib/import/*.impl.ts)
 * directly, in-process, against a service-role client built from
 * explicitly-asserted prod env vars — same reuse pattern the route itself
 * uses, with the env-guard the route doesn't have.
 *
 * RUNTIME WARNING — do NOT run this with `tsx` or `node --import tsx`.
 * normalizePhone (libphonenumber-js's `/min` subpath) FAILS SILENT under
 * tsx/esbuild's ESM loader: it returns `invalid_for_country` for every valid
 * phone number, no thrown error, no crash — every row would misclassify as
 * 'error' and 0 people would import, with no signal anything went wrong.
 * Full writeup: memory/feedback_collab.md, "Sprint 4 Task 2 — normalizePhone
 * fails SILENT under tsx/node's ESM loader". This script self-asserts a
 * known-good phone number at startup and hard-exits if the runtime can't be
 * trusted (assertPhoneUtilTrustworthy) — that is the backstop, not a
 * substitute for the correct invocation:
 *
 *   npx tsc -p scripts/tsconfig.s6-t6.json
 *   node scripts/.build/scripts/s6-t6-import-commit.js                 (read-only preflight)
 *   node scripts/.build/scripts/s6-t6-import-commit.js --confirm-commit  (ARMED — writes ~188 people rows)
 *   node scripts/.build/scripts/s6-t6-import-commit.js --rollback <importId>                       (rollback preview)
 *   node scripts/.build/scripts/s6-t6-import-commit.js --rollback <importId> --confirm-rollback     (ARMED rollback)
 *
 * Env (from a prod-pointed .env.local, loaded by the caller, e.g.
 * `node --env-file .env.local scripts/.build/scripts/s6-t6-import-commit.js`):
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ACCESS_TOKEN
 * Plus the audit actor's email -- not hardcoded (public repo): either
 * IMPORT_ADMIN_EMAIL in env, or --admin-email <email> on the command line.
 *
 * Expected-numbers provenance (Catch 1, this session): the file has 191
 * rows; 3 of them are the SAME person entered twice under the same phone
 * number — the 3 known phone-duplicates recorded in the Database Schema
 * doc's "known duplicates" note (names omitted here — member PII, kept out
 * of the public repo; see that doc, gitignored, for who) — so they classify
 * dup_in_file and never insert. Only 188 rows insert. The consent/birth_date
 * DB expectations below are computed over that 188-row 'new' subset, not the
 * 191-row file tally — see EXPECTED_NEW_SUBSET vs EXPECTED_ALL_ROWS below,
 * and the reconciliation printed by the dry-run gate.
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import { normalizePhone } from '../lib/utils/phone'
import { runImportDryRun } from '../lib/import/dry-run.impl'
import { runImportCommit } from '../lib/import/commit.impl'
import { AUDIT_ACTIONS, logAudit } from '../lib/audit'
import type { ClassifiedRow, ClassificationCounts } from '../lib/import/types'

// Every path constant/lookup in this file is resolved relative to
// process.cwd() (run from the repo root), never __dirname -- __dirname's
// location depends on where tsc emits the compiled output (nested one level
// deeper than the source, scripts/.build/scripts/*.js), which silently
// breaks '../'-relative math. Same lesson as repair-roster-birthdates.ts's
// own header comment.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_REF = 'bftifxgdcmisasgvobuf'

// Locked import target. Rejects anything that isn't exactly this path, and
// additionally rejects any path containing 'sample'/'synthetic' as a second,
// independent check in case this constant is ever edited carelessly.
const FILE_PATH = path.resolve(process.cwd(), 'docs/data-samples/roster-repair/legacy-roster-corrected.xlsx')
const FORBIDDEN_PATH_TOKENS = ['sample', 'synthetic']

// Every column toInsertPayload (lib/import/commit.impl.ts) writes, with the
// live type expected per the Database Schema doc + the S6-T3 migration
// (supabase/migrations/20260810120000_sprint6_task3_photo_consent_anonymized.sql).
// A phantom/renamed/retyped column here fails the WHOLE insert batch per
// commit.impl.ts's own comment -- this is re-derived against live
// information_schema immediately before every commit attempt, never trusted
// from this table alone.
interface ExpectedColumn {
  name: string
  dataType: string // information_schema.columns.data_type
  udtName?: string // only checked when dataType === 'USER-DEFINED'
}
const EXPECTED_COLUMNS: ExpectedColumn[] = [
  { name: 'phone_e164', dataType: 'text' },
  { name: 'full_name', dataType: 'text' },
  { name: 'nickname', dataType: 'text' },
  { name: 'birth_place', dataType: 'text' },
  { name: 'birth_date', dataType: 'date' },
  { name: 'gender', dataType: 'USER-DEFINED', udtName: 'gender_enum' },
  { name: 'origin_parish', dataType: 'text' },
  { name: 'marital_status', dataType: 'USER-DEFINED', udtName: 'marital_status_enum' },
  { name: 'kepanitiaan', dataType: 'text' },
  { name: 'tribe', dataType: 'text' },
  { name: 'photo_consent_state', dataType: 'USER-DEFINED', udtName: 'consent_state_enum' },
  { name: 'photo_publish_consent', dataType: 'boolean' },
]

// Fresh pre-commit dry-run gate. All-191-rows numbers are the file-level
// continuity check against T5's report; the *_NEW_SUBSET numbers are what
// actually lands in the DB post-commit (Catch 1 recomputation, this
// session) and are what §5's post-commit recount asserts against.
const EXPECTED_ALL_ROWS = {
  totalRows: 191,
  classificationCounts: { new: 188, dup_in_db: 0, dup_in_file: 3, dup_soft_deleted: 0, error: 0 } satisfies ClassificationCounts,
  nullBirthDate: 12,
  consent: { granted: 81, refused: 33, unknown: 77 },
}
const EXPECTED_NEW_SUBSET = {
  count: 188,
  nullBirthDate: 12,
  consent: { granted: 81, refused: 33, unknown: 74 },
  publishConsent: { true: 81, false: 107 },
}

// ---------------------------------------------------------------------------
// Env / client setup (duplicated from deactivate-test-users.ts / wipe-and-
// reseed.ts by convention -- each script here is self-contained)
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var: ${name}`)
  return v
}

/** No personal email hardcoded in this public-repo file. Reads --admin-email
 *  <value> if given, else IMPORT_ADMIN_EMAIL from env; fails loud if neither
 *  is set. This is the email whose app_users row becomes the audit actor for
 *  every write this script makes (commit, rollback). */
function resolveAdminEmailArg(args: string[]): string {
  const idx = args.indexOf('--admin-email')
  if (idx >= 0 && args[idx + 1]) return args[idx + 1]
  const envVal = process.env.IMPORT_ADMIN_EMAIL
  if (envVal) return envVal
  throw new Error('Missing admin email: pass --admin-email <email> or set IMPORT_ADMIN_EMAIL in env.')
}

function assertEnvGuards() {
  const url = requireEnv('NEXT_PUBLIC_SUPABASE_URL')
  if (!url.includes(PROJECT_REF)) {
    throw new Error(`ENV GUARD FAILED: NEXT_PUBLIC_SUPABASE_URL does not resolve to prod (${PROJECT_REF}). Got: ${url}`)
  }

  const linkedRefPath = path.resolve(process.cwd(), 'supabase/.temp/project-ref')
  if (!existsSync(linkedRefPath)) {
    throw new Error(`ENV GUARD FAILED: ${linkedRefPath} not found -- run "supabase link" against prod first.`)
  }
  const linkedRef = readFileSync(linkedRefPath, 'utf8').trim()
  if (linkedRef !== PROJECT_REF) {
    throw new Error(`ENV GUARD FAILED: linked project-ref is "${linkedRef}", expected "${PROJECT_REF}".`)
  }

  console.log(`[env-guard] OK -- NEXT_PUBLIC_SUPABASE_URL and supabase/.temp/project-ref both resolve to ${PROJECT_REF}`)
}

function assertFilePathLocked() {
  // Checked against the FILENAME only, not the full path -- the legitimate
  // file legitimately lives under a directory literally named
  // 'data-samples' (docs/data-samples/roster-repair/...), which contains the
  // substring 'sample'. Matching the full path here was a false positive
  // that blocked the correct file, not just synthetic ones (caught live
  // against prod on first run). The endswith check below is the real lock;
  // this is the additional belt-and-suspenders check on top of it.
  const lowerFilename = path.basename(FILE_PATH).toLowerCase()
  for (const token of FORBIDDEN_PATH_TOKENS) {
    if (lowerFilename.includes(token)) {
      throw new Error(`FILE GUARD FAILED: filename contains forbidden token "${token}": ${FILE_PATH}`)
    }
  }
  if (!FILE_PATH.endsWith('roster-repair/legacy-roster-corrected.xlsx')) {
    throw new Error(`FILE GUARD FAILED: FILE_PATH is not the regenerated corrected file: ${FILE_PATH}`)
  }
  if (!existsSync(FILE_PATH)) {
    throw new Error(`FILE GUARD FAILED: ${FILE_PATH} does not exist.`)
  }
  console.log(`[file-guard] OK -- importing ${FILE_PATH}`)
}

/** Backstop for the tsx/esbuild ESM-loader bug documented in
 *  memory/feedback_collab.md (Sprint 4 Task 2). Hard-fails before any file
 *  I/O or DB contact if normalizePhone is misbehaving under the current
 *  runtime -- see the RUNTIME WARNING in this file's header comment. */
function assertPhoneUtilTrustworthy(): void {
  const KNOWN_PHONE = '081808247576'
  const EXPECTED_E164 = '+6281808247576'
  const result = normalizePhone(KNOWN_PHONE, 'ID')
  if (!result.ok || result.e164 !== EXPECTED_E164) {
    console.error(
      `FATAL: normalizePhone('${KNOWN_PHONE}', 'ID') returned ${JSON.stringify(result)}, expected ` +
        `{ ok: true, e164: '${EXPECTED_E164}' }. This runtime cannot be trusted for phone matching ` +
        `(likely running under tsx -- see the RUNTIME WARNING at the top of this file). Refusing to proceed.`,
    )
    process.exit(1)
  }
  console.log('[phone-util-guard] OK -- known-good phone normalized correctly under this runtime')
}

function getServiceClient(): SupabaseClient {
  const url = requireEnv('NEXT_PUBLIC_SUPABASE_URL')
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY')
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
}

async function managementApiQuery(sql: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  const token = requireEnv('SUPABASE_ACCESS_TOKEN')
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  })
  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = await res.text()
  }
  return { ok: res.ok, status: res.status, body }
}

async function resolveAdminActor(admin: SupabaseClient, adminEmail: string): Promise<string> {
  const { data, error } = await admin
    .from('app_users')
    .select('id, email, role, active')
    .eq('email', adminEmail)
    .maybeSingle()
  if (error) throw new Error(`Admin actor lookup failed: ${error.message}`)
  if (!data) throw new Error(`CROSS-CHECK FAILED: no app_users row for ${adminEmail}`)
  if (data.role !== 'admin' || !data.active) {
    throw new Error(`CROSS-CHECK FAILED: ${adminEmail} is not an active admin live (role=${data.role}, active=${data.active})`)
  }
  console.log(`[admin-actor] OK -- ${adminEmail} resolves to ${data.id}`)
  return data.id as string
}

// ---------------------------------------------------------------------------
// Step 1 -- live schema-gate
// ---------------------------------------------------------------------------

interface LiveColumn {
  column_name: string
  data_type: string
  udt_name: string
}

async function schemaGate(): Promise<void> {
  const sql = `
SELECT column_name, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'people'
ORDER BY ordinal_position;`.trim()

  const { ok, status, body } = await managementApiQuery(sql)
  if (!ok) throw new Error(`SCHEMA GATE FAILED: Management API query failed, HTTP ${status}: ${JSON.stringify(body)}`)

  const liveColumns = body as LiveColumn[]
  const byName = new Map(liveColumns.map((c) => [c.column_name, c]))

  console.log('[schema-gate] live public.people columns (readback):')
  for (const c of liveColumns) console.log(`  ${c.column_name}: ${c.data_type}${c.udt_name !== c.data_type ? ` (${c.udt_name})` : ''}`)

  const problems: string[] = []
  for (const expected of EXPECTED_COLUMNS) {
    const live = byName.get(expected.name)
    if (!live) {
      problems.push(`MISSING column "${expected.name}"`)
      continue
    }
    if (live.data_type !== expected.dataType) {
      problems.push(`TYPE MISMATCH "${expected.name}": expected data_type=${expected.dataType}, got ${live.data_type}`)
      continue
    }
    if (expected.udtName && live.udt_name !== expected.udtName) {
      problems.push(`ENUM MISMATCH "${expected.name}": expected udt_name=${expected.udtName}, got ${live.udt_name}`)
    }
  }

  if (problems.length > 0) {
    throw new Error(`SCHEMA GATE FAILED:\n  ${problems.join('\n  ')}`)
  }
  console.log(`[schema-gate] OK -- all ${EXPECTED_COLUMNS.length} toInsertPayload columns present with expected types`)
}

// ---------------------------------------------------------------------------
// Step 2 -- prod people-count precondition
// ---------------------------------------------------------------------------

async function peopleCountGate(admin: SupabaseClient): Promise<void> {
  const { count, error } = await admin.from('people').select('id', { count: 'exact', head: true })
  if (error) throw new Error(`PEOPLE COUNT GATE FAILED: ${error.message}`)
  console.log(`[people-count-gate] current prod people count: ${count}`)
  if (count !== 0) {
    const { data: sample } = await admin.from('people').select('id, phone_e164, created_at').limit(10)
    console.error('[people-count-gate] SAMPLE of unexpected existing rows:', JSON.stringify(sample, null, 2))
    throw new Error(`PEOPLE COUNT GATE FAILED: expected 0, got ${count}. STOP -- do not proceed, investigate first.`)
  }
  console.log('[people-count-gate] OK -- prod people table is empty, matching the S6-T3 migration baseline')
}

// ---------------------------------------------------------------------------
// Step 3 -- fresh pre-commit dry-run gate
// ---------------------------------------------------------------------------

function tallyConsent(rows: ClassifiedRow[]) {
  const consent = { granted: 0, refused: 0, unknown: 0 }
  for (const r of rows) consent[r.data.photo_consent_state]++
  return consent
}

function tallyPublishConsent(rows: ClassifiedRow[]) {
  const publish = { true: 0, false: 0 }
  for (const r of rows) publish[r.data.photo_publish_consent ? 'true' : 'false']++
  return publish
}

async function freshDryRunGate(admin: SupabaseClient, adminId: string, fileBuffer: Buffer): Promise<ClassifiedRow[]> {
  const outcome = await runImportDryRun(
    { fileBuffer, filename: 'legacy-roster-corrected.xlsx', actorUserId: adminId, ipAddress: null, userAgent: null },
    admin,
  )
  if (!outcome.ok) {
    throw new Error(`FRESH DRY-RUN GATE FAILED: ${outcome.error} -- ${JSON.stringify(outcome)}`)
  }

  const { result } = outcome
  console.log(`[fresh-dry-run] importId=${outcome.importId} totalRows=${result.totalRows}`)
  console.log('[fresh-dry-run] classificationCounts:', JSON.stringify(result.classificationCounts))

  const allNullBirthDate = result.rows.filter((r) => r.data.birth_date === null).length
  const allConsent = tallyConsent(result.rows)
  console.log(`[fresh-dry-run] all-${result.totalRows}-rows continuity check: nullBirthDate=${allNullBirthDate} consent=${JSON.stringify(allConsent)}`)

  const problems: string[] = []
  if (result.totalRows !== EXPECTED_ALL_ROWS.totalRows) problems.push(`totalRows: expected ${EXPECTED_ALL_ROWS.totalRows}, got ${result.totalRows}`)
  for (const key of Object.keys(EXPECTED_ALL_ROWS.classificationCounts) as (keyof ClassificationCounts)[]) {
    if (result.classificationCounts[key] !== EXPECTED_ALL_ROWS.classificationCounts[key]) {
      problems.push(`classificationCounts.${key}: expected ${EXPECTED_ALL_ROWS.classificationCounts[key]}, got ${result.classificationCounts[key]}`)
    }
  }
  if (allNullBirthDate !== EXPECTED_ALL_ROWS.nullBirthDate) problems.push(`all-rows nullBirthDate: expected ${EXPECTED_ALL_ROWS.nullBirthDate}, got ${allNullBirthDate}`)
  if (JSON.stringify(allConsent) !== JSON.stringify(EXPECTED_ALL_ROWS.consent)) {
    problems.push(`all-rows consent: expected ${JSON.stringify(EXPECTED_ALL_ROWS.consent)}, got ${JSON.stringify(allConsent)}`)
  }

  const newRows = result.rows.filter((r) => r.rowClass === 'new')
  const newNullBirthDate = newRows.filter((r) => r.data.birth_date === null).length
  const newConsent = tallyConsent(newRows)
  const newPublish = tallyPublishConsent(newRows)
  console.log(
    `[fresh-dry-run] 'new'-subset (${newRows.length} rows, the ones that will actually insert): ` +
      `nullBirthDate=${newNullBirthDate} consent=${JSON.stringify(newConsent)} publishConsent=${JSON.stringify(newPublish)}`,
  )

  if (newRows.length !== EXPECTED_NEW_SUBSET.count) problems.push(`new-subset count: expected ${EXPECTED_NEW_SUBSET.count}, got ${newRows.length}`)
  if (newNullBirthDate !== EXPECTED_NEW_SUBSET.nullBirthDate) problems.push(`new-subset nullBirthDate: expected ${EXPECTED_NEW_SUBSET.nullBirthDate}, got ${newNullBirthDate}`)
  if (JSON.stringify(newConsent) !== JSON.stringify(EXPECTED_NEW_SUBSET.consent)) {
    problems.push(`new-subset consent: expected ${JSON.stringify(EXPECTED_NEW_SUBSET.consent)}, got ${JSON.stringify(newConsent)}`)
  }
  if (JSON.stringify(newPublish) !== JSON.stringify(EXPECTED_NEW_SUBSET.publishConsent)) {
    problems.push(`new-subset publishConsent: expected ${JSON.stringify(EXPECTED_NEW_SUBSET.publishConsent)}, got ${JSON.stringify(newPublish)}`)
  }

  if (problems.length > 0) {
    throw new Error(`FRESH DRY-RUN GATE FAILED (prod state or file has drifted since T5/this session -- do not override):\n  ${problems.join('\n  ')}`)
  }
  console.log('[fresh-dry-run] GATE OK -- fresh numbers match the expected 188/3/0/0/0 + 188-subset consent/birthdate exactly')
  return newRows
}

// ---------------------------------------------------------------------------
// Step 4 -- the commit
// ---------------------------------------------------------------------------

async function stepCommit(admin: SupabaseClient, adminId: string, fileBuffer: Buffer) {
  const outcome = await runImportCommit(
    { fileBuffer, filename: 'legacy-roster-corrected.xlsx', actorUserId: adminId, ipAddress: null, userAgent: null },
    admin,
  )
  if (!outcome.ok) {
    throw new Error(`COMMIT FAILED: ${outcome.error} -- ${JSON.stringify(outcome)}`)
  }
  console.log(`[commit] importId=${outcome.importId}`)
  console.log('[commit] result:', JSON.stringify(outcome.result, null, 2))
  if (outcome.result.raced > 0) {
    console.warn(`[commit] WARNING: raced=${outcome.result.raced} -- inserted (${outcome.result.inserted}) is LESS than attempted (${outcome.result.attempted}). Post-commit numeric assertions below are reconciled against 'inserted', not the hardcoded 188.`)
  }
  return outcome
}

// ---------------------------------------------------------------------------
// Step 5 -- post-commit independent verify
// ---------------------------------------------------------------------------

async function postCommitVerify(admin: SupabaseClient, importId: string, insertedCount: number, freshNewRows: ClassifiedRow[]) {
  const { data: auditRows, error: auditErr } = await admin
    .from('audit_log')
    .select('details_json')
    .eq('entity_type', 'import')
    .eq('entity_id', importId)
    .eq('action', 'import.commit')
  if (auditErr) throw new Error(`POST-COMMIT VERIFY FAILED: audit_log read: ${auditErr.message}`)
  if (!auditRows || auditRows.length !== 1) throw new Error(`POST-COMMIT VERIFY FAILED: expected exactly 1 import.commit audit row for ${importId}, got ${auditRows?.length ?? 0}`)

  const insertedIds = (auditRows[0].details_json as { inserted_ids: string[] }).inserted_ids
  console.log(`[post-commit] audit row inserted_ids.length=${insertedIds.length}`)
  if (insertedIds.length !== insertedCount) {
    throw new Error(`POST-COMMIT VERIFY FAILED: audit inserted_ids.length=${insertedIds.length} != commit result.inserted=${insertedCount}`)
  }

  const { count: totalCount, error: countErr } = await admin.from('people').select('id', { count: 'exact', head: true })
  if (countErr) throw new Error(`POST-COMMIT VERIFY FAILED: count query: ${countErr.message}`)
  console.log(`[post-commit] people total count: ${totalCount}`)
  if (totalCount !== insertedCount) {
    throw new Error(`POST-COMMIT VERIFY FAILED: people count=${totalCount}, expected ${insertedCount} (this commit's own 'inserted' number -- baseline was asserted 0 pre-commit)`)
  }
  if (insertedCount === EXPECTED_NEW_SUBSET.count) {
    console.log(`[post-commit] OK -- count matches the expected no-race number (${EXPECTED_NEW_SUBSET.count})`)
  } else {
    console.warn(`[post-commit] count=${insertedCount} differs from the expected no-race number (${EXPECTED_NEW_SUBSET.count}) -- a race occurred (see [commit] WARNING above). Consent/birthdate assertions below are SKIPPED; recount and reconcile manually.`)
    return
  }

  const consentCounts: Record<'granted' | 'refused' | 'unknown', number> = { granted: 0, refused: 0, unknown: 0 }
  for (const state of ['granted', 'refused', 'unknown'] as const) {
    const { count, error } = await admin.from('people').select('id', { count: 'exact', head: true }).eq('photo_consent_state', state)
    if (error) throw new Error(`POST-COMMIT VERIFY FAILED: consent count (${state}): ${error.message}`)
    consentCounts[state] = count ?? 0
  }
  console.log('[post-commit] photo_consent_state distribution:', JSON.stringify(consentCounts))
  if (JSON.stringify(consentCounts) !== JSON.stringify(EXPECTED_NEW_SUBSET.consent)) {
    throw new Error(`POST-COMMIT VERIFY FAILED: consent distribution mismatch. Expected ${JSON.stringify(EXPECTED_NEW_SUBSET.consent)}, got ${JSON.stringify(consentCounts)}`)
  }

  const { count: publishTrue, error: pubErr } = await admin.from('people').select('id', { count: 'exact', head: true }).eq('photo_publish_consent', true)
  if (pubErr) throw new Error(`POST-COMMIT VERIFY FAILED: publish_consent count: ${pubErr.message}`)
  console.log(`[post-commit] photo_publish_consent=true count: ${publishTrue}`)
  if (publishTrue !== EXPECTED_NEW_SUBSET.publishConsent.true) {
    throw new Error(`POST-COMMIT VERIFY FAILED: publish_consent=true expected ${EXPECTED_NEW_SUBSET.publishConsent.true}, got ${publishTrue}`)
  }

  const { count: birthNull, error: birthErr } = await admin.from('people').select('id', { count: 'exact', head: true }).is('birth_date', null)
  if (birthErr) throw new Error(`POST-COMMIT VERIFY FAILED: birth_date null count: ${birthErr.message}`)
  console.log(`[post-commit] birth_date IS NULL count: ${birthNull}`)
  if (birthNull !== EXPECTED_NEW_SUBSET.nullBirthDate) {
    throw new Error(`POST-COMMIT VERIFY FAILED: birth_date null count expected ${EXPECTED_NEW_SUBSET.nullBirthDate}, got ${birthNull}`)
  }

  const grantedFresh = freshNewRows.find((r) => r.data.photo_consent_state === 'granted')
  const refusedFresh = freshNewRows.find((r) => r.data.photo_consent_state === 'refused')
  for (const [label, fresh] of [['granted', grantedFresh], ['refused', refusedFresh]] as const) {
    if (!fresh || !fresh.phone_e164) continue
    const { data: row, error } = await admin
      .from('people')
      .select('full_name, photo_consent_state, photo_publish_consent')
      .eq('phone_e164', fresh.phone_e164)
      .maybeSingle()
    if (error) throw new Error(`POST-COMMIT VERIFY FAILED: spot-check (${label}): ${error.message}`)
    console.log(`[post-commit] spot-check ${label}: ${JSON.stringify(row)}`)
    if (row?.photo_consent_state !== label) {
      throw new Error(`POST-COMMIT VERIFY FAILED: spot-check ${label} row reads photo_consent_state=${row?.photo_consent_state}`)
    }
  }

  console.log('[post-commit] ALL CHECKS OK -- verified:live')
}

// ---------------------------------------------------------------------------
// Step 6 -- rollback (hard DELETE of the inserted_ids batch -- see plan
// Catch 2: these are brand-new rows written to a table that was empty
// immediately beforehand, with zero attendance/event_invitations rows
// possibly referencing them (verified below, not assumed), so a true
// baseline restore to 0 is both correct and safe here. anonymize_person
// (the S6-T4 retention primitive) is for scrubbing PII on rows with real
// history to preserve -- wrong tool for undoing a botched first write with
// no history yet.)
// ---------------------------------------------------------------------------

async function stepRollback(admin: SupabaseClient, importId: string, confirmed: boolean, adminEmail: string) {
  const { data: auditRows, error: auditErr } = await admin
    .from('audit_log')
    .select('details_json')
    .eq('entity_type', 'import')
    .eq('entity_id', importId)
    .eq('action', 'import.commit')
  if (auditErr) throw new Error(`ROLLBACK FAILED: audit_log read: ${auditErr.message}`)
  if (!auditRows || auditRows.length !== 1) throw new Error(`ROLLBACK FAILED: expected exactly 1 import.commit audit row for ${importId}, got ${auditRows?.length ?? 0}`)

  const insertedIds = (auditRows[0].details_json as { inserted_ids: string[] }).inserted_ids
  console.log(`[rollback] target importId=${importId}, inserted_ids.length=${insertedIds.length}`)

  const { count: attendanceCount, error: attErr } = await admin
    .from('attendance')
    .select('id', { count: 'exact', head: true })
    .in('person_id', insertedIds)
  if (attErr) throw new Error(`ROLLBACK FAILED: attendance safety check: ${attErr.message}`)
  const { count: inviteCount, error: invErr } = await admin
    .from('event_invitations')
    .select('id', { count: 'exact', head: true })
    .in('person_id', insertedIds)
  if (invErr) throw new Error(`ROLLBACK FAILED: event_invitations safety check: ${invErr.message}`)
  if ((attendanceCount ?? 0) > 0 || (inviteCount ?? 0) > 0) {
    throw new Error(
      `ROLLBACK REFUSED: ${attendanceCount} attendance row(s) and ${inviteCount} event_invitations row(s) already ` +
        `reference these people. Hard DELETE would destroy real history -- this needs a human decision, not this script.`,
    )
  }
  console.log('[rollback] safety check OK -- zero attendance/event_invitations rows reference these ids')

  const { data: preview } = await admin.from('people').select('id, full_name, phone_e164').in('id', insertedIds).limit(5)
  console.log(`[rollback] preview (first 5 of ${insertedIds.length}):`, JSON.stringify(preview, null, 2))

  if (!confirmed) {
    console.log('[rollback] preview-only -- pass --confirm-rollback to actually delete. Nothing was modified.')
    return
  }

  const adminId = await resolveAdminActor(admin, adminEmail)

  const { data: deleted, error: delErr } = await admin.from('people').delete().in('id', insertedIds).select('id')
  if (delErr) throw new Error(`ROLLBACK FAILED: delete: ${delErr.message}`)
  const deletedIds = (deleted ?? []).map((r) => r.id as string)
  console.log(`[rollback] deleted ${deletedIds.length} of ${insertedIds.length} rows`)
  if (deletedIds.length !== insertedIds.length) {
    console.warn(`[rollback] WARNING: deleted count != inserted_ids count -- some rows were already gone (manually deleted?). Investigate before treating rollback as complete.`)
  }

  await logAudit(
    {
      actorUserId: adminId,
      action: AUDIT_ACTIONS.IMPORT_ROLLBACK,
      entityType: 'import',
      entityId: importId,
      detailsJson: { original_import_id: importId, rolled_back_ids: deletedIds, rolled_back_count: deletedIds.length },
      ipAddress: null,
      userAgent: null,
    },
    admin,
  )

  const { count: totalAfter, error: countErr } = await admin.from('people').select('id', { count: 'exact', head: true })
  if (countErr) throw new Error(`ROLLBACK FAILED: post-rollback recount: ${countErr.message}`)
  console.log(`[rollback] people total count after rollback: ${totalAfter}`)
  if (totalAfter !== 0) {
    throw new Error(`ROLLBACK VERIFY FAILED: expected people count 0 after rollback (T6 is the only write to prod people), got ${totalAfter}. Investigate.`)
  }
  console.log('[rollback] OK -- baseline restored to 0, one import.rollback audit row written')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2)
  const confirmCommit = args.includes('--confirm-commit') || process.env.COMMIT_CONFIRM === 'yes'
  const rollbackIdx = args.indexOf('--rollback')
  const rollbackImportId = rollbackIdx >= 0 ? args[rollbackIdx + 1] : null
  const confirmRollback = args.includes('--confirm-rollback') || process.env.ROLLBACK_CONFIRM === 'yes'

  console.log('=== S6-T6 import-commit -- startup guards ===')
  assertPhoneUtilTrustworthy()
  assertEnvGuards()
  const adminEmail = resolveAdminEmailArg(args)

  const admin = getServiceClient()

  if (rollbackImportId) {
    console.log(`\n=== ROLLBACK mode: importId=${rollbackImportId} confirmed=${confirmRollback} ===`)
    await stepRollback(admin, rollbackImportId, confirmRollback, adminEmail)
    return
  }

  assertFilePathLocked()
  const fileBuffer = readFileSync(FILE_PATH)

  console.log('\n=== Preflight (always runs, read-only) ===')
  await schemaGate()
  await peopleCountGate(admin)

  const adminId = await resolveAdminActor(admin, adminEmail)

  console.log('\n=== Fresh pre-commit dry-run gate ===')
  const freshNewRows = await freshDryRunGate(admin, adminId, fileBuffer)

  if (!confirmCommit) {
    console.log('\nNo --confirm-commit / COMMIT_CONFIRM=yes given -- preflight + fresh dry-run gate complete, both passed. Nothing was written to people. Exiting.')
    return
  }

  console.log('\n=== ARMED: committing ===')
  const commitOutcome = await stepCommit(admin, adminId, fileBuffer)

  console.log('\n=== Post-commit independent verify ===')
  await postCommitVerify(admin, commitOutcome.importId, commitOutcome.result.inserted, freshNewRows)

  console.log('\n=== DONE ===')
  console.log(`importId=${commitOutcome.importId} -- keep this for rollback if needed: --rollback ${commitOutcome.importId}`)
}

main().catch((err) => {
  console.error('')
  console.error('FATAL:', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
