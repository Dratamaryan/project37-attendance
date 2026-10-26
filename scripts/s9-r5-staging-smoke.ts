/**
 * S9-R5 — Staging smoke for RSVP retention (verification ladder rung 2).
 * Fully automated data path: no RSVP is typed into a page. Synthetic data
 * only: [SYNTH] names, fresh +62999 phones, staging accounts
 * (admin@example.com). Requires migration 20261026120000 on staging (setup
 * aborts if app_settings.rsvp_retention_days is missing).
 *
 * Four phases, run in order:
 *
 *   setup    1 [SYNTH] adhoc event + 1 COMPLETED instance ending
 *            rsvp_retention_days + 30 days ago (WIB) + 1 RSVP link.
 *            People (people.create audit): member A, roster person B
 *            (phone P_B), person D (phone P_D) then soft-deleted
 *            (people.soft_delete audit). Attendance for A, B and D.
 *            RSVPs inserted with the service role:
 *              a  member A, matched at submit             -> coming_came
 *              b  newcomer on P_B (B checked in)          -> coming_came, via phone
 *              c  newcomer on an unknown phone            -> maybe_no_show
 *              d  newcomer on P_D (D soft-deleted)        -> not_coming_no_show;
 *                 D's check-in stays a walk_in
 *            Snapshots the instance's rsvp_checkin_crosstab through an ADMIN
 *            session (the view is is_admin()-filtered — the service role
 *            reads 0 rows) plus each RSVP's updated_at, into the state file.
 *   drive    rpc run_rsvp_retention_pass (service role) and prints the
 *            returned count. THE PASS IS GLOBAL: any other eligible staging
 *            RSVP rows are scrubbed too (staging is synthetic-only, so this
 *            is acceptable — never point this at prod; the staging pin
 *            below refuses to).
 *   verify   a–d: phone NULL, name NULL, anonymized_at set, updated_at
 *            unchanged; b retained_person_id = B, a/c/d NULL; crosstab
 *            deep-equals the setup snapshot (admin session); exactly one
 *            rsvp.anonymize audit row for the instance with rows = 4; a
 *            second pass changes nothing on this instance (no row change,
 *            still one audit row).
 *   cleanup  attendance -> event (CASCADE: instance, link, RSVPs) -> assert
 *            zero RSVP rows (event_rsvps.person_id and retained_person_id are
 *            NO ACTION, so the people can go only after) -> delete the
 *            [SYNTH] people (data.wipe audit) -> assert zero residue.
 *
 * Run (tsc->node, compiled path — libphonenumber-js must not run under tsx):
 *   npx tsc -p scripts/tsconfig.s9-r5-smoke.json
 *   node --env-file=.env.staging.local scripts/.build/scripts/s9-r5-staging-smoke.js setup
 *   node --env-file=.env.staging.local scripts/.build/scripts/s9-r5-staging-smoke.js drive
 *   node --env-file=.env.staging.local scripts/.build/scripts/s9-r5-staging-smoke.js verify
 *   node --env-file=.env.staging.local scripts/.build/scripts/s9-r5-staging-smoke.js cleanup
 *
 * OWNER VISUAL CHECKS (staging branch Vercel deployment; any time after the
 * deploy, independent of the phases above):
 *   V1  /privacy in Indonesian: the line under the title reads "Versi: v2" -> PASS
 *   V2  the "Turnstile Privacy Addendum" link opens cloudflare.com in a NEW tab -> PASS
 *   V3  on an RSVP page, type a phone, click "Kebijakan Privasi": the policy
 *       opens in a NEW tab and the typed phone is still in the form -> PASS
 *
 * GUARDS (every phase, before any read or write):
 *   1. Shared preflight guard (branch <-> ref map).
 *   2. Staging pin: resolved ref must be exactly STAGING_REF — no local, no prod.
 *   3. Env URL ref must equal STAGING_REF (no split-brain).
 * setup additionally: no state file from an earlier run; every synthetic
 *   phone normalises to exactly itself, starts with +62999, and is absent
 *   from people and event_rsvps.
 * drive / verify / cleanup additionally: the state event is [SYNTH], the
 *   state instance still belongs to it, every state person is [SYNTH].
 *
 * STATE: scripts/.build/s9-r5-smoke-state.json (scripts/.build/ is
 * gitignored, mode 0600): run id, row ids, the crosstab snapshot (ids and
 * buckets only) and each RSVP's updated_at. No phones, names or secrets.
 *
 * SECRETS: none printed. The admin session comes from a magic-link token
 * minted with the service role (auth.admin.generateLink — sends no email)
 * and exchanged in-process; it is never written to disk.
 *
 * AUDIT (CLAUDE.md rule 6): people inserts log people.create, D's soft-delete
 * logs people.soft_delete, the cleanup hard-delete logs data.wipe (all
 * actorUserId = null — service_role/system path). event.create and
 * rsvp_link.create are logged on setup. The pass writes its own
 * rsvp.anonymize row. audit_log rows are append-only and excluded from the
 * residue check.
 */

import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { normalizePhone } from '../lib/utils/phone'
import { AUDIT_ACTIONS, logAudit, type AuditAction } from '../lib/audit'

const STAGING_REF = 'sijfyvaodqkawbeuyrpu'
const SOURCE = 's9-r5-staging-smoke'
const TAG = '[s9-r5-smoke]'
const STATE_PATH = path.resolve(process.cwd(), 'scripts/.build/s9-r5-smoke-state.json')
const SYNTH = '[SYNTH]'
const ADMIN_EMAIL = 'admin@example.com'

// ---------------------------------------------------------------------------
// Preflight guard — same preamble as scripts/s9-r2-staging-smoke.ts
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

async function runPreflightGuard(op: string): Promise<ResolvedRef> {
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
    console.error('=================== PREFLIGHT ABORT (s9-r5-staging-smoke) ===================')
    console.error(`  branch:        ${branch || '(empty/detached)'}`)
    console.error(`  op:            ${op}`)
    console.error(`  resolved ref:  ${resolved.ref ?? '(none)'} (local=${resolved.local})`)
    console.error(`  reason:        ${result.reason}`)
    console.error('==============================================================================')
    console.error('')
    process.exit(1)
  }
  console.log(`[preflight] OK -- branch=${branch} op=${op} ref=${resolved.ref} local=${resolved.local}`)
  return resolved
}

function abort(reason: string): never {
  console.error(`${TAG} ABORT: ${reason}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Synthetic fixture
// ---------------------------------------------------------------------------

type PhoneKey = 'A' | 'B' | 'C' | 'D'
const PHONE_KEYS: PhoneKey[] = ['A', 'B', 'C', 'D']
type RsvpKey = 'a' | 'b' | 'c' | 'd'
const RSVP_KEYS: RsvpKey[] = ['a', 'b', 'c', 'd']

/** Fresh synthetic phones in the +62999 shape, derived from the run id. */
function phonesFor(runId: number): Record<PhoneKey, string> {
  const out = {} as Record<PhoneKey, string>
  PHONE_KEYS.forEach((k, i) => {
    out[k] = `+62999${((runId + i) % 10_000_000).toString().padStart(7, '0')}`
  })
  return out
}

type CrosstabRow = {
  event_instance_id: string
  rsvp_id: string | null
  attendance_id: string | null
  resolved_person_id: string | null
  matched_at_submit: boolean
  rsvp_status: string | null
  children_count: number | null
  attended: boolean
  bucket: string
}

type State = {
  runId: number
  createdAt: string
  eventId: string
  instanceId: string
  linkId: string
  people: { A: string; B: string; D: string }
  rsvps: Record<RsvpKey, string>
  updatedAt: Record<RsvpKey, string>
  crosstab: CrosstabRow[] | null
  drivenAt: string | null
}

function readState(): State {
  if (!existsSync(STATE_PATH)) abort(`no state file at ${STATE_PATH} — run "setup" first`)
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8')) as State
  } catch {
    abort(`state file ${STATE_PATH} is unreadable`)
  }
}

function writeState(state: State): void {
  mkdirSync(path.dirname(STATE_PATH), { recursive: true })
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function audit(
  supabase: SupabaseClient,
  action: AuditAction,
  entityType: string,
  entityId: string,
): Promise<void> {
  await logAudit(
    { actorUserId: null, action, entityType, entityId, detailsJson: { source: SOURCE, synthetic: true } },
    supabase,
  )
}

async function insertOne(supabase: SupabaseClient, table: string, row: Record<string, unknown>): Promise<string> {
  const { data, error } = await supabase.from(table).insert(row).select('id').single()
  if (error || !data) throw new Error(`insert ${table} failed: ${error?.message ?? 'no row'}`)
  return (data as { id: string }).id
}

async function activeAppUserId(supabase: SupabaseClient, email: string): Promise<string> {
  const { data, error } = await supabase.from('app_users').select('id, active, role').eq('email', email).maybeSingle()
  if (error) throw new Error(`app_users lookup failed: ${error.message}`)
  const row = data as { id: string; active: boolean; role: string } | null
  if (!row || row.active !== true || row.role !== 'admin') {
    abort(`${email} missing, inactive or not admin in app_users — run scripts/s8-t7-seed-staging-identities.ts first`)
  }
  return row.id
}

async function countWhere(
  supabase: SupabaseClient,
  table: string,
  column: string,
  values: string[],
): Promise<number> {
  const ids = values.filter(v => v !== '')
  if (ids.length === 0) return 0
  const { count, error } = await supabase.from(table).select('id', { count: 'exact', head: true }).in(column, ids)
  if (error || count === null) throw new Error(`count ${table} failed: ${error?.message ?? 'null count'}`)
  return count
}

function assertSyntheticPhones(phones: Record<PhoneKey, string>): void {
  for (const k of PHONE_KEYS) {
    const p = phones[k]
    const n = normalizePhone(p, 'ID')
    if (!n.ok || n.e164 !== p || !p.startsWith('+62999')) {
      abort(`synthetic phone for ${k} failed normalisation or is outside +62999`)
    }
  }
}

/** 'YYYY-MM-DD' of the WIB calendar date `days` from now (negative = past). */
function wibDateInDays(days: number): string {
  const wib = new Date(Date.now() + days * 86_400_000 + 7 * 3_600_000) // shift so UTC fields = WIB
  return wib.toISOString().slice(0, 10)
}

type Env = { url: string; serviceKey: string; anonKey: string }

/**
 * Staging pin, on top of the shared preflight guard: the resolved ref and
 * the env Supabase URL must both point at staging.
 */
async function pinStaging(op: string): Promise<Env> {
  const resolved = await runPreflightGuard(op)
  if (resolved.local || resolved.ref !== STAGING_REF) {
    abort(`resolved ref ${resolved.ref ?? '(none)'} (local=${resolved.local}) is not staging (${STAGING_REF}) — refusing`)
  }
  console.log(`[staging-pin] OK -- ref=${resolved.ref}`)

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !serviceKey || !anonKey) {
    abort('missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY — pass --env-file explicitly')
  }
  let supabaseHost: string
  try {
    supabaseHost = new URL(url).hostname
  } catch {
    abort('NEXT_PUBLIC_SUPABASE_URL is not a URL')
  }
  if (supabaseHost !== `${STAGING_REF}.supabase.co`) abort(`env Supabase host ${supabaseHost} is not the staging project — refusing`)
  return { url, serviceKey, anonKey }
}

const serviceClient = (env: Env) =>
  createClient(env.url, env.serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })

/**
 * An in-memory admin session for admin@example.com: magic-link token minted
 * with the service role (no email is sent), exchanged on an anon client.
 */
async function adminSession(env: Env, service: SupabaseClient): Promise<SupabaseClient> {
  await activeAppUserId(service, ADMIN_EMAIL)
  const { data: link, error: linkErr } = await service.auth.admin.generateLink({ type: 'magiclink', email: ADMIN_EMAIL })
  if (linkErr) throw new Error(`generateLink failed: ${linkErr.message}`)
  const anon = createClient(env.url, env.anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { data, error } = await anon.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' })
  if (error) throw new Error(`verifyOtp failed: ${error.message}`)
  if (!data.session) throw new Error('verifyOtp returned no session')
  return createClient(env.url, env.anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
  })
}

async function readCrosstab(admin: SupabaseClient, instanceId: string): Promise<CrosstabRow[]> {
  const { data, error } = await admin
    .from('rsvp_checkin_crosstab')
    .select('*')
    .eq('event_instance_id', instanceId)
    .order('rsvp_id', { ascending: true, nullsFirst: true })
    .order('attendance_id', { ascending: true, nullsFirst: true })
  if (error) throw new Error(`crosstab read failed: ${error.message}`)
  return (data ?? []) as CrosstabRow[]
}

type RsvpRow = {
  id: string
  phone_e164: string | null
  name: string | null
  person_id: string | null
  retained_person_id: string | null
  anonymized_at: string | null
  updated_at: string
}

async function readRsvps(service: SupabaseClient, instanceId: string): Promise<RsvpRow[]> {
  const { data, error } = await service
    .from('event_rsvps')
    .select('id, phone_e164, name, person_id, retained_person_id, anonymized_at, updated_at')
    .eq('event_instance_id', instanceId)
  if (error) throw new Error(`read rsvps failed: ${error.message}`)
  return (data ?? []) as RsvpRow[]
}

async function rsvpAnonymizeAudits(service: SupabaseClient, instanceId: string): Promise<Array<{ details_json: Record<string, unknown> }>> {
  const { data, error } = await service
    .from('audit_log')
    .select('details_json')
    .eq('action', AUDIT_ACTIONS.RSVP_ANONYMIZE)
    .eq('entity_id', instanceId)
  if (error) throw new Error(`audit read failed: ${error.message}`)
  return (data ?? []) as Array<{ details_json: Record<string, unknown> }>
}

async function runPass(service: SupabaseClient): Promise<number> {
  const { data, error } = await service.rpc('run_rsvp_retention_pass', { p_actor_user_id: null })
  if (error) throw new Error(`run_rsvp_retention_pass failed: ${error.message}`)
  return data as number
}

/** The state event/instance/people must still be ours and synthetic. */
async function assertSyntheticFixture(service: SupabaseClient, state: State, requirePresent: boolean): Promise<void> {
  const { data: ev, error: evErr } = await service.from('events').select('id, name').eq('id', state.eventId).maybeSingle()
  if (evErr) throw new Error(`event lookup failed: ${evErr.message}`)
  if (ev && !(ev as { name: string }).name.startsWith(SYNTH)) abort('state event is not a [SYNTH] event — refusing')
  if (requirePresent && !ev) abort('state event no longer exists — run "cleanup"')
  if (state.instanceId) {
    const { data: inst, error: instErr } = await service.from('event_instances').select('id, event_id').eq('id', state.instanceId).maybeSingle()
    if (instErr) throw new Error(`instance lookup failed: ${instErr.message}`)
    if (inst && (inst as { event_id: string }).event_id !== state.eventId) abort('state instance does not belong to the state event — refusing')
    if (requirePresent && !inst) abort('state instance no longer exists — run "cleanup"')
  }
  const personIds = Object.values(state.people).filter(Boolean)
  if (personIds.length > 0) {
    const { data, error } = await service.from('people').select('id, full_name').in('id', personIds)
    if (error) throw new Error(`people lookup failed: ${error.message}`)
    for (const p of (data ?? []) as Array<{ full_name: string }>) {
      if (!p.full_name.startsWith(SYNTH)) abort('a state person is not [SYNTH] — refusing; inspect manually')
    }
    if (requirePresent && (data ?? []).length !== personIds.length) abort('a state person no longer exists — run "cleanup"')
  }
}

type CheckRow = { id: string; label: string; pass: boolean; detail: string }

function printChecks(rows: CheckRow[]): void {
  const idW = Math.max(2, ...rows.map(r => r.id.length))
  const labelW = Math.max(9, ...rows.map(r => r.label.length))
  console.log('')
  console.log(`${'ID'.padEnd(idW)}  ${'ASSERTION'.padEnd(labelW)}  RESULT  DETAIL`)
  console.log(`${'-'.repeat(idW)}  ${'-'.repeat(labelW)}  ------  ------`)
  for (const r of rows) {
    console.log(`${r.id.padEnd(idW)}  ${r.label.padEnd(labelW)}  ${(r.pass ? 'PASS' : 'FAIL').padEnd(6)}  ${r.detail}`)
  }
  const failed = rows.filter(r => !r.pass).length
  console.log('')
  console.log(`${TAG} ${rows.length - failed}/${rows.length} PASS${failed ? `, ${failed} FAIL` : ''}`)
}

// ---------------------------------------------------------------------------
// Phase: setup
// ---------------------------------------------------------------------------

async function setup(): Promise<void> {
  const env = await pinStaging('staging-rsvp-r5-smoke-setup')
  if (existsSync(STATE_PATH)) abort(`state file ${STATE_PATH} exists — run "cleanup" for the previous run first`)

  const runId = Date.now()
  const phones = phonesFor(runId)
  assertSyntheticPhones(phones)

  const service = serviceClient(env)
  const { data: settings, error: settingsErr } = await service.from('app_settings').select('rsvp_retention_days').eq('id', 1).single()
  if (settingsErr || !settings) abort(`app_settings.rsvp_retention_days unreadable (${settingsErr?.message ?? 'no row'}) — is migration 20261026120000 on staging?`)
  const retentionDays = (settings as { rsvp_retention_days: number }).rsvp_retention_days

  if ((await countWhere(service, 'people', 'phone_e164', Object.values(phones))) > 0) {
    abort('a synthetic phone is already present in people — refusing (re-run setup for a fresh run id)')
  }
  if ((await countWhere(service, 'event_rsvps', 'phone_e164', Object.values(phones))) > 0) {
    abort('a synthetic phone already has RSVP rows — refusing (re-run setup for a fresh run id)')
  }
  const adminId = await activeAppUserId(service, ADMIN_EMAIL)

  // 10:00–12:00 WIB on a date well past the horizon (>= 100 days at N = 90).
  const daysAgo = retentionDays + 30
  const wibDate = wibDateInDays(-daysAgo)
  const scheduledAt = `${wibDate}T03:00:00.000Z` // 10:00 WIB
  const eventName = `[SYNTH] S9-R5 Smoke ${runId}`

  // ── writes ──────────────────────────────────────────────────────────────
  const eventId = await insertOne(service, 'events', {
    name: eventName,
    name_id: eventName,
    event_type: 'adhoc',
    start_date: wibDate,
    start_time: '10:00',
    duration_min: 120,
    location: '[SYNTH] Aula Uji',
    recurrence_rule: null,
    created_by: adminId,
  })
  await audit(service, AUDIT_ACTIONS.EVENT_CREATE, 'event', eventId)

  // Write state after every insert so a failure still leaves something for
  // "cleanup" to find.
  const state: State = {
    runId,
    createdAt: new Date().toISOString(),
    eventId,
    instanceId: '',
    linkId: '',
    people: { A: '', B: '', D: '' },
    rsvps: { a: '', b: '', c: '', d: '' },
    updatedAt: { a: '', b: '', c: '', d: '' },
    crosstab: null,
    drivenAt: null,
  }
  writeState(state)

  state.instanceId = await insertOne(service, 'event_instances', {
    event_id: eventId,
    scheduled_at: scheduledAt,
    event_name_snapshot: eventName,
    event_name_snapshot_id: eventName,
    status: 'completed',
    image_url: null,
  })
  writeState(state)

  state.linkId = await insertOne(service, 'event_rsvp_links', {
    event_instance_id: state.instanceId,
    created_by: adminId,
  })
  await audit(service, AUDIT_ACTIONS.RSVP_LINK_CREATE, 'event_rsvp_link', state.linkId)
  writeState(state)

  for (const k of ['A', 'B', 'D'] as const) {
    state.people[k] = await insertOne(service, 'people', {
      full_name: `[SYNTH] UAT R5 ${k}`,
      nickname: k,
      phone_e164: phones[k],
    })
    await audit(service, AUDIT_ACTIONS.PEOPLE_CREATE, 'person', state.people[k])
    writeState(state)
  }
  {
    const { error } = await service.from('people')
      .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', state.people.D)
    if (error) throw new Error(`soft-delete D failed: ${error.message}`)
    await audit(service, AUDIT_ACTIONS.PEOPLE_SOFT_DELETE, 'person', state.people.D)
  }

  for (const k of ['A', 'B', 'D'] as const) {
    const { error } = await service.from('attendance')
      .insert({ event_instance_id: state.instanceId, person_id: state.people[k], checked_in_by: adminId })
    if (error) throw new Error(`attendance ${k} failed: ${error.message}`)
  }

  const rsvp = (phone: string, personId: string | null, name: string | null, status: string) =>
    insertOne(service, 'event_rsvps', {
      event_instance_id: state.instanceId,
      link_id: state.linkId,
      phone_e164: phone,
      name,
      children_count: 0,
      followup_consent: true,
      status,
      person_id: personId,
    })
  state.rsvps.a = await rsvp(phones.A, state.people.A, null, 'coming')
  state.rsvps.b = await rsvp(phones.B, null, '[SYNTH] UAT R5 Newcomer B', 'coming')
  state.rsvps.c = await rsvp(phones.C, null, '[SYNTH] UAT R5 Newcomer C', 'maybe')
  state.rsvps.d = await rsvp(phones.D, null, '[SYNTH] UAT R5 Newcomer D', 'not_coming')
  writeState(state)

  for (const r of await readRsvps(service, state.instanceId)) {
    const key = RSVP_KEYS.find(k => state.rsvps[k] === r.id)
    if (key) state.updatedAt[key] = r.updated_at
  }

  const admin = await adminSession(env, service)
  state.crosstab = await readCrosstab(admin, state.instanceId)
  writeState(state)

  // The snapshot must be the hand-computed shape, or the invariant check
  // after the pass proves nothing.
  const byRsvp = new Map(state.crosstab.filter(r => r.rsvp_id).map(r => [r.rsvp_id!, r]))
  const walkIns = state.crosstab.filter(r => r.bucket === 'walk_in').map(r => r.resolved_person_id)
  const shapeOk =
    state.crosstab.length === 5 &&
    byRsvp.get(state.rsvps.a)?.bucket === 'coming_came' &&
    byRsvp.get(state.rsvps.b)?.bucket === 'coming_came' &&
    byRsvp.get(state.rsvps.b)?.resolved_person_id === state.people.B &&
    byRsvp.get(state.rsvps.c)?.bucket === 'maybe_no_show' &&
    byRsvp.get(state.rsvps.d)?.bucket === 'not_coming_no_show' &&
    byRsvp.get(state.rsvps.d)?.resolved_person_id === null &&
    walkIns.length === 1 && walkIns[0] === state.people.D
  if (!shapeOk) abort('pre-pass crosstab is not the expected shape — fixture kept; run "cleanup"')

  console.log('')
  console.log(`${TAG} setup done:`)
  console.log(`  - event "${eventName}" + 1 COMPLETED instance on ${wibDate} 10:00–12:00 WIB (${daysAgo} days ago; horizon ${retentionDays})`)
  console.log('  - people A, B, D (D soft-deleted); attendance A, B, D; RSVPs a–d')
  console.log('  - crosstab snapshot (admin session): a coming_came, b coming_came via phone, c maybe_no_show, d not_coming_no_show, D walk_in')
  console.log(`  - state:  ${path.relative(process.cwd(), STATE_PATH)}`)
  console.log('')
  console.log('NEXT: node --env-file=.env.staging.local scripts/.build/scripts/s9-r5-staging-smoke.js drive')
}

// ---------------------------------------------------------------------------
// Phase: drive
// ---------------------------------------------------------------------------

async function drive(): Promise<void> {
  const env = await pinStaging('staging-rsvp-r5-smoke-drive')
  const state = readState()
  if (!state.crosstab) abort('state is incomplete — setup did not finish; run "cleanup" then "setup"')
  if (state.drivenAt) abort(`already driven at ${state.drivenAt} — run "verify" (it runs the second pass itself)`)

  const service = serviceClient(env)
  await assertSyntheticFixture(service, state, true)

  console.log(`${TAG} run_rsvp_retention_pass is GLOBAL — every eligible staging RSVP row is scrubbed, not only this fixture's`)
  const count = await runPass(service)
  state.drivenAt = new Date().toISOString()
  writeState(state)
  console.log(`${TAG} run_rsvp_retention_pass returned ${count} (this fixture contributes 4)`)
  if (count < 4) abort('returned fewer rows than this fixture alone — run "verify" to see which')
  console.log('')
  console.log('NEXT: node --env-file=.env.staging.local scripts/.build/scripts/s9-r5-staging-smoke.js verify')
}

// ---------------------------------------------------------------------------
// Phase: verify
// ---------------------------------------------------------------------------

async function verify(): Promise<void> {
  const env = await pinStaging('staging-rsvp-r5-smoke-verify')
  const state = readState()
  if (!state.crosstab || !state.drivenAt) abort('run "setup" and "drive" first')

  const service = serviceClient(env)
  await assertSyntheticFixture(service, state, true)

  const rows = await readRsvps(service, state.instanceId)
  const byId = new Map(rows.map(r => [r.id, r]))
  const checks: CheckRow[] = []
  checks.push({ id: 'v-count', label: 'exactly 4 RSVP rows on the instance', pass: rows.length === 4, detail: `rows=${rows.length}` })

  for (const k of RSVP_KEYS) {
    const r = byId.get(state.rsvps[k])
    const fields = r
      ? {
          phone_null: r.phone_e164 === null,
          name_null: r.name === null,
          anonymized: r.anonymized_at !== null,
          updated_at_kept: r.updated_at === state.updatedAt[k],
          person_kept: r.person_id === (k === 'a' ? state.people.A : null),
          retained: r.retained_person_id === (k === 'b' ? state.people.B : null),
        }
      : null
    const failed = fields ? Object.entries(fields).filter(([, ok]) => !ok).map(([f]) => f) : []
    checks.push({
      id: `v-${k}`,
      label: `${k}: phone/name NULL, anonymized, updated_at kept, person_id kept, retained ${k === 'b' ? '= B' : 'NULL'}`,
      pass: !!fields && failed.length === 0,
      detail: !r ? 'missing' : failed.length === 0 ? 'ok' : `MISMATCH: ${failed.join(', ')}`,
    })
  }

  const admin = await adminSession(env, service)
  const crosstab = await readCrosstab(admin, state.instanceId)
  const same = isDeepStrictEqual(crosstab, state.crosstab)
  checks.push({
    id: 'v-crosstab',
    label: 'crosstab deep-equals the pre-pass snapshot (admin session)',
    pass: same,
    detail: same ? `ok (${crosstab.length} rows)` : `CHANGED: ${crosstab.length} rows vs ${state.crosstab.length}`,
  })

  const audits = await rsvpAnonymizeAudits(service, state.instanceId)
  const auditOk =
    audits.length === 1 &&
    isDeepStrictEqual(audits[0]!.details_json, { instance_id: state.instanceId, rows: 4, trigger: 'scheduled_retention_pass' })
  checks.push({
    id: 'v-audit',
    label: 'exactly one rsvp.anonymize audit row for the instance, rows = 4',
    pass: auditOk,
    detail: `audit rows=${audits.length}${audits[0] ? ` rows=${String(audits[0].details_json.rows)}` : ''}`,
  })

  // Second pass: global count printed for information; for THIS instance it
  // must change nothing — same rows, still exactly one audit row.
  const second = await runPass(service)
  const rowsAfter = await readRsvps(service, state.instanceId)
  const unchanged = isDeepStrictEqual(
    [...rowsAfter].sort((x, y) => x.id.localeCompare(y.id)),
    [...rows].sort((x, y) => x.id.localeCompare(y.id)),
  )
  const auditsAfter = await rsvpAnonymizeAudits(service, state.instanceId)
  checks.push({
    id: 'v-idempotent',
    label: 'second pass: 0 rows for this instance (rows unchanged, still one audit row)',
    pass: unchanged && auditsAfter.length === 1,
    detail: `global return=${second} rows_unchanged=${unchanged} audit_rows=${auditsAfter.length}`,
  })

  printChecks(checks)
  if (checks.some(c => !c.pass)) abort('verify failed — see the table above; the fixture is kept for inspection, run "cleanup" when done')
  console.log('')
  console.log('When done: node --env-file=.env.staging.local scripts/.build/scripts/s9-r5-staging-smoke.js cleanup')
}

// ---------------------------------------------------------------------------
// Phase: cleanup
// ---------------------------------------------------------------------------

async function cleanup(): Promise<void> {
  const env = await pinStaging('staging-rsvp-r5-smoke-cleanup')
  const state = readState()
  const phones = phonesFor(state.runId)
  const service = serviceClient(env)

  // Safety: everything we are about to delete must still look synthetic.
  await assertSyntheticFixture(service, state, false)

  const instanceIds = state.instanceId ? [state.instanceId] : []
  const personIds = Object.values(state.people).filter(Boolean)
  const del = async (table: string, column: string, values: string[]) => {
    const ids = values.filter(v => v !== '')
    if (ids.length === 0) return
    const { error } = await service.from(table).delete().in(column, ids)
    if (error) throw new Error(`delete ${table} failed: ${error.message}`)
  }

  // attendance.person_id has no ON DELETE, so it goes first; then the event:
  // CASCADE to the instance, its link and RSVPs.
  await del('child_attendance', 'event_instance_id', instanceIds)
  await del('attendance', 'event_instance_id', instanceIds)
  await del('events', 'id', [state.eventId])

  // event_rsvps.person_id and retained_person_id are NO ACTION: the people
  // go only once no RSVP row can reference them.
  const rsvpLeft =
    (await countWhere(service, 'event_rsvps', 'event_instance_id', instanceIds)) +
    (await countWhere(service, 'event_rsvps', 'id', Object.values(state.rsvps))) +
    (await countWhere(service, 'event_rsvps', 'person_id', personIds)) +
    (await countWhere(service, 'event_rsvps', 'retained_person_id', personIds))
  if (rsvpLeft !== 0) abort(`${rsvpLeft} RSVP row(s) remain after the event delete — people NOT deleted; state file kept`)
  console.log('[cleanup] event deleted (cascade); zero RSVP rows remain')

  for (const id of personIds) {
    const { data, error: readErr } = await service.from('people').select('id, full_name').eq('id', id).maybeSingle()
    if (readErr) throw new Error(`people read failed: ${readErr.message}`)
    if (!data) continue
    if (!(data as { full_name: string }).full_name.startsWith(SYNTH)) abort('a state person is not [SYNTH] — refusing; inspect manually')
    const { error } = await service.from('people').delete().eq('id', id)
    if (error) throw new Error(`delete person failed: ${error.message}`)
    await audit(service, AUDIT_ACTIONS.DATA_WIPE, 'person', id)
  }
  console.log(`[cleanup] ${personIds.length} [SYNTH] people deleted (data.wipe audited)`)

  // ── residue ──────────────────────────────────────────────────────────────
  const residue: Record<string, number> = {
    events: await countWhere(service, 'events', 'id', [state.eventId]),
    event_instances: await countWhere(service, 'event_instances', 'id', instanceIds),
    event_rsvp_links: await countWhere(service, 'event_rsvp_links', 'event_instance_id', instanceIds),
    event_rsvps: await countWhere(service, 'event_rsvps', 'event_instance_id', instanceIds),
    event_rsvps_by_id: await countWhere(service, 'event_rsvps', 'id', Object.values(state.rsvps)),
    event_rsvps_by_phone: await countWhere(service, 'event_rsvps', 'phone_e164', Object.values(phones)),
    attendance: await countWhere(service, 'attendance', 'event_instance_id', instanceIds),
    attendance_by_person: await countWhere(service, 'attendance', 'person_id', personIds),
    people: await countWhere(service, 'people', 'id', personIds),
    people_by_phone: await countWhere(service, 'people', 'phone_e164', Object.values(phones)),
  }
  const total = Object.values(residue).reduce((a, b) => a + b, 0)
  console.log('')
  console.log(`[residue] ${Object.entries(residue).map(([k, v]) => `${k}=${v}`).join(' ')}`)
  if (total !== 0) abort(`residue remains (${total} row(s)) — state file kept for a re-run`)

  unlinkSync(STATE_PATH)
  console.log(`${TAG} cleanup done — zero residue; state file removed (audit_log rows are append-only and kept)`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const [phase] = process.argv.slice(2)
  if (phase === 'setup') return setup()
  if (phase === 'drive') return drive()
  if (phase === 'verify') return verify()
  if (phase === 'cleanup') return cleanup()
  abort('usage: s9-r5-staging-smoke.js setup | drive | verify | cleanup')
}

main().catch((err) => {
  console.error(`${TAG} FATAL:`, err instanceof Error ? err.message : err)
  process.exit(1)
})
