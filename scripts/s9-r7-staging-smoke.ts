/**
 * S9-R7 — Staging smoke for RSVP analytics (verification ladder rung 2).
 * Fully automated data path (R6 item 16): no RSVP is typed into a page.
 * Synthetic data only: [SYNTH] names, fresh +62999 phones, staging accounts
 * (admin@example.com, organizer@example.com). Requires migration
 * 20261026180000 on staging (setup aborts if rsvp_instance_metrics is missing).
 *
 * Three phases, run in order:
 *
 *   setup    Picks a WIB date: D-20, or the nearest earlier date with NO other
 *            ended, linked, non-cancelled instance (checked through
 *            rsvp_instance_metrics on an ADMIN session — the view is
 *            is_admin()-filtered, the service role reads 0 rows) — and prints
 *            it. Then, via the service role, the S9-R7 recon I1 fixture on a
 *            [SYNTH] adhoc event, 1 COMPLETED instance 10:00–12:00 WIB on that
 *            date, one DEACTIVATED + one ACTIVE RSVP link:
 *              M1  member, coming + 2 children (old link), checked in; 1 child in
 *              M2  member, maybe + 1 child, no-show; M2's child checked in anyway
 *              M3  member, not_coming, checked in
 *              N1  newcomer coming + 1 child; phone registered afterwards as NB,
 *                  NB checked in
 *              GH  newcomer coming, phone never on the roster, no-show
 *              W1  walk-in member; W1's child checked in
 *              D1  walk-in, soft-deleted
 *              invitations: M1 M2 M4 W1 'sent', M3 'failed'
 *   verify   ADMIN session: the rsvp_instance_metrics row equals the I1 hand
 *            numbers (all 13 counts); the impl_getRsvpAnalytics-equivalent
 *            read (from = to = <date> on Asia/Jakarta day bounds, eventType
 *            adhoc) returns exactly this instance and pools to show-up 67%,
 *            no-show 33%, walk-in share 40%, response 50%, attendance 50%
 *            (rounded exactly as RsvpKpiCards shows them). ORGANIZER session
 *            reads 0 rows. Prints the owner visual-check URL.
 *   cleanup  attendance -> child_attendance -> invitations -> event (CASCADE:
 *            instance, links, RSVPs) -> assert zero RSVP rows -> [SYNTH]
 *            children + people (data.wipe audit) -> assert zero residue.
 *
 * Run (tsc->node, compiled path — libphonenumber-js must not run under tsx):
 *   npx tsc -p scripts/tsconfig.s9-r7-smoke.json
 *   node --env-file=.env.staging.local scripts/.build/scripts/s9-r7-staging-smoke.js setup
 *   node --env-file=.env.staging.local scripts/.build/scripts/s9-r7-staging-smoke.js verify
 *   node --env-file=.env.staging.local scripts/.build/scripts/s9-r7-staging-smoke.js cleanup
 *
 * OWNER VISUAL CHECKS (staging branch Vercel deployment, signed in as admin,
 * after "verify" and before "cleanup"; verify prints the exact URL
 * /admin/analytics?from=<date>&to=<date>&eventType=adhoc):
 *   V1  RSVP section cards read: Coming headcount 6 · Show-up 67% · No-show 33% ·
 *       Walk-in share 40% · Became members 1 -> PASS
 *   V2  RSVP vs actual chart shows one point: bar 6, adults 5, children 3 -> PASS
 *
 * GUARDS (every phase, before any read or write):
 *   1. Shared preflight guard (branch <-> ref map).
 *   2. Staging pin: resolved ref must be exactly STAGING_REF — no local, no prod.
 *   3. Env URL ref must equal STAGING_REF (no split-brain).
 * setup additionally: no state file from an earlier run; every synthetic
 *   phone normalises to exactly itself, starts with +62999, and is absent
 *   from people and event_rsvps.
 * verify / cleanup additionally: the state event is [SYNTH], the state
 *   instance still belongs to it, every state person and child is [SYNTH].
 *
 * STATE: scripts/.build/s9-r7-smoke-state.json (scripts/.build/ is
 * gitignored, mode 0600): run id, date, row ids. No phones, names or secrets.
 *
 * SECRETS: none printed. Admin and organizer sessions come from magic-link
 * tokens minted with the service role (auth.admin.generateLink — sends no
 * email) and exchanged in-process; never written to disk.
 *
 * AUDIT (CLAUDE.md rule 6): people inserts log people.create, D1's
 * soft-delete logs people.soft_delete, children log child.create, the
 * cleanup hard-deletes log data.wipe (all actorUserId = null —
 * service_role/system path). event.create and rsvp_link.create are logged
 * on setup. audit_log rows are append-only and excluded from the residue
 * check.
 */

import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { normalizePhone } from '../lib/utils/phone'
import { AUDIT_ACTIONS, logAudit, type AuditAction } from '../lib/audit'

const STAGING_REF = 'sijfyvaodqkawbeuyrpu'
const SOURCE = 's9-r7-staging-smoke'
const TAG = '[s9-r7-smoke]'
const STATE_PATH = path.resolve(process.cwd(), 'scripts/.build/s9-r7-smoke-state.json')
const SYNTH = '[SYNTH]'
const ADMIN_EMAIL = 'admin@example.com'
const ORGANIZER_EMAIL = 'organizer@example.com'

// ---------------------------------------------------------------------------
// Preflight guard — same preamble as scripts/s9-r5-staging-smoke.ts
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
    console.error('=================== PREFLIGHT ABORT (s9-r7-staging-smoke) ===================')
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

type PhoneKey = 'M1' | 'M2' | 'M3' | 'M4' | 'W1' | 'D1' | 'NB' | 'GH'
const PHONE_KEYS: PhoneKey[] = ['M1', 'M2', 'M3', 'M4', 'W1', 'D1', 'NB', 'GH']
type PersonKey = Exclude<PhoneKey, 'GH'>  // GH's phone is never on the roster
type ChildKey = 'M1' | 'M2' | 'W1'
const CHILD_KEYS: ChildKey[] = ['M1', 'M2', 'W1']

/** Fresh synthetic phones in the +62999 shape, derived from the run id. */
function phonesFor(runId: number): Record<PhoneKey, string> {
  const out = {} as Record<PhoneKey, string>
  PHONE_KEYS.forEach((k, i) => {
    out[k] = `+62999${((runId + i) % 10_000_000).toString().padStart(7, '0')}`
  })
  return out
}

/** The I1 hand numbers (S9-R7 recon §3, owner-approved). */
const EXPECTED_COUNTS = {
  coming_people: 3,
  coming_headcount: 6,
  maybe_people: 1,
  coming_came: 2,
  coming_no_show: 1,
  walk_ins: 2,
  actual_adults: 5,
  actual_children: 3,
  newcomer_rsvps: 2,
  became_members: 1,
  invited: 4,
  invited_responded: 2,
  invited_attended: 2,
} as const
type CountKey = keyof typeof EXPECTED_COUNTS
const COUNT_KEYS = Object.keys(EXPECTED_COUNTS) as CountKey[]

/** Pooled KPIs as RsvpKpiCards displays them (percent, no-show = 100 − show-up). */
const EXPECTED_PERCENT = { show_up: 67, no_show: 33, walk_in_share: 40, response: 50, attendance: 50 } as const

type MetricsRow = { event_instance_id: string; scheduled_at: string } & Record<CountKey, number>

type State = {
  runId: number
  createdAt: string
  date: string
  eventId: string
  instanceId: string
  links: { old: string; active: string }
  people: Record<PersonKey, string>
  children: Record<ChildKey, string>
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

async function activeAppUserId(supabase: SupabaseClient, email: string, role: 'admin' | 'organizer'): Promise<string> {
  const { data, error } = await supabase.from('app_users').select('id, active, role').eq('email', email).maybeSingle()
  if (error) throw new Error(`app_users lookup failed: ${error.message}`)
  const row = data as { id: string; active: boolean; role: string } | null
  if (!row || row.active !== true || row.role !== role) {
    abort(`${email} missing, inactive or not ${role} in app_users — run scripts/s8-t7-seed-staging-identities.ts first`)
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

/** 'YYYY-MM-DD' + n days (calendar arithmetic). */
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/**
 * scheduled_at bounds for from = to = date — same rule as
 * jakartaScheduledRange() in lib/actions/rsvp-analytics.impl.ts:
 * gte 00:00 WIB on the date, lt 00:00 WIB the day after.
 */
function wibDayRange(date: string): { gte: string; lt: string } {
  return {
    gte: new Date(`${date}T00:00:00+07:00`).toISOString(),
    lt: new Date(`${addDays(date, 1)}T00:00:00+07:00`).toISOString(),
  }
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
 * An in-memory session for a staging account: magic-link token minted with
 * the service role (no email is sent), exchanged on an anon client.
 */
async function sessionFor(env: Env, service: SupabaseClient, email: string, role: 'admin' | 'organizer'): Promise<SupabaseClient> {
  await activeAppUserId(service, email, role)
  const { data: link, error: linkErr } = await service.auth.admin.generateLink({ type: 'magiclink', email })
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

/** rsvp_instance_metrics rows whose scheduled_at falls on the WIB date. */
async function metricsOnDate(session: SupabaseClient, date: string, eventType?: string): Promise<MetricsRow[]> {
  const range = wibDayRange(date)
  let query = session
    .from('rsvp_instance_metrics')
    .select(`event_instance_id, scheduled_at, ${COUNT_KEYS.join(', ')}`)
    .gte('scheduled_at', range.gte)
    .lt('scheduled_at', range.lt)
    .order('scheduled_at', { ascending: true })
    .order('event_instance_id', { ascending: true })
  if (eventType) query = query.eq('event_type', eventType)
  const { data, error } = await query
  if (error) throw new Error(`rsvp_instance_metrics read failed: ${error.message}`)
  return (data ?? []) as unknown as MetricsRow[]
}

/** The state event/instance/people/children must still be ours and synthetic. */
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
  for (const [table, ids] of [
    ['people', Object.values(state.people).filter(Boolean)],
    ['children', Object.values(state.children).filter(Boolean)],
  ] as const) {
    if (ids.length === 0) continue
    const { data, error } = await service.from(table).select('id, full_name').in('id', ids)
    if (error) throw new Error(`${table} lookup failed: ${error.message}`)
    for (const p of (data ?? []) as Array<{ full_name: string }>) {
      if (!p.full_name.startsWith(SYNTH)) abort(`a state ${table} row is not [SYNTH] — refusing; inspect manually`)
    }
    if (requirePresent && (data ?? []).length !== ids.length) abort(`a state ${table} row no longer exists — run "cleanup"`)
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

function visualUrl(date: string): string {
  const pathAndQuery = `/admin/analytics?from=${date}&to=${date}&eventType=adhoc`
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, '')
  return base ? `${base}${pathAndQuery}` : `<staging deployment>${pathAndQuery}`
}

// ---------------------------------------------------------------------------
// Phase: setup
// ---------------------------------------------------------------------------

async function setup(): Promise<void> {
  const env = await pinStaging('staging-rsvp-r7-smoke-setup')
  if (existsSync(STATE_PATH)) abort(`state file ${STATE_PATH} exists — run "cleanup" for the previous run first`)

  const runId = Date.now()
  const phones = phonesFor(runId)
  assertSyntheticPhones(phones)

  const service = serviceClient(env)
  if ((await countWhere(service, 'people', 'phone_e164', Object.values(phones))) > 0) {
    abort('a synthetic phone is already present in people — refusing (re-run setup for a fresh run id)')
  }
  if ((await countWhere(service, 'event_rsvps', 'phone_e164', Object.values(phones))) > 0) {
    abort('a synthetic phone already has RSVP rows — refusing (re-run setup for a fresh run id)')
  }
  const adminId = await activeAppUserId(service, ADMIN_EMAIL, 'admin')
  const admin = await sessionFor(env, service, ADMIN_EMAIL, 'admin')

  // ── date: D-20, or the nearest earlier date with no other linked instance ──
  let date = ''
  for (let back = 20; back <= 80; back++) {
    const candidate = wibDateInDays(-back)
    let others: MetricsRow[]
    try {
      others = await metricsOnDate(admin, candidate)
    } catch (err) {
      abort(`${err instanceof Error ? err.message : String(err)} — is migration 20261026180000 on staging?`)
    }
    console.log(`[setup] ${candidate}: ${others.length} other ended, linked, non-cancelled instance(s)`)
    if (others.length === 0) {
      date = candidate
      break
    }
  }
  if (!date) abort('no free WIB date between D-20 and D-80 — inspect staging')
  console.log(`[setup] fixture date (WIB): ${date}`)

  const eventName = `[SYNTH] S9-R7 Smoke ${runId}`

  // ── writes ──────────────────────────────────────────────────────────────
  const eventId = await insertOne(service, 'events', {
    name: eventName,
    name_id: eventName,
    event_type: 'adhoc',
    start_date: date,
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
    date,
    eventId,
    instanceId: '',
    links: { old: '', active: '' },
    people: { M1: '', M2: '', M3: '', M4: '', W1: '', D1: '', NB: '' },
    children: { M1: '', M2: '', W1: '' },
  }
  writeState(state)

  state.instanceId = await insertOne(service, 'event_instances', {
    event_id: eventId,
    scheduled_at: `${date}T03:00:00.000Z`, // 10:00 WIB
    event_name_snapshot: eventName,
    event_name_snapshot_id: eventName,
    status: 'completed',
    image_url: null,
  })
  writeState(state)

  // Deactivated link first (at most one active link per instance).
  state.links.old = await insertOne(service, 'event_rsvp_links', {
    event_instance_id: state.instanceId,
    created_by: adminId,
    is_active: false,
  })
  await audit(service, AUDIT_ACTIONS.RSVP_LINK_CREATE, 'event_rsvp_link', state.links.old)
  state.links.active = await insertOne(service, 'event_rsvp_links', {
    event_instance_id: state.instanceId,
    created_by: adminId,
  })
  await audit(service, AUDIT_ACTIONS.RSVP_LINK_CREATE, 'event_rsvp_link', state.links.active)
  writeState(state)

  const addPerson = async (k: PersonKey) => {
    state.people[k] = await insertOne(service, 'people', {
      full_name: `[SYNTH] UAT R7 ${k}`,
      nickname: k,
      phone_e164: phones[k],
    })
    await audit(service, AUDIT_ACTIONS.PEOPLE_CREATE, 'person', state.people[k])
    writeState(state)
  }
  for (const k of ['M1', 'M2', 'M3', 'M4', 'W1', 'D1'] as const) await addPerson(k)
  {
    const { error } = await service.from('people')
      .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', state.people.D1)
    if (error) throw new Error(`soft-delete D1 failed: ${error.message}`)
    await audit(service, AUDIT_ACTIONS.PEOPLE_SOFT_DELETE, 'person', state.people.D1)
  }

  const rsvp = (linkId: string, phone: string, personId: string | null, name: string | null, children: number, status: string) =>
    insertOne(service, 'event_rsvps', {
      event_instance_id: state.instanceId,
      link_id: linkId,
      phone_e164: phone,
      name,
      children_count: children,
      followup_consent: false,
      status,
      person_id: personId,
    })
  await rsvp(state.links.old, phones.M1, state.people.M1, null, 2, 'coming')
  await rsvp(state.links.active, phones.M2, state.people.M2, null, 1, 'maybe')
  await rsvp(state.links.active, phones.M3, state.people.M3, null, 0, 'not_coming')
  await rsvp(state.links.active, phones.NB, null, '[SYNTH] UAT R7 Newcomer N1', 1, 'coming')
  await rsvp(state.links.active, phones.GH, null, '[SYNTH] UAT R7 Ghost', 0, 'coming')

  await addPerson('NB') // registered at the door after the RSVP

  for (const k of ['M1', 'M3', 'W1', 'D1', 'NB'] as const) {
    const { error } = await service.from('attendance')
      .insert({ event_instance_id: state.instanceId, person_id: state.people[k], checked_in_by: adminId })
    if (error) throw new Error(`attendance ${k} failed: ${error.message}`)
  }

  for (const k of CHILD_KEYS) {
    state.children[k] = await insertOne(service, 'children', {
      parent_person_id: state.people[k],
      full_name: `[SYNTH] UAT R7 ${k} child`,
    })
    await audit(service, AUDIT_ACTIONS.CHILD_CREATE, 'child', state.children[k])
    writeState(state)
    const { error } = await service.from('child_attendance')
      .insert({ event_instance_id: state.instanceId, child_id: state.children[k], checked_in_by: adminId })
    if (error) throw new Error(`child_attendance ${k} failed: ${error.message}`)
  }

  for (const [k, status] of [['M1', 'sent'], ['M2', 'sent'], ['M3', 'failed'], ['M4', 'sent'], ['W1', 'sent']] as const) {
    const { error } = await service.from('event_invitations')
      .insert({ event_instance_id: state.instanceId, person_id: state.people[k], status, invited_by: adminId })
    if (error) throw new Error(`invitation ${k} failed: ${error.message}`)
  }

  console.log('')
  console.log(`${TAG} setup done:`)
  console.log(`  - event "${eventName}" + 1 COMPLETED instance on ${date} 10:00–12:00 WIB, 1 deactivated + 1 active link`)
  console.log('  - RSVPs: M1 coming+2 (old link), M2 maybe+1, M3 not_coming, N1 newcomer coming+1 (-> NB), GH newcomer coming')
  console.log('  - attendance M1 M3 W1 D1(soft-deleted) NB; children of M1 M2 W1 checked in')
  console.log('  - invitations M1 M2 M4 W1 sent, M3 failed')
  console.log(`  - state:  ${path.relative(process.cwd(), STATE_PATH)}`)
  console.log('')
  console.log('NEXT: node --env-file=.env.staging.local scripts/.build/scripts/s9-r7-staging-smoke.js verify')
}

// ---------------------------------------------------------------------------
// Phase: verify
// ---------------------------------------------------------------------------

function pct(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Math.round((numerator / denominator) * 100)
}

async function verify(): Promise<void> {
  const env = await pinStaging('staging-rsvp-r7-smoke-verify')
  const state = readState()
  if (!state.instanceId || !state.children.W1) abort('state is incomplete — setup did not finish; run "cleanup" then "setup"')

  const service = serviceClient(env)
  await assertSyntheticFixture(service, state, true)
  const checks: CheckRow[] = []

  // ── view row (admin session) ───────────────────────────────────────────
  const admin = await sessionFor(env, service, ADMIN_EMAIL, 'admin')
  const { data: viewData, error: viewErr } = await admin
    .from('rsvp_instance_metrics')
    .select(`event_instance_id, scheduled_at, ${COUNT_KEYS.join(', ')}`)
    .eq('event_instance_id', state.instanceId)
  if (viewErr) throw new Error(`rsvp_instance_metrics read failed: ${viewErr.message}`)
  const viewRows = (viewData ?? []) as unknown as MetricsRow[]
  checks.push({ id: 'v-row', label: 'exactly one rsvp_instance_metrics row for the instance (admin)', pass: viewRows.length === 1, detail: `rows=${viewRows.length}` })
  const row = viewRows[0]
  const mismatched = row ? COUNT_KEYS.filter(k => row[k] !== EXPECTED_COUNTS[k]) : COUNT_KEYS
  checks.push({
    id: 'v-counts',
    label: 'all 13 counts equal the I1 hand numbers',
    pass: !!row && mismatched.length === 0,
    detail: !row ? 'no row' : mismatched.length === 0
      ? COUNT_KEYS.map(k => `${k}=${row[k]}`).join(' ')
      : `MISMATCH: ${mismatched.map(k => `${k}=${row[k]} (want ${EXPECTED_COUNTS[k]})`).join(', ')}`,
  })

  // ── impl_getRsvpAnalytics-equivalent read + pooling ────────────────────
  const filtered = await metricsOnDate(admin, state.date, 'adhoc')
  const onlyOurs = filtered.length === 1 && filtered[0]!.event_instance_id === state.instanceId
  checks.push({
    id: 'v-filter',
    label: `from=to=${state.date} (WIB), eventType=adhoc -> exactly this instance`,
    pass: onlyOurs,
    detail: `rows=${filtered.length}`,
  })
  const sum = (k: CountKey, rows = filtered) => rows.reduce((acc, r) => acc + r[k], 0)
  const invitedRows = filtered.filter(r => r.invited > 0)
  const showUp = pct(sum('coming_came'), sum('coming_people'))
  const pooled = {
    show_up: showUp,
    no_show: showUp === null ? null : 100 - showUp,  // as RsvpKpiCards shows it
    walk_in_share: pct(sum('walk_ins'), sum('actual_adults')),
    response: pct(sum('invited_responded', invitedRows), sum('invited', invitedRows)),
    attendance: pct(sum('invited_attended', invitedRows), sum('invited', invitedRows)),
  }
  const pctKeys = Object.keys(EXPECTED_PERCENT) as Array<keyof typeof EXPECTED_PERCENT>
  const pctBad = pctKeys.filter(k => pooled[k] !== EXPECTED_PERCENT[k])
  checks.push({
    id: 'v-pooled',
    label: 'pooled: show-up 67% · no-show 33% · walk-in 40% · response 50% · attendance 50%',
    pass: pctBad.length === 0,
    detail: pctKeys.map(k => `${k}=${pooled[k] ?? '—'}%`).join(' ') + (pctBad.length ? ` MISMATCH: ${pctBad.join(', ')}` : ''),
  })
  // The no-show rule must agree with the raw ratio here, or the display rule hides a bug.
  const rawNoShow = pct(sum('coming_no_show'), sum('coming_people'))
  checks.push({ id: 'v-noshow-raw', label: 'raw Σcoming_no_show/Σcoming_people also rounds to 33%', pass: rawNoShow === 33, detail: `raw=${rawNoShow ?? '—'}%` })

  // ── organizer session ──────────────────────────────────────────────────
  const organizer = await sessionFor(env, service, ORGANIZER_EMAIL, 'organizer')
  const { data: orgData, error: orgErr } = await organizer
    .from('rsvp_instance_metrics')
    .select('event_instance_id')
    .eq('event_instance_id', state.instanceId)
  const { data: orgAtt } = await organizer.from('attendance').select('id').eq('event_instance_id', state.instanceId)
  checks.push({
    id: 'v-organizer',
    label: 'organizer session reads 0 rows (while it can read the attendance)',
    pass: !orgErr && (orgData ?? []).length === 0,
    detail: orgErr ? `error ${orgErr.code}` : `rows=${(orgData ?? []).length} attendance_visible=${(orgAtt ?? []).length}`,
  })

  printChecks(checks)
  if (checks.some(c => !c.pass)) abort('verify failed — see the table above; the fixture is kept for inspection, run "cleanup" when done')

  console.log('')
  console.log('OWNER VISUAL CHECKS (staging deployment, signed in as admin) — open:')
  console.log(`  ${visualUrl(state.date)}`)
  console.log('  V1  RSVP section cards read: Coming headcount 6 · Show-up 67% · No-show 33% · Walk-in share 40% · Became members 1 -> PASS')
  console.log('  V2  RSVP vs actual chart shows one point: bar 6, adults 5, children 3 -> PASS')
  console.log('')
  console.log('When done: node --env-file=.env.staging.local scripts/.build/scripts/s9-r7-staging-smoke.js cleanup')
}

// ---------------------------------------------------------------------------
// Phase: cleanup
// ---------------------------------------------------------------------------

async function cleanup(): Promise<void> {
  const env = await pinStaging('staging-rsvp-r7-smoke-cleanup')
  const state = readState()
  const phones = phonesFor(state.runId)
  const service = serviceClient(env)

  // Safety: everything we are about to delete must still look synthetic.
  await assertSyntheticFixture(service, state, false)

  const instanceIds = state.instanceId ? [state.instanceId] : []
  const personIds = Object.values(state.people).filter(Boolean)
  const childIds = Object.values(state.children).filter(Boolean)
  const del = async (table: string, column: string, values: string[]) => {
    const ids = values.filter(v => v !== '')
    if (ids.length === 0) return
    const { error } = await service.from(table).delete().in(column, ids)
    if (error) throw new Error(`delete ${table} failed: ${error.message}`)
  }

  // person_id / child_id FKs are NO ACTION: the rows that reference the
  // people and children go first; then the event, which CASCADEs to the
  // instance, its links and RSVPs.
  await del('attendance', 'event_instance_id', instanceIds)
  await del('child_attendance', 'event_instance_id', instanceIds)
  await del('event_invitations', 'event_instance_id', instanceIds)
  await del('events', 'id', [state.eventId])

  const rsvpLeft =
    (await countWhere(service, 'event_rsvps', 'event_instance_id', instanceIds)) +
    (await countWhere(service, 'event_rsvps', 'person_id', personIds)) +
    (await countWhere(service, 'event_rsvps', 'retained_person_id', personIds))
  if (rsvpLeft !== 0) abort(`${rsvpLeft} RSVP row(s) remain after the event delete — children/people NOT deleted; state file kept`)
  console.log('[cleanup] attendance, child_attendance, invitations, event deleted (cascade); zero RSVP rows remain')

  for (const [table, ids] of [['children', childIds], ['people', personIds]] as const) {
    for (const id of ids) {
      const { data, error: readErr } = await service.from(table).select('id, full_name').eq('id', id).maybeSingle()
      if (readErr) throw new Error(`${table} read failed: ${readErr.message}`)
      if (!data) continue
      if (!(data as { full_name: string }).full_name.startsWith(SYNTH)) abort(`a state ${table} row is not [SYNTH] — refusing; inspect manually`)
      const { error } = await service.from(table).delete().eq('id', id)
      if (error) throw new Error(`delete ${table} failed: ${error.message}`)
      await audit(service, AUDIT_ACTIONS.DATA_WIPE, table === 'people' ? 'person' : 'child', id)
    }
  }
  console.log(`[cleanup] ${childIds.length} [SYNTH] children + ${personIds.length} [SYNTH] people deleted (data.wipe audited)`)

  // ── residue ──────────────────────────────────────────────────────────────
  const residue: Record<string, number> = {
    events: await countWhere(service, 'events', 'id', [state.eventId]),
    event_instances: await countWhere(service, 'event_instances', 'id', instanceIds),
    event_rsvp_links: await countWhere(service, 'event_rsvp_links', 'event_instance_id', instanceIds),
    event_rsvps: await countWhere(service, 'event_rsvps', 'event_instance_id', instanceIds),
    event_rsvps_by_phone: await countWhere(service, 'event_rsvps', 'phone_e164', Object.values(phones)),
    event_invitations: await countWhere(service, 'event_invitations', 'event_instance_id', instanceIds),
    event_invitations_by_person: await countWhere(service, 'event_invitations', 'person_id', personIds),
    attendance: await countWhere(service, 'attendance', 'event_instance_id', instanceIds),
    attendance_by_person: await countWhere(service, 'attendance', 'person_id', personIds),
    child_attendance: await countWhere(service, 'child_attendance', 'event_instance_id', instanceIds),
    child_attendance_by_child: await countWhere(service, 'child_attendance', 'child_id', childIds),
    children: await countWhere(service, 'children', 'id', childIds),
    children_by_parent: await countWhere(service, 'children', 'parent_person_id', personIds),
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
  if (phase === 'verify') return verify()
  if (phase === 'cleanup') return cleanup()
  abort('usage: s9-r7-staging-smoke.js setup | verify | cleanup')
}

main().catch((err) => {
  console.error(`${TAG} FATAL:`, err instanceof Error ? err.message : err)
  process.exit(1)
})
