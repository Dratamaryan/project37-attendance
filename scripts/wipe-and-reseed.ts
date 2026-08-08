/**
 * S6-T2 — Prod full wipe + reseed 2 real events + materialize (S6/D1).
 *
 * Run:
 *   Read-only preflight (no writes, always safe to run):
 *     npx tsx --env-file .env.local scripts/wipe-and-reseed.ts
 *   Armed (destructive — wipes ALL people/attendance/event_invitations/events/
 *   event_instances, reseeds Project Day + Tribe Connect, materializes instances):
 *     npx tsx --env-file .env.local scripts/wipe-and-reseed.ts --confirm
 *     (or WIPE_CONFIRM=yes npx tsx --env-file .env.local scripts/wipe-and-reseed.ts)
 *
 * Three-step structure (architect-approved 2026-08-08, docs/sprint-6-task-2-verify.md):
 *   Step 0 — read-only preflight: both env guards, run-once guard, capture-then-
 *            reuse snapshot of the 2 real events (closes the event_type/start_date/
 *            duration_min/location/description gap T1 never dumped), cross-checks
 *            against S6/D1's stated RRULE/start_time, admin created_by resolution
 *            cross-checked against the known UUID, live schema gate on `events`,
 *            G1 (inbound-FK completeness to people/events) and G2 (audit_log.action
 *            free-text confirmation) via the Management API, before-counts, and a
 *            local gitignored data dump of the 5 wiped tables.
 *   Step 1 — WIPE: ONE atomic transaction (DELETE events, DELETE people, one
 *            data.wipe audit row, in-transaction assert, COMMIT or ROLLBACK) sent
 *            as a single multi-statement body to the Supabase Management API
 *            (POST /v1/projects/{ref}/database/query). Mid-body-error rollback was
 *            proven live against prod on 2026-08-08 with a throwaway probe table
 *            (create+insert+error in one call → nothing persisted, cross-session
 *            checked). No new dependency, no new secret — reuses SUPABASE_ACCESS_TOKEN.
 *   Step 2 — RESEED: native supabase-js .insert([...]) of the 2 real events using
 *            the Step-0 snapshot values. id/created_at/updated_at omitted — fresh
 *            UUIDs are correct, the old ones must not be resurrected. Single insert
 *            call for both rows (all-or-nothing). Fires 2 event.create audit rows
 *            via the app's own logAudit() helper.
 *   Step 3 — MATERIALIZE: direct import of the same materializeEvents() the deployed
 *            /api/cron/materialize-events route calls — reused, not reinvented.
 *
 * Run-once guard is NOT overridable by --confirm. G1/G2 failures are NOT overridable
 * by --confirm either — they abort before Step 1 regardless.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { materializeEvents } from '../lib/events/materialize.impl'
import { AUDIT_ACTIONS, logAudit } from '../lib/audit'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PROJECT_REF = 'bftifxgdcmisasgvobuf'
const ADMIN_EMAIL = 'ashblazerr@gmail.com'
const ADMIN_UUID_EXPECTED = 'ea742388-4af3-4e08-ab60-0354d068a949'
const PROJECT_DAY_ID = '4b22f198-2b34-45ad-a9d5-9c6453bf4173'
const TRIBE_CONNECT_ID = '74e494bd-4473-4bd2-ba2c-d9e9faf13e81'
const PROJECT_DAY_RRULE = 'FREQ=MONTHLY;BYDAY=2FR'
const TRIBE_CONNECT_RRULE = 'FREQ=MONTHLY;BYDAY=1SU'
const PROJECT_DAY_START_TIME = '18:00:00'
const TRIBE_CONNECT_START_TIME = '15:00:00'

const WIPED_TABLES = ['people', 'attendance', 'event_invitations', 'events', 'event_instances'] as const
const PRESERVED_TABLES = ['parishes', 'app_users', 'app_settings', 'audit_log', 'system_health'] as const

type Counts = Record<string, number>

// ---------------------------------------------------------------------------
// Env / client setup
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var: ${name}`)
  return v
}

function assertEnvGuards() {
  const url = requireEnv('NEXT_PUBLIC_SUPABASE_URL')
  if (!url.includes(PROJECT_REF)) {
    throw new Error(
      `ENV GUARD FAILED: NEXT_PUBLIC_SUPABASE_URL does not resolve to prod (${PROJECT_REF}). Got: ${url}`
    )
  }

  const linkedRefPath = path.resolve(__dirname, '../supabase/.temp/project-ref')
  if (!existsSync(linkedRefPath)) {
    throw new Error(`ENV GUARD FAILED: ${linkedRefPath} not found — run "supabase link" against prod first.`)
  }
  const linkedRef = readFileSync(linkedRefPath, 'utf8').trim()
  if (linkedRef !== PROJECT_REF) {
    throw new Error(`ENV GUARD FAILED: linked project-ref is "${linkedRef}", expected "${PROJECT_REF}".`)
  }

  console.log(`[env-guard] OK — NEXT_PUBLIC_SUPABASE_URL and supabase/.temp/project-ref both resolve to ${PROJECT_REF}`)
}

function getAdminClient(): SupabaseClient {
  const url = requireEnv('NEXT_PUBLIC_SUPABASE_URL')
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY')
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
}

// ---------------------------------------------------------------------------
// Management API (raw SQL) — used ONLY for the Step 1 atomic transaction and the
// read-only G1/G2 introspection queries that need pg_catalog / information_schema
// (not exposed via PostgREST — confirmed in T1).
// ---------------------------------------------------------------------------

async function managementApiQuery(sql: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  const token = requireEnv('SUPABASE_ACCESS_TOKEN')
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
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

// ---------------------------------------------------------------------------
// Step 0 — read-only preflight
// ---------------------------------------------------------------------------

async function captureCounts(admin: SupabaseClient): Promise<Counts> {
  const counts: Counts = {}
  for (const table of [...WIPED_TABLES, ...PRESERVED_TABLES]) {
    const { count, error } = await admin.from(table).select('*', { count: 'exact', head: true })
    if (error) throw new Error(`Failed to count ${table}: ${error.message}`)
    counts[table] = count ?? 0
  }
  return counts
}

async function runOnceGuard(admin: SupabaseClient) {
  const { data, error } = await admin.from('events').select('name, recurrence_rule')
  if (error) throw new Error(`Run-once guard query failed: ${error.message}`)

  if (data && data.length === 2) {
    const pd = data.find((e) => e.name === 'Project Day')
    const tc = data.find((e) => e.name === 'Tribe Connect')
    if (pd?.recurrence_rule === PROJECT_DAY_RRULE && tc?.recurrence_rule === TRIBE_CONNECT_RRULE) {
      throw new Error(
        'RUN-ONCE GUARD TRIPPED: events already shows the reseeded signature (exactly 2 rows, ' +
          'Project Day + Tribe Connect, matching RRULEs). Refusing to run again — this is not ' +
          'overridable by --confirm. A second legitimate wipe is a distinct decision, not a re-run.'
      )
    }
  }
  console.log('[run-once-guard] OK — no reseeded signature detected, safe to proceed')
}

type EventSnapshot = {
  id: string
  name: string
  name_id: string | null
  event_type: string
  start_date: string
  start_time: string
  duration_min: number
  location: string | null
  description: string | null
  recurrence_rule: string | null
  active: boolean
}

async function captureEventSnapshot(admin: SupabaseClient, id: string): Promise<EventSnapshot> {
  const { data, error } = await admin.from('events').select('*').eq('id', id).maybeSingle()
  if (error) throw new Error(`Failed to capture event snapshot ${id}: ${error.message}`)
  if (!data) throw new Error(`CROSS-CHECK FAILED: event id ${id} not found live — T1 ground truth has drifted.`)
  return data as EventSnapshot
}

function crossCheckEventDef(snap: EventSnapshot, expectedName: string, expectedRRule: string, expectedStartTime: string) {
  const problems: string[] = []
  if (snap.name !== expectedName) problems.push(`name: expected "${expectedName}", got "${snap.name}"`)
  if (snap.recurrence_rule !== expectedRRule) {
    problems.push(`recurrence_rule: expected "${expectedRRule}", got "${snap.recurrence_rule}"`)
  }
  if (!snap.start_time?.startsWith(expectedStartTime)) {
    problems.push(`start_time: expected "${expectedStartTime}", got "${snap.start_time}"`)
  }
  if (!snap.active) problems.push(`active: expected true, got ${snap.active}`)
  if (problems.length > 0) {
    throw new Error(`CROSS-CHECK FAILED for "${expectedName}" (id ${snap.id}): ${problems.join('; ')}`)
  }
  console.log(`[cross-check] OK — "${expectedName}" matches expected RRULE/start_time/active live`)
}

async function resolveAdminActor(admin: SupabaseClient): Promise<string> {
  const { data, error } = await admin
    .from('app_users')
    .select('id, email, role, active')
    .eq('email', ADMIN_EMAIL)
    .maybeSingle()
  if (error) throw new Error(`Admin actor lookup failed: ${error.message}`)
  if (!data) throw new Error(`CROSS-CHECK FAILED: no app_users row for ${ADMIN_EMAIL}`)
  if (data.role !== 'admin' || !data.active) {
    throw new Error(`CROSS-CHECK FAILED: ${ADMIN_EMAIL} is not an active admin live (role=${data.role}, active=${data.active})`)
  }
  if (data.id !== ADMIN_UUID_EXPECTED) {
    throw new Error(`CROSS-CHECK FAILED: ${ADMIN_EMAIL} resolves to ${data.id}, expected ${ADMIN_UUID_EXPECTED}`)
  }
  console.log(`[admin-actor] OK — ${ADMIN_EMAIL} resolves to expected UUID ${ADMIN_UUID_EXPECTED}`)
  return data.id
}

async function schemaGateEvents(): Promise<string[]> {
  const url = requireEnv('NEXT_PUBLIC_SUPABASE_URL')
  // The OpenAPI introspection endpoint requires the service_role key on this
  // project (confirmed live — anon key gets a 401 "Only the service_role API
  // key can be used for this endpoint"), matching T1's method exactly.
  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY')
  const res = await fetch(`${url}/rest/v1/`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Accept: 'application/openapi+json' },
  })
  if (!res.ok) throw new Error(`Schema gate: OpenAPI introspection failed with status ${res.status}`)
  const doc = (await res.json()) as { definitions?: Record<string, { required?: string[] }> }
  const required = doc.definitions?.events?.required ?? []
  const mustHave = ['name', 'event_type', 'start_date', 'start_time', 'created_by']
  const missing = mustHave.filter((c) => !required.includes(c))
  if (missing.length > 0) {
    throw new Error(`SCHEMA GATE FAILED: events table is missing expected NOT NULL columns: ${missing.join(', ')}`)
  }
  console.log(`[schema-gate] OK — events.required (live) includes: ${required.join(', ')}`)
  return required
}

// --- G1: inbound-FK completeness to people/events -----------------------------

const G1_EXPECTED = [
  { referencing_table: 'attendance', col: 'person_id', referenced: 'people', del_code: 'a' },
  { referencing_table: 'event_invitations', col: 'person_id', referenced: 'people', del_code: 'a' },
  { referencing_table: 'event_instances', col: 'event_id', referenced: 'events', del_code: 'c' },
] as const

type FkRow = { conname: string; referencing_table: string; col: string; referenced: string; del_code: string }

async function g1InboundFkCheck(): Promise<{ ok: boolean; rows: FkRow[]; problems: string[] }> {
  const sql = `
select con.conname, rel.relname as referencing_table, att.attname as col,
       frel.relname as referenced, con.confdeltype as del_code
from pg_constraint con
join pg_class rel on rel.oid=con.conrelid
join pg_class frel on frel.oid=con.confrelid
join pg_attribute att on att.attrelid=con.conrelid and att.attnum=any(con.conkey)
where con.contype='f' and frel.relname in ('people','events');
  `.trim()

  const { ok, status, body } = await managementApiQuery(sql)
  if (!ok) throw new Error(`G1 query failed: HTTP ${status} — ${JSON.stringify(body)}`)
  const rows = body as FkRow[]

  const problems: string[] = []
  for (const exp of G1_EXPECTED) {
    const match = rows.find(
      (r) => r.referencing_table === exp.referencing_table && r.col === exp.col && r.referenced === exp.referenced
    )
    if (!match) {
      problems.push(`MISSING expected FK: ${exp.referencing_table}.${exp.col} -> ${exp.referenced}`)
    } else if (match.del_code !== exp.del_code) {
      problems.push(
        `DEL-CODE MISMATCH: ${exp.referencing_table}.${exp.col} -> ${exp.referenced} is "${match.del_code}", expected "${exp.del_code}"`
      )
    }
  }
  for (const r of rows) {
    const known = G1_EXPECTED.some(
      (exp) => exp.referencing_table === r.referencing_table && exp.col === r.col && exp.referenced === r.referenced
    )
    if (!known) {
      problems.push(
        `UNEXPECTED inbound FK: ${r.referencing_table}.${r.col} -> ${r.referenced} (del_code=${r.del_code}, constraint=${r.conname})`
      )
    }
  }

  return { ok: problems.length === 0, rows, problems }
}

// --- G2: audit_log.action free-text confirmation -------------------------------

async function g2AuditActionCheck(): Promise<{ ok: boolean; dataType: string | null; checkConstraints: string | null }> {
  const sql = `
select
  (select data_type from information_schema.columns where table_name='audit_log' and column_name='action') as data_type,
  (select string_agg(conname || ': ' || pg_get_constraintdef(oid), ' | ') from pg_constraint where conrelid = 'audit_log'::regclass and contype = 'c') as check_constraints;
  `.trim()

  const { ok, status, body } = await managementApiQuery(sql)
  if (!ok) throw new Error(`G2 query failed: HTTP ${status} — ${JSON.stringify(body)}`)
  const rows = body as Array<{ data_type: string | null; check_constraints: string | null }>
  const row = rows[0]
  const dataType = row?.data_type ?? null
  const checkConstraints = row?.check_constraints ?? null
  const freeText = dataType === 'text' || dataType === 'character varying'

  return { ok: freeText && checkConstraints === null, dataType, checkConstraints }
}

// --- pre-flight local data dump -------------------------------------------------

async function preflightDump(admin: SupabaseClient, before: Counts): Promise<string> {
  const dumpDir = path.resolve(__dirname, '.local-dumps')
  mkdirSync(dumpDir, { recursive: true })
  const runId = new Date().toISOString().replace(/[:.]/g, '-')
  const dumpPath = path.join(dumpDir, `pre-wipe-${runId}.json`)

  const dump: Record<string, unknown> = { runId, capturedAt: new Date().toISOString(), before }
  for (const table of WIPED_TABLES) {
    const { data, error } = await admin.from(table).select('*')
    if (error) throw new Error(`Preflight dump failed for ${table}: ${error.message}`)
    dump[table] = data
  }
  writeFileSync(dumpPath, JSON.stringify(dump, null, 2))
  console.log(`[preflight-dump] wrote ${dumpPath}`)
  return dumpPath
}

// ---------------------------------------------------------------------------
// Step 1 — WIPE (one atomic transaction via the Management API)
// ---------------------------------------------------------------------------

function buildWipeSql(runId: string, adminId: string, before: Counts): string {
  return `
BEGIN;
DELETE FROM events;
DELETE FROM people;
SELECT log_audit(
  p_actor_user_id => '${adminId}'::uuid,
  p_action => 'data.wipe',
  p_entity_type => 'system',
  p_entity_id => '${runId}',
  p_details_json => jsonb_build_object(
    'people', ${before.people}, 'attendance', ${before.attendance},
    'event_invitations', ${before.event_invitations}, 'events', ${before.events},
    'event_instances', ${before.event_instances}
  )
);
DO $$
DECLARE
  v_people int; v_attendance int; v_invitations int; v_events int; v_instances int;
  v_parishes int; v_app_users int; v_app_settings int; v_audit_log int; v_system_health int;
BEGIN
  SELECT count(*) INTO v_people FROM people;
  SELECT count(*) INTO v_attendance FROM attendance;
  SELECT count(*) INTO v_invitations FROM event_invitations;
  SELECT count(*) INTO v_events FROM events;
  SELECT count(*) INTO v_instances FROM event_instances;
  SELECT count(*) INTO v_parishes FROM parishes;
  SELECT count(*) INTO v_app_users FROM app_users;
  SELECT count(*) INTO v_app_settings FROM app_settings;
  SELECT count(*) INTO v_audit_log FROM audit_log;
  SELECT count(*) INTO v_system_health FROM system_health;

  IF v_people != 0 THEN RAISE EXCEPTION 'assert failed: people=% expected 0', v_people; END IF;
  IF v_attendance != 0 THEN RAISE EXCEPTION 'assert failed: attendance=% expected 0', v_attendance; END IF;
  IF v_invitations != 0 THEN RAISE EXCEPTION 'assert failed: event_invitations=% expected 0', v_invitations; END IF;
  IF v_events != 0 THEN RAISE EXCEPTION 'assert failed: events=% expected 0', v_events; END IF;
  IF v_instances != 0 THEN RAISE EXCEPTION 'assert failed: event_instances=% expected 0', v_instances; END IF;
  -- Strict tripwires: these tables see near-zero write traffic outside admin
  -- actions, so any drift at all is suspicious.
  IF v_parishes != ${before.parishes} THEN RAISE EXCEPTION 'assert failed: parishes=% expected ${before.parishes}', v_parishes; END IF;
  IF v_app_users != ${before.app_users} THEN RAISE EXCEPTION 'assert failed: app_users=% expected ${before.app_users}', v_app_users; END IF;
  IF v_app_settings != ${before.app_settings} THEN RAISE EXCEPTION 'assert failed: app_settings=% expected ${before.app_settings}', v_app_settings; END IF;
  -- Relaxed to >=: the heartbeat cron (and materialize-events' own health row)
  -- write system_health independently of this transaction (~20/day); audit_log
  -- gets this txn's own 1 data.wipe row plus whatever else is legitimately
  -- happening concurrently. A monotonic floor still catches any row going
  -- missing, which is what actually matters here.
  IF v_system_health < ${before.system_health} THEN RAISE EXCEPTION 'assert failed: system_health=% expected >= ${before.system_health}', v_system_health; END IF;
  IF v_audit_log < ${before.audit_log + 1} THEN RAISE EXCEPTION 'assert failed: audit_log=% expected >= ${before.audit_log + 1}', v_audit_log; END IF;
END $$;
COMMIT;
  `.trim()
}

async function stepOneWipe(admin: SupabaseClient, adminId: string, before: Counts): Promise<Counts> {
  const runId = randomUUID()
  const sql = buildWipeSql(runId, adminId, before)

  console.log('[step-1] sending wipe transaction to the Management API...')
  const { ok, status, body } = await managementApiQuery(sql)
  if (!ok) {
    throw new Error(`STEP 1 WIPE FAILED (rolled back — nothing changed): HTTP ${status} — ${JSON.stringify(body)}`)
  }
  console.log('[step-1] Management API reported success — independently re-verifying via supabase-js...')

  const after: Counts = {}
  for (const table of [...WIPED_TABLES, ...PRESERVED_TABLES]) {
    const { count, error } = await admin.from(table).select('*', { count: 'exact', head: true })
    if (error) throw new Error(`Post-wipe recount failed for ${table}: ${error.message}`)
    after[table] = count ?? 0
  }
  for (const table of WIPED_TABLES) {
    if (after[table] !== 0) throw new Error(`POST-WIPE VERIFY FAILED: ${table}=${after[table]}, expected 0`)
  }
  // Strict tripwires — near-zero write traffic outside admin actions.
  for (const table of ['parishes', 'app_users', 'app_settings']) {
    if (after[table] !== before[table]) {
      throw new Error(`POST-WIPE VERIFY FAILED: ${table}=${after[table]}, expected unchanged ${before[table]}`)
    }
  }
  // Relaxed to >=: heartbeat cron + this txn's own audit row both write
  // independently of the wipe's correctness (see buildWipeSql comment).
  if (after.system_health < before.system_health) {
    throw new Error(`POST-WIPE VERIFY FAILED: system_health=${after.system_health}, expected >= ${before.system_health}`)
  }
  if (after.audit_log < before.audit_log + 1) {
    throw new Error(`POST-WIPE VERIFY FAILED: audit_log=${after.audit_log}, expected >= ${before.audit_log + 1}`)
  }
  console.log('[step-1] OK — independent recount confirms wipe end-state')
  return after
}

// ---------------------------------------------------------------------------
// Step 2 — RESEED (native supabase-js insert, no raw SQL)
// ---------------------------------------------------------------------------

async function stepTwoReseed(admin: SupabaseClient, adminId: string, pd: EventSnapshot, tc: EventSnapshot) {
  const rows = [
    {
      name: 'Project Day',
      name_id: pd.name_id,
      event_type: pd.event_type,
      start_date: pd.start_date,
      start_time: PROJECT_DAY_START_TIME,
      duration_min: pd.duration_min,
      location: pd.location,
      description: pd.description,
      recurrence_rule: PROJECT_DAY_RRULE,
      active: true,
      created_by: adminId,
    },
    {
      name: 'Tribe Connect',
      name_id: tc.name_id,
      event_type: tc.event_type,
      start_date: tc.start_date,
      start_time: TRIBE_CONNECT_START_TIME,
      duration_min: tc.duration_min,
      location: tc.location,
      description: tc.description,
      recurrence_rule: TRIBE_CONNECT_RRULE,
      active: true,
      created_by: adminId,
    },
  ]

  const { data, error } = await admin.from('events').insert(rows).select('id, name')
  if (error) throw new Error(`STEP 2 RESEED FAILED: ${error.message}`)
  if (!data || data.length !== 2) throw new Error(`STEP 2 RESEED FAILED: expected 2 rows inserted, got ${data?.length ?? 0}`)

  for (const row of data) {
    await logAudit(
      {
        actorUserId: adminId,
        action: AUDIT_ACTIONS.EVENT_CREATE,
        entityType: 'events',
        entityId: row.id,
        detailsJson: { reseed_of: 'S6/D1', name: row.name },
      },
      admin
    )
  }

  console.log(`[step-2] OK — reseeded ${data.map((r) => `${r.name} (${r.id})`).join(', ')}`)
  return data
}

// ---------------------------------------------------------------------------
// Step 3 — MATERIALIZE (direct import of the existing function)
// ---------------------------------------------------------------------------

async function stepThreeMaterialize(admin: SupabaseClient) {
  const result = await materializeEvents({ supabase: admin, now: new Date() })
  if (result.events_with_errors.length > 0) {
    throw new Error(`STEP 3 MATERIALIZE had errors: ${JSON.stringify(result.events_with_errors)}`)
  }
  if (result.instances_inserted <= 0) {
    throw new Error(`STEP 3 MATERIALIZE VERIFY FAILED: instances_inserted=${result.instances_inserted}, expected > 0`)
  }
  // 2 monthly events over the live horizon → ~1 occurrence/event/month, +/-1 for
  // month-boundary effects. Soft check only (log, don't fail) — an exact off-by-
  // one here is not a correctness bug, just worth surfacing for the verify report.
  const expectedMin = result.horizon_months * 2 - 4
  const expectedMax = result.horizon_months * 2 + 4
  const inRange = result.instances_inserted >= expectedMin && result.instances_inserted <= expectedMax
  console.log(
    `[step-3] ${inRange ? 'OK' : 'WARNING (out of expected range)'} — materialized ${result.instances_inserted} ` +
      `instances over ${result.horizon_months} months (expected ~${expectedMin}-${expectedMax} for 2 monthly events)`
  )
  return result
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const confirmed = process.argv.includes('--confirm') || process.env.WIPE_CONFIRM === 'yes'

  console.log('=== S6-T2 wipe-and-reseed — Step 0: read-only preflight ===')
  assertEnvGuards()
  const admin = getAdminClient()

  const before = await captureCounts(admin)
  console.log('[before-counts]', before)

  await runOnceGuard(admin)

  const pdSnapshot = await captureEventSnapshot(admin, PROJECT_DAY_ID)
  const tcSnapshot = await captureEventSnapshot(admin, TRIBE_CONNECT_ID)
  crossCheckEventDef(pdSnapshot, 'Project Day', PROJECT_DAY_RRULE, PROJECT_DAY_START_TIME)
  crossCheckEventDef(tcSnapshot, 'Tribe Connect', TRIBE_CONNECT_RRULE, TRIBE_CONNECT_START_TIME)

  const adminId = await resolveAdminActor(admin)
  const requiredCols = await schemaGateEvents()

  const g1 = await g1InboundFkCheck()
  console.log('[G1 inbound-FK check]', g1.ok ? 'OK' : 'FAILED')
  console.log('  rows:', JSON.stringify(g1.rows))
  if (!g1.ok) g1.problems.forEach((p) => console.error(`  - ${p}`))

  const g2 = await g2AuditActionCheck()
  console.log(
    '[G2 audit_log.action check]',
    g2.ok ? 'OK' : 'FAILED',
    `data_type=${g2.dataType}`,
    `check_constraints=${g2.checkConstraints}`
  )

  const dumpPath = await preflightDump(admin, before)

  console.log('')
  console.log('=== Preflight summary ===')
  console.log(
    JSON.stringify(
      { before, pdSnapshot, tcSnapshot, adminId, requiredCols, g1, g2, dumpPath },
      null,
      2
    )
  )

  if (!confirmed) {
    console.log('')
    console.log('No --confirm / WIPE_CONFIRM=yes given — read-only preflight complete. Nothing was modified. Exiting.')
    return
  }

  if (!g1.ok) {
    throw new Error('ABORTING: G1 failed — unexpected inbound FK(s). See preflight output above. Not proceeding to Step 1.')
  }
  if (!g2.ok) {
    throw new Error(
      'ABORTING: G2 failed — audit_log.action may reject "data.wipe". Needs an additive migration before the wipe can run. Not proceeding to Step 1.'
    )
  }

  console.log('')
  console.log('=== Step 1: WIPE (armed) ===')
  const afterWipe = await stepOneWipe(admin, adminId, before)

  console.log('')
  console.log('=== Step 2: RESEED ===')
  const reseeded = await stepTwoReseed(admin, adminId, pdSnapshot, tcSnapshot)

  console.log('')
  console.log('=== Step 3: MATERIALIZE ===')
  const materializeResult = await stepThreeMaterialize(admin)

  console.log('')
  console.log('=== DONE ===')
  console.log(JSON.stringify({ afterWipe, reseeded, materializeResult }, null, 2))
}

main().catch((err) => {
  console.error('')
  console.error('FATAL:', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
