/**
 * S9-R6 B — Automated BDD/UAT for public RSVP on staging (verification ladder
 * rung 2; AC 16, the R5 vitest-only gaps, the R7 chart gap). Synthetic data
 * only: [SYNTH] names, fresh +62999 phones derived from the run id, staging
 * accounts (admin@example.com).
 *
 * Five phases, run in order (the live V-checks happen in the browser between
 * them — see OWNER/CC LIVE CHECKS below):
 *
 *   setup      Service role. One [SYNTH] adhoc event with three instances:
 *                I1  future (+5 days 18:00 WIB), scheduled, active link L1 —
 *                    the D1–D4 drive target and the V5 public-form target.
 *                I2  TODAY 08:00–10:00 WIB, scheduled, active link L2 — already
 *                    ended (so rsvp_instance_metrics / the R7 chart include it)
 *                    yet still inside the submit window (WIB date <= end date).
 *                    Check-ins: M and W.
 *                I3  future (+6 days), scheduled, link L3 — holds s2 only.
 *              People (people.create audit): M (member), W (walk-in member),
 *              S (to be soft-deleted before anonymize).
 *              Seeded RSVP rows (the anonymize_person scenarios of
 *              tests/integration/rsvp-retention.test.ts:557-627 need rows that
 *              submit_rsvp cannot produce once the person is on the roster):
 *                Mpre  I2, newcomer row on M's phone (person_id NULL) — "L2"
 *                s1    I2, S's own row (person_id S)                 — "s1"
 *                s2    I3, newcomer row on S's phone (person_id NULL) — "s2"
 *              Writes the full public URL of L1 to a 0600 file for V5 (never
 *              printed).
 *   drive      Anon key + staging gate, the REAL submit_rsvp over raw HTTP (so
 *              the response bytes can be compared). Phones are typed in
 *              different raw formats and normalised with the compiled
 *              normalizePhone before the call:
 *                D1  M  on L1, coming, children 1, '0'-local, name 'Ignored Name'
 *                D2  N1 on L1, coming, children 2, '+62…' plain, followup true,
 *                    name '[SYNTH] UAT Newcomer'
 *                D3  N1 on L1, '+62 … …' spaced, not_coming, children 0, name
 *                    blank, followup false
 *                D4  N2 on L1, maybe, children 0, '0…-…-…' dashed, followup true
 *                E1  W  on L2, coming, '(0…) …' (W is checked in -> coming_came)
 *                E2  N1 on L2, coming, children 1
 *                E3  N2 on L2, maybe
 *              Negatives (count of I1 rows + rows on the probe phone, before
 *              and after each): wrong gate -> unavailable; unknown token ->
 *              closed; status 'yes' -> invalid.
 *              BYTE-IDENTICAL: raw body of D1 (member) === raw body of D2
 *              (newcomer), and deep-equal.
 *   anonymize  Service role, actor NULL (the R5 smoke convention). Soft-deletes
 *              S (people.soft_delete audit), snapshots updated_at of the four
 *              scrub targets and the admin-session crosstab of I1/I2/I3, then
 *              anonymize_person(M) and anonymize_person(S), then re-runs
 *              anonymize_person(M) (must return false and change nothing).
 *   verify     Read-only. Prints every assertion as PASS/FAIL.
 *   cleanup    attendance -> event (CASCADE: instances, links, RSVPs) -> assert
 *              zero RSVP rows -> delete the people (data.wipe audit) -> zero-
 *              residue assertion (events, instances, links, rsvps by id and by
 *              phone, attendance, people by id and by phone).
 *
 * Run (tsc->node, compiled path — libphonenumber-js must not run under tsx):
 *   npx tsc -p scripts/tsconfig.s9-r6-uat.json
 *   node --env-file=.env.staging.local scripts/.build/scripts/s9-r6-staging-uat.js setup
 *   node --env-file=.env.staging.local scripts/.build/scripts/s9-r6-staging-uat.js drive
 *   node --env-file=.env.staging.local scripts/.build/scripts/s9-r6-staging-uat.js anonymize
 *   node --env-file=.env.staging.local scripts/.build/scripts/s9-r6-staging-uat.js verify
 *   node --env-file=.env.staging.local scripts/.build/scripts/s9-r6-staging-uat.js cleanup
 *
 * LIVE CHECKS (staging browser, admin session) — order:
 *   setup -> drive -> V1(pre) -> V5 -> anonymize -> verify -> V1(post) -> V2 ->
 *   V3 -> V4 -> cleanup.
 *   V5 is the one public form submit: newcomer N3 (phone printed by "drive" as
 *   the V5 input, +62999 range), name '[SYNTH] UAT Web N3', coming, children 0,
 *   no follow-up. verify finds that row.
 *
 * GUARDS (every phase, before any read or write):
 *   1. Shared preflight guard (branch <-> ref map).
 *   2. Staging pin: resolved ref must be exactly STAGING_REF — no local, no prod.
 *   3. Env URL ref must equal STAGING_REF (no split-brain).
 * setup additionally: no state file from an earlier run (re-runs refused);
 *   every synthetic phone normalises to exactly itself, starts with +62999, and
 *   is absent from people and event_rsvps; WIB clock is past 10:00 (I2 ended).
 * drive / anonymize: refuse to run twice (state markers); the state event is
 *   [SYNTH], every instance belongs to it, every state person is [SYNTH]
 *   (or, after anonymize, anonymized by THIS run).
 *
 * STATE: scripts/.build/s9-r6-uat-state.json (gitignored, mode 0600): run id,
 * row ids, raw RPC response bodies, counts, updated_at and crosstab snapshots
 * (ids and buckets only). No phones, names or secrets. The V5 URL file
 * scripts/.build/s9-r6-uat-v5-url.txt (0600) holds the L1 link; cleanup
 * removes it.
 *
 * SECRETS: RSVP_GATE_SECRET is only ever sent as p_gate — never printed. Keys
 * are never printed. Phones are printed last-4 only, except the V5 input phone
 * (synthetic, +62999, needed to type into the form).
 *
 * AUDIT (CLAUDE.md rule 6): event.create, rsvp.link_create, people.create,
 * attendance.create, people.soft_delete on the way in; anonymize_person writes
 * its own people.anonymize rows; data.wipe per deleted person on cleanup. All
 * actorUserId = null (service_role/system path). audit_log rows are append-
 * only and excluded from the residue check.
 */

import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { normalizePhone } from '../lib/utils/phone'
import { AUDIT_ACTIONS, logAudit, type AuditAction } from '../lib/audit'

const STAGING_REF = 'sijfyvaodqkawbeuyrpu'
const SOURCE = 's9-r6-staging-uat'
const TAG = '[s9-r6-uat]'
const STATE_PATH = path.resolve(process.cwd(), 'scripts/.build/s9-r6-uat-state.json')
const V5_URL_PATH = path.resolve(process.cwd(), 'scripts/.build/s9-r6-uat-v5-url.txt')
const SYNTH = '[SYNTH]'
const ADMIN_EMAIL = 'admin@example.com'

const NAME = {
  M: '[SYNTH] UAT B Member M',
  W: '[SYNTH] UAT B Walk-in W',
  S: '[SYNTH] UAT B Soft S',
  Mpre: '[SYNTH] UAT B M pre-roster',
  s2: '[SYNTH] UAT B S pre-roster',
  N1: '[SYNTH] UAT Newcomer',
  N2: '[SYNTH] UAT Newcomer N2',
  N3: '[SYNTH] UAT Web N3',
} as const

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
    console.error('=================== PREFLIGHT ABORT (s9-r6-staging-uat) ===================')
    console.error(`  branch:        ${branch || '(empty/detached)'}`)
    console.error(`  op:            ${op}`)
    console.error(`  resolved ref:  ${resolved.ref ?? '(none)'} (local=${resolved.local})`)
    console.error(`  reason:        ${result.reason}`)
    console.error('============================================================================')
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

type PhoneKey = 'M' | 'W' | 'S' | 'N1' | 'N2' | 'N3' | 'X'
const PHONE_KEYS: PhoneKey[] = ['M', 'W', 'S', 'N1', 'N2', 'N3', 'X']

/** Fresh synthetic phones in the +62999 shape, derived from the run id. */
function phonesFor(runId: number): Record<PhoneKey, string> {
  const out = {} as Record<PhoneKey, string>
  PHONE_KEYS.forEach((k, i) => {
    out[k] = `+62999${((runId + i) % 10_000_000).toString().padStart(7, '0')}`
  })
  return out
}

const last4 = (p: string) => `…${p.slice(-4)}`

/** The raw shapes a visitor might type. n = the 10 national digits after +62. */
const typed = {
  local: (e164: string) => `0${e164.slice(3)}`,
  plain: (e164: string) => e164,
  spaced: (e164: string) => { const n = e164.slice(3); return `+62 ${n.slice(0, 3)} ${n.slice(3, 7)} ${n.slice(7)}` },
  dashed: (e164: string) => { const n = e164.slice(3); return `0${n.slice(0, 3)}-${n.slice(3, 7)}-${n.slice(7)}` },
  paren: (e164: string) => { const n = e164.slice(3); return `(0${n.slice(0, 3)}) ${n.slice(3)}` },
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

type InstanceKey = 'I1' | 'I2' | 'I3'
const INSTANCE_KEYS: InstanceKey[] = ['I1', 'I2', 'I3']

type SubmitRecord = { id: string; label: string; typed: string; normalisedOk: boolean; raw: string; expected: unknown; pass: boolean }
type NegativeRecord = { id: string; label: string; raw: string; expectedCode: string; i1Before: number; i1After: number; phoneBefore: number; phoneAfter: number; pass: boolean }

type State = {
  runId: number
  createdAt: string
  adminId: string
  eventId: string
  i2WibDate: string
  instances: Record<InstanceKey, string>
  links: Record<'L1' | 'L2' | 'L3', string>
  people: Record<'M' | 'W' | 'S', string>
  seeded: Record<'Mpre' | 's1' | 's2', string>
  drive: null | {
    at: string
    submits: SubmitRecord[]
    negatives: NegativeRecord[]
    byteIdentical: { d1: string; d2: string; equalBytes: boolean; deepEqual: boolean }
  }
  anonymize: null | {
    at: string
    rsvpIds: Record<'l1' | 'l2' | 's1' | 's2', string>
    updatedAtBefore: Record<string, string>
    crosstabBefore: Record<InstanceKey, CrosstabRow[]>
    resultM: unknown
    resultS: unknown
    rerunM: unknown
    l2BeforeRerun: unknown
    l2AfterRerun: unknown
  }
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

async function audit(supabase: SupabaseClient, action: AuditAction, entityType: string, entityId: string): Promise<void> {
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

async function countWhere(supabase: SupabaseClient, table: string, column: string, values: string[]): Promise<number> {
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

/** Calendar parts of "now + days" in WIB (UTC+7, no DST). */
function wibParts(days: number): { date: string; hour: number } {
  const wib = new Date(Date.now() + days * 86_400_000 + 7 * 3_600_000)
  return { date: wib.toISOString().slice(0, 10), hour: wib.getUTCHours() }
}

/** HH:00 WIB on a WIB date, as an ISO instant. */
function wibInstant(date: string, hour: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCHours(hour - 7)
  return d.toISOString()
}

type Env = { url: string; serviceKey: string; anonKey: string; gate: string; appUrl: string }

async function pinStaging(op: string): Promise<Env> {
  const resolved = await runPreflightGuard(op)
  if (resolved.local || resolved.ref !== STAGING_REF) {
    abort(`resolved ref ${resolved.ref ?? '(none)'} (local=${resolved.local}) is not staging (${STAGING_REF}) — refusing`)
  }
  console.log(`[staging-pin] OK -- ref=${resolved.ref}`)

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const gate = process.env.RSVP_GATE_SECRET
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!url || !serviceKey || !anonKey || !gate || !appUrl) {
    abort('missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY / RSVP_GATE_SECRET / NEXT_PUBLIC_APP_URL — pass --env-file explicitly')
  }
  let supabaseHost: string
  try {
    supabaseHost = new URL(url).hostname
  } catch {
    abort('NEXT_PUBLIC_SUPABASE_URL is not a URL')
  }
  if (supabaseHost !== `${STAGING_REF}.supabase.co`) abort(`env Supabase host ${supabaseHost} is not the staging project — refusing`)

  let appOrigin: string
  try {
    const parsed = new URL(appUrl)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('protocol')
    appOrigin = parsed.origin
  } catch {
    abort('NEXT_PUBLIC_APP_URL is not an http(s) URL')
  }
  return { url, serviceKey, anonKey, gate, appUrl: appOrigin }
}

const serviceClient = (env: Env) =>
  createClient(env.url, env.serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })

/** In-memory admin session (magic-link token minted with the service role; no email sent). */
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

/**
 * submit_rsvp over raw PostgREST with the anon key, so the exact response
 * bytes are kept. Same RPC, same grant (anon) as createAnonServerClient().
 */
async function submitRaw(env: Env, args: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${env.url}/rest/v1/rpc/submit_rsvp`, {
    method: 'POST',
    headers: { apikey: env.anonKey, Authorization: `Bearer ${env.anonKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  const text = await res.text()
  if (res.status !== 200) return `HTTP ${res.status}`
  return text
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
  event_instance_id: string
  phone_e164: string | null
  name: string | null
  person_id: string | null
  retained_person_id: string | null
  status: string
  children_count: number
  followup_consent: boolean
  anonymized_at: string | null
  created_at: string
  updated_at: string
}
const RSVP_COLS = 'id, event_instance_id, phone_e164, name, person_id, retained_person_id, status, children_count, followup_consent, anonymized_at, created_at, updated_at'

async function readRsvps(service: SupabaseClient, instanceId: string): Promise<RsvpRow[]> {
  const { data, error } = await service.from('event_rsvps').select(RSVP_COLS).eq('event_instance_id', instanceId)
  if (error) throw new Error(`read rsvps failed: ${error.message}`)
  return (data ?? []) as RsvpRow[]
}

async function rsvpCountOnPhone(service: SupabaseClient, phone: string): Promise<number> {
  return countWhere(service, 'event_rsvps', 'phone_e164', [phone])
}

/** Every state row must still be ours and synthetic. Anonymized-by-this-run people pass on id + anonymized_at. */
async function assertSyntheticFixture(service: SupabaseClient, state: State, requirePresent: boolean): Promise<void> {
  const { data: ev, error: evErr } = await service.from('events').select('id, name').eq('id', state.eventId).maybeSingle()
  if (evErr) throw new Error(`event lookup failed: ${evErr.message}`)
  if (ev && !(ev as { name: string }).name.startsWith(SYNTH)) abort('state event is not a [SYNTH] event — refusing')
  if (requirePresent && !ev) abort('state event no longer exists — run "cleanup"')

  const instIds = Object.values(state.instances).filter(Boolean)
  if (instIds.length > 0) {
    const { data, error } = await service.from('event_instances').select('id, event_id').in('id', instIds)
    if (error) throw new Error(`instance lookup failed: ${error.message}`)
    for (const i of (data ?? []) as Array<{ event_id: string }>) {
      if (i.event_id !== state.eventId) abort('a state instance does not belong to the state event — refusing')
    }
    if (requirePresent && (data ?? []).length !== instIds.length) abort('a state instance no longer exists — run "cleanup"')
  }

  const personIds = Object.values(state.people).filter(Boolean)
  if (personIds.length > 0) {
    const { data, error } = await service.from('people').select('id, full_name, anonymized_at').in('id', personIds)
    if (error) throw new Error(`people lookup failed: ${error.message}`)
    for (const p of (data ?? []) as Array<{ id: string; full_name: string; anonymized_at: string | null }>) {
      const anonymizedByUs = state.anonymize !== null && p.anonymized_at !== null && (p.id === state.people.M || p.id === state.people.S)
      if (!p.full_name.startsWith(SYNTH) && !anonymizedByUs) abort('a state person is not [SYNTH] — refusing; inspect manually')
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

function parseBody(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Phase: setup
// ---------------------------------------------------------------------------

async function setup(): Promise<void> {
  const env = await pinStaging('staging-rsvp-r6b-uat-setup')
  if (existsSync(STATE_PATH)) abort(`state file ${STATE_PATH} exists — run "cleanup" for the previous run first (re-runs are refused)`)

  const today = wibParts(0)
  if (today.hour < 11) abort(`WIB hour is ${today.hour}: I2 (08:00–10:00 WIB today) would not have ended yet — run after 11:00 WIB`)
  if (today.hour >= 23) abort('too close to WIB midnight: the I2 submit window closes at the end of today — run tomorrow')

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
  const adminId = await activeAppUserId(service, ADMIN_EMAIL)

  const i1Date = wibParts(5).date
  const i3Date = wibParts(6).date
  const eventName = `[SYNTH] S9-R6 B UAT ${runId}`

  // ── writes ──────────────────────────────────────────────────────────────
  const eventId = await insertOne(service, 'events', {
    name: eventName,
    name_id: eventName,
    event_type: 'adhoc',
    start_date: today.date,
    start_time: '08:00',
    duration_min: 120,
    location: '[SYNTH] Aula Uji',
    recurrence_rule: null,
    created_by: adminId,
  })
  await audit(service, AUDIT_ACTIONS.EVENT_CREATE, 'event', eventId)

  // State after every insert so a failure still leaves something for "cleanup".
  const state: State = {
    runId,
    createdAt: new Date().toISOString(),
    adminId,
    eventId,
    i2WibDate: today.date,
    instances: { I1: '', I2: '', I3: '' },
    links: { L1: '', L2: '', L3: '' },
    people: { M: '', W: '', S: '' },
    seeded: { Mpre: '', s1: '', s2: '' },
    drive: null,
    anonymize: null,
  }
  writeState(state)

  const instanceAt: Record<InstanceKey, string> = {
    I1: wibInstant(i1Date, 18),
    I2: wibInstant(today.date, 8),
    I3: wibInstant(i3Date, 18),
  }
  for (const k of INSTANCE_KEYS) {
    state.instances[k] = await insertOne(service, 'event_instances', {
      event_id: eventId,
      scheduled_at: instanceAt[k],
      event_name_snapshot: eventName,
      event_name_snapshot_id: eventName,
      status: 'scheduled',
      image_url: null,
    })
    writeState(state)
  }

  const linkFor: Record<'L1' | 'L2' | 'L3', InstanceKey> = { L1: 'I1', L2: 'I2', L3: 'I3' }
  for (const l of ['L1', 'L2', 'L3'] as const) {
    state.links[l] = await insertOne(service, 'event_rsvp_links', { event_instance_id: state.instances[linkFor[l]], created_by: adminId })
    await audit(service, AUDIT_ACTIONS.RSVP_LINK_CREATE, 'event_rsvp_link', state.links[l])
    writeState(state)
  }

  for (const k of ['M', 'W', 'S'] as const) {
    state.people[k] = await insertOne(service, 'people', { full_name: NAME[k], nickname: k, phone_e164: phones[k] })
    await audit(service, AUDIT_ACTIONS.PEOPLE_CREATE, 'person', state.people[k])
    writeState(state)
  }

  // I2 check-ins: M and W.
  for (const k of ['M', 'W'] as const) {
    const id = await insertOne(service, 'attendance', {
      event_instance_id: state.instances.I2,
      person_id: state.people[k],
      checked_in_by: adminId,
      source: 'volunteer_checkin',
    })
    await audit(service, AUDIT_ACTIONS.ATTENDANCE_CREATE, 'attendance', id)
  }

  // Seeded rows — answers given before M / S were matched (see header).
  const seed = (instance: InstanceKey, link: 'L2' | 'L3', phone: string, name: string | null, personId: string | null) =>
    insertOne(service, 'event_rsvps', {
      event_instance_id: state.instances[instance],
      link_id: state.links[link],
      phone_e164: phone,
      name,
      children_count: 0,
      followup_consent: true,
      status: 'coming',
      person_id: personId,
    })
  state.seeded.Mpre = await seed('I2', 'L2', phones.M, NAME.Mpre, null)
  state.seeded.s1 = await seed('I2', 'L2', phones.S, null, state.people.S)
  state.seeded.s2 = await seed('I3', 'L3', phones.S, NAME.s2, null)
  writeState(state)

  // L1's full public URL for V5 — to a 0600 file, never to stdout.
  const { data: l1, error: l1Err } = await service.from('event_rsvp_links').select('token').eq('id', state.links.L1).single()
  if (l1Err || !l1) throw new Error(`read L1 token failed: ${l1Err?.message}`)
  writeFileSync(V5_URL_PATH, `${env.appUrl}/rsvp/${encodeURIComponent((l1 as { token: string }).token)}\n`, { mode: 0o600 })

  console.log('')
  console.log(`${TAG} setup done (run ${runId}):`)
  console.log(`  - event "${eventName}"`)
  console.log(`  - I1 ${i1Date} 18:00 WIB + L1 · I2 ${today.date} 08:00–10:00 WIB (ended) + L2 · I3 ${i3Date} 18:00 WIB + L3`)
  console.log(`  - people M ${last4(phones.M)}, W ${last4(phones.W)}, S ${last4(phones.S)}; I2 check-ins M, W`)
  console.log('  - seeded: Mpre (I2, newcomer on M\'s phone), s1 (I2, S\'s own row), s2 (I3, newcomer on S\'s phone)')
  console.log(`  - V5 URL file: ${path.relative(process.cwd(), V5_URL_PATH)} (0600)`)
  console.log(`  - state: ${path.relative(process.cwd(), STATE_PATH)}`)
  console.log('')
  console.log('NEXT: node --env-file=.env.staging.local scripts/.build/scripts/s9-r6-staging-uat.js drive')
}

// ---------------------------------------------------------------------------
// Phase: drive
// ---------------------------------------------------------------------------

async function drive(): Promise<void> {
  const env = await pinStaging('staging-rsvp-r6b-uat-drive')
  const state = readState()
  if (!state.seeded.s2) abort('state is incomplete — setup did not finish; run "cleanup" then "setup"')
  if (state.drive) abort(`already driven at ${state.drive.at} — re-runs are refused`)

  const phones = phonesFor(state.runId)
  const service = serviceClient(env)
  await assertSyntheticFixture(service, state, true)
  for (const k of ['N1', 'N2', 'N3', 'X'] as const) {
    if ((await countWhere(service, 'people', 'phone_e164', [phones[k]])) > 0) abort(`newcomer phone ${k} is on the roster — refusing`)
    if ((await rsvpCountOnPhone(service, phones[k])) > 0) abort(`newcomer phone ${k} already has RSVP rows — refusing`)
  }

  const tokenOf = async (linkId: string) => {
    const { data, error } = await service.from('event_rsvp_links').select('token').eq('id', linkId).single()
    if (error || !data) throw new Error(`read token failed: ${error?.message}`)
    return (data as { token: string }).token
  }
  const T1 = await tokenOf(state.links.L1)
  const T2 = await tokenOf(state.links.L2)

  type Spec = {
    id: string; label: string; token: string; phone: PhoneKey; fmt: keyof typeof typed
    name: string | null; children: number; followup: boolean; status: string
  }
  const SPECS: Spec[] = [
    { id: 'D1', label: 'M member on L1, coming, children 1, name sent "Ignored Name"', token: T1, phone: 'M', fmt: 'local', name: 'Ignored Name', children: 1, followup: false, status: 'coming' },
    { id: 'D2', label: 'N1 newcomer on L1, coming, children 2, followup true', token: T1, phone: 'N1', fmt: 'plain', name: NAME.N1, children: 2, followup: true, status: 'coming' },
    { id: 'D3', label: 'N1 update on L1, not_coming, children 0, name blank, followup false', token: T1, phone: 'N1', fmt: 'spaced', name: '', children: 0, followup: false, status: 'not_coming' },
    { id: 'D4', label: 'N2 newcomer on L1, maybe, children 0, followup true', token: T1, phone: 'N2', fmt: 'dashed', name: NAME.N2, children: 0, followup: true, status: 'maybe' },
    { id: 'E1', label: 'W member on L2 (checked in), coming', token: T2, phone: 'W', fmt: 'paren', name: null, children: 0, followup: false, status: 'coming' },
    { id: 'E2', label: 'N1 newcomer on L2, coming, children 1', token: T2, phone: 'N1', fmt: 'plain', name: NAME.N1, children: 1, followup: false, status: 'coming' },
    { id: 'E3', label: 'N2 newcomer on L2, maybe', token: T2, phone: 'N2', fmt: 'local', name: NAME.N2, children: 0, followup: false, status: 'maybe' },
  ]

  const submits: SubmitRecord[] = []
  for (const s of SPECS) {
    const raw = typed[s.fmt](phones[s.phone])
    const n = normalizePhone(raw, 'ID')
    const normalisedOk = n.ok && n.e164 === phones[s.phone]
    let body = 'NOT SENT (normalisation mismatch)'
    if (normalisedOk && n.ok) {
      body = await submitRaw(env, {
        p_gate: env.gate,
        p_token: s.token,
        p_phone_e164: n.e164,
        p_name: s.name,
        p_children_count: s.children,
        p_followup_consent: s.followup,
        p_status: s.status,
      })
    }
    const pass = normalisedOk && isDeepStrictEqual(parseBody(body), { ok: true })
    // The typed value is printed masked: keep the format visible, hide the digits.
    const shownTyped = raw.replace(/\d(?=(?:\D*\d){4})/g, '•')
    submits.push({ id: s.id, label: s.label, typed: `${s.fmt} "${shownTyped}"`, normalisedOk, raw: body, expected: { ok: true }, pass })
  }

  // Negatives — none may write a row.
  const NEG: Array<{ id: string; label: string; args: Record<string, unknown>; code: string }> = [
    { id: 'X1', label: 'wrong gate', code: 'unavailable', args: { p_gate: `wrong-${state.runId}`, p_token: T1, p_phone_e164: phones.X, p_name: null, p_children_count: 0, p_followup_consent: false, p_status: 'coming' } },
    { id: 'X2', label: 'unknown token', code: 'closed', args: { p_gate: env.gate, p_token: `uat-unknown-${state.runId}`, p_phone_e164: phones.X, p_name: null, p_children_count: 0, p_followup_consent: false, p_status: 'coming' } },
    { id: 'X3', label: "status 'yes'", code: 'invalid', args: { p_gate: env.gate, p_token: T1, p_phone_e164: phones.X, p_name: null, p_children_count: 0, p_followup_consent: false, p_status: 'yes' } },
  ]
  const negatives: NegativeRecord[] = []
  for (const x of NEG) {
    const i1Before = await countWhere(service, 'event_rsvps', 'event_instance_id', [state.instances.I1])
    const phoneBefore = await rsvpCountOnPhone(service, phones.X)
    const raw = await submitRaw(env, x.args)
    const i1After = await countWhere(service, 'event_rsvps', 'event_instance_id', [state.instances.I1])
    const phoneAfter = await rsvpCountOnPhone(service, phones.X)
    const pass = isDeepStrictEqual(parseBody(raw), { ok: false, code: x.code }) && i1Before === i1After && phoneBefore === phoneAfter && phoneAfter === 0
    negatives.push({ id: x.id, label: x.label, raw, expectedCode: x.code, i1Before, i1After, phoneBefore, phoneAfter, pass })
  }

  const d1 = submits.find(s => s.id === 'D1')!.raw
  const d2 = submits.find(s => s.id === 'D2')!.raw
  const byteIdentical = { d1, d2, equalBytes: Buffer.from(d1).equals(Buffer.from(d2)), deepEqual: isDeepStrictEqual(parseBody(d1), parseBody(d2)) }

  state.drive = { at: new Date().toISOString(), submits, negatives, byteIdentical }
  writeState(state)

  const checks: CheckRow[] = [
    ...submits.map(s => ({ id: s.id, label: `${s.label} [typed ${s.typed}]`, pass: s.pass, detail: `normalised=${s.normalisedOk} raw=${s.raw}` })),
    ...negatives.map(n => ({
      id: n.id,
      label: `${n.label} -> ${n.expectedCode}, writes nothing`,
      pass: n.pass,
      detail: `raw=${n.raw} I1 ${n.i1Before}->${n.i1After} probe-phone ${n.phoneBefore}->${n.phoneAfter}`,
    })),
    {
      id: 'BYTE',
      label: 'D1 (member) and D2 (newcomer) raw responses byte-identical and deep-equal',
      pass: byteIdentical.equalBytes && byteIdentical.deepEqual,
      detail: `D1=${d1} D2=${d2}`,
    },
  ]
  printChecks(checks)
  if (checks.some(c => !c.pass)) abort('a drive result differs from the expectation — STOP; fixtures kept, do not run cleanup until reported')

  console.log('')
  console.log(`V5 input (public form on L1): phone ${typed.local(phones.N3)} · name "${NAME.N3}" · Coming · children 0 · no follow-up`)
  console.log(`V5 URL: in ${path.relative(process.cwd(), V5_URL_PATH)}`)
  console.log('NEXT: V1(pre) and V5 in the browser, then: node --env-file=.env.staging.local scripts/.build/scripts/s9-r6-staging-uat.js anonymize')
}

// ---------------------------------------------------------------------------
// Phase: anonymize
// ---------------------------------------------------------------------------

async function anonymizePhase(): Promise<void> {
  const env = await pinStaging('staging-rsvp-r6b-uat-anonymize')
  const state = readState()
  if (!state.drive) abort('run "drive" first')
  if (state.anonymize) abort(`already anonymized at ${state.anonymize.at} — re-runs are refused`)

  const phones = phonesFor(state.runId)
  const service = serviceClient(env)
  await assertSyntheticFixture(service, state, true)

  // l1 = D1 (M's own row on I1); l2 = Mpre; s1, s2 seeded.
  const { data: l1Row, error: l1Err } = await service.from('event_rsvps').select('id')
    .eq('event_instance_id', state.instances.I1).eq('person_id', state.people.M).single()
  if (l1Err || !l1Row) abort(`D1 row for M on I1 not found (${l1Err?.message ?? 'none'})`)
  const rsvpIds = { l1: (l1Row as { id: string }).id, l2: state.seeded.Mpre, s1: state.seeded.s1, s2: state.seeded.s2 }

  // S is soft-deleted first (the "already soft-deleted person" scenario).
  {
    const now = new Date().toISOString()
    const { error } = await service.from('people').update({ deleted_at: now, updated_at: now }).eq('id', state.people.S)
    if (error) throw new Error(`soft-delete S failed: ${error.message}`)
    await audit(service, AUDIT_ACTIONS.PEOPLE_SOFT_DELETE, 'person', state.people.S)
  }

  const updatedAtBefore: Record<string, string> = {}
  for (const id of Object.values(rsvpIds)) {
    const { data, error } = await service.from('event_rsvps').select('updated_at').eq('id', id).single()
    if (error || !data) throw new Error(`read updated_at failed: ${error?.message}`)
    updatedAtBefore[id] = (data as { updated_at: string }).updated_at
  }
  const admin = await adminSession(env, service)
  const crosstabBefore = {} as Record<InstanceKey, CrosstabRow[]>
  for (const k of INSTANCE_KEYS) crosstabBefore[k] = await readCrosstab(admin, state.instances[k])

  const anonymize = async (personId: string) => {
    const { data, error } = await service.rpc('anonymize_person', { p_person_id: personId, p_actor_user_id: null, p_trigger_source: 'admin' })
    return error ? { error: error.code } : data
  }
  const resultM = await anonymize(state.people.M)
  const resultS = await anonymize(state.people.S)

  const readOne = async (id: string) => {
    const { data, error } = await service.from('event_rsvps').select(RSVP_COLS).eq('id', id).single()
    if (error || !data) throw new Error(`read rsvp failed: ${error?.message}`)
    return data
  }
  const l2BeforeRerun = await readOne(rsvpIds.l2)
  const rerunM = await anonymize(state.people.M)
  const l2AfterRerun = await readOne(rsvpIds.l2)

  state.anonymize = { at: new Date().toISOString(), rsvpIds, updatedAtBefore, crosstabBefore, resultM, resultS, rerunM, l2BeforeRerun, l2AfterRerun }
  writeState(state)

  console.log(`${TAG} S soft-deleted; anonymize_person(M)=${JSON.stringify(resultM)} anonymize_person(S)=${JSON.stringify(resultS)} re-run(M)=${JSON.stringify(rerunM)}`)
  console.log(`${TAG} M's phone ${last4(phones.M)} and S's phone ${last4(phones.S)} are now scrubbed from people and their RSVP rows`)
  console.log('NEXT: node --env-file=.env.staging.local scripts/.build/scripts/s9-r6-staging-uat.js verify')
}

// ---------------------------------------------------------------------------
// Phase: verify (read-only)
// ---------------------------------------------------------------------------

async function verify(): Promise<void> {
  const env = await pinStaging('staging-rsvp-r6b-uat-verify')
  const state = readState()
  if (!state.drive || !state.anonymize) abort('run "setup", "drive" and "anonymize" first')

  const phones = phonesFor(state.runId)
  const service = serviceClient(env)
  await assertSyntheticFixture(service, state, true)
  const A = state.anonymize
  const checks: CheckRow[] = []
  const add = (id: string, label: string, pass: boolean, detail: string) => checks.push({ id, label, pass, detail })

  // ── drive results (recorded at drive time) ───────────────────────────────
  for (const s of state.drive.submits) add(`drive-${s.id}`, `${s.id} response {ok:true}`, s.pass, `raw=${s.raw}`)
  for (const n of state.drive.negatives) {
    add(`neg-${n.id}`, `${n.label} -> ${n.expectedCode}; 0 rows written`, n.pass, `raw=${n.raw} I1 ${n.i1Before}->${n.i1After} probe ${n.phoneBefore}->${n.phoneAfter}`)
  }
  const b = state.drive.byteIdentical
  add('byte', 'D1 member vs D2 newcomer raw responses byte-identical', b.equalBytes && b.deepEqual, `D1=${b.d1} D2=${b.d2}`)
  add('neg-X-now', 'probe phone X still has 0 RSVP rows', (await rsvpCountOnPhone(service, phones.X)) === 0, `rows=${await rsvpCountOnPhone(service, phones.X)}`)

  // ── I1 rows ──────────────────────────────────────────────────────────────
  const i1 = await readRsvps(service, state.instances.I1)
  const d1 = i1.find(r => r.id === A.rsvpIds.l1)
  add('D1', 'D1 row: person_id = M, name NULL (sent name ignored), coming, children 1',
    !!d1 && d1.person_id === state.people.M && d1.name === null && d1.status === 'coming' && d1.children_count === 1,
    d1 ? `person=M:${d1.person_id === state.people.M} name=${JSON.stringify(d1.name)} status=${d1.status} children=${d1.children_count}` : 'missing')

  const n1 = i1.filter(r => r.phone_e164 === phones.N1)
  const n1r = n1[0]
  add('D2/D3', 'ONE row for N1 on I1: not_coming, children 0, name kept from D2, followup false (D3), updated after created',
    n1.length === 1 && !!n1r && n1r.status === 'not_coming' && n1r.children_count === 0 && n1r.name === NAME.N1 &&
      n1r.followup_consent === false && n1r.person_id === null && new Date(n1r.updated_at) > new Date(n1r.created_at),
    n1r ? `rows=${n1.length} status=${n1r.status} children=${n1r.children_count} name=${JSON.stringify(n1r.name)} followup=${n1r.followup_consent} updated>created=${new Date(n1r.updated_at) > new Date(n1r.created_at)}` : `rows=${n1.length}`)

  const n2 = i1.filter(r => r.phone_e164 === phones.N2)
  add('D4', 'N2 on I1: one row, maybe, children 0, followup true',
    n2.length === 1 && n2[0]!.status === 'maybe' && n2[0]!.children_count === 0 && n2[0]!.followup_consent === true,
    n2[0] ? `rows=${n2.length} status=${n2[0].status} children=${n2[0].children_count} followup=${n2[0].followup_consent}` : `rows=${n2.length}`)

  const n3 = i1.filter(r => r.phone_e164 === phones.N3)
  add('V5', 'V5 public-form row for N3 on I1: one row, coming, children 0, name "[SYNTH] UAT Web N3", newcomer',
    n3.length === 1 && n3[0]!.status === 'coming' && n3[0]!.children_count === 0 && n3[0]!.name === NAME.N3 && n3[0]!.person_id === null,
    n3[0] ? `rows=${n3.length} status=${n3[0].status} children=${n3[0].children_count} name=${JSON.stringify(n3[0].name)} followup=${n3[0].followup_consent}` : `rows=${n3.length}`)

  const byStatus = (rows: RsvpRow[]) => rows.reduce<Record<string, number>>((acc, r) => { acc[r.status] = (acc[r.status] ?? 0) + 1; return acc }, {})
  const i1Status = byStatus(i1)
  add('I1-total', 'I1 rows = 4 (D1, N1, N2 driven + V5 N3)', i1.length === 4, `rows=${i1.length}`)
  add('I1-status', 'I1 totals by status: coming 2 · not_coming 1 · maybe 1',
    isDeepStrictEqual(i1Status, { coming: 2, not_coming: 1, maybe: 1 }), JSON.stringify(i1Status))

  // ── I2 rows (chart data) ────────────────────────────────────────────────
  const i2 = await readRsvps(service, state.instances.I2)
  const w = i2.find(r => r.person_id === state.people.W)
  add('E1', 'W on I2: member row, coming', !!w && w.status === 'coming' && w.name === null, w ? `status=${w.status}` : 'missing')
  const i2Status = byStatus(i2)
  add('I2-total', 'I2 rows = 5 (Mpre, s1 seeded + W, N1, N2 driven); coming 4 · maybe 1',
    i2.length === 5 && isDeepStrictEqual(i2Status, { coming: 4, maybe: 1 }), `rows=${i2.length} ${JSON.stringify(i2Status)}`)

  // ── anonymize_person scenarios (rsvp-retention.test.ts:557-627) ─────────
  add('anon-result', 'anonymize_person(M) and (S) returned true',
    A.resultM === true && A.resultS === true, `M=${JSON.stringify(A.resultM)} S=${JSON.stringify(A.resultS)}`)

  const byId = new Map<string, RsvpRow>()
  for (const id of Object.values(A.rsvpIds)) {
    const { data, error } = await service.from('event_rsvps').select(RSVP_COLS).eq('id', id).single()
    if (error || !data) throw new Error(`read rsvp ${id} failed: ${error?.message}`)
    byId.set(id, data as RsvpRow)
  }
  const l1 = byId.get(A.rsvpIds.l1)!
  add('anon-l1', 'live member, own row (D1): phone/name NULL, person_id = M kept, retained NULL, anonymized_at set',
    l1.phone_e164 === null && l1.name === null && l1.person_id === state.people.M && l1.retained_person_id === null && l1.anonymized_at !== null,
    `phone=${l1.phone_e164} name=${l1.name} person=M:${l1.person_id === state.people.M} retained=${l1.retained_person_id} anonymized=${l1.anonymized_at !== null}`)
  const l2 = byId.get(A.rsvpIds.l2)!
  add('anon-l2', 'live member, newcomer row on M\'s phone (Mpre): scrubbed AND frozen (retained = M)',
    l2.phone_e164 === null && l2.name === null && l2.person_id === null && l2.retained_person_id === state.people.M && l2.anonymized_at !== null,
    `phone=${l2.phone_e164} name=${l2.name} person=${l2.person_id} retained=M:${l2.retained_person_id === state.people.M} anonymized=${l2.anonymized_at !== null}`)
  const s1 = byId.get(A.rsvpIds.s1)!
  add('anon-s1', 'soft-deleted person, own row: phone NULL, person_id = S kept, retained NULL',
    s1.phone_e164 === null && s1.person_id === state.people.S && s1.retained_person_id === null && s1.anonymized_at !== null,
    `phone=${s1.phone_e164} person=S:${s1.person_id === state.people.S} retained=${s1.retained_person_id}`)
  const s2 = byId.get(A.rsvpIds.s2)!
  add('anon-s2', 'soft-deleted person, newcomer row on S\'s phone: scrubbed, NOT frozen (retained NULL)',
    s2.phone_e164 === null && s2.name === null && s2.person_id === null && s2.retained_person_id === null && s2.anonymized_at !== null,
    `phone=${s2.phone_e164} name=${s2.name} person=${s2.person_id} retained=${s2.retained_person_id} anonymized=${s2.anonymized_at !== null}`)

  const keptUpdated = Object.values(A.rsvpIds).filter(id => byId.get(id)!.updated_at === A.updatedAtBefore[id]).length
  add('anon-updated_at', 'updated_at of all 4 scrubbed rows unchanged', keptUpdated === 4, `${keptUpdated}/4 unchanged`)

  const admin = await adminSession(env, service)
  for (const k of INSTANCE_KEYS) {
    const now = await readCrosstab(admin, state.instances[k])
    const same = isDeepStrictEqual(now, A.crosstabBefore[k])
    add(`anon-xtab-${k}`, `crosstab ${k} unchanged by anonymize (admin session)`, same,
      same ? `ok (${now.length} rows; buckets ${now.map(r => r.bucket).sort().join(',')})` : `CHANGED: ${now.length} vs ${A.crosstabBefore[k].length}`)
  }

  const auditRows = async (personId: string) => {
    const { data, error } = await service.from('audit_log').select('details_json').eq('action', AUDIT_ACTIONS.PEOPLE_ANONYMIZE).eq('entity_id', personId)
    if (error) throw new Error(`audit read failed: ${error.message}`)
    return (data ?? []) as Array<{ details_json: Record<string, unknown> }>
  }
  const auM = await auditRows(state.people.M)
  const auS = await auditRows(state.people.S)
  add('anon-audit', 'one people.anonymize audit row each; M trigger admin rsvp_rows 2; S rsvp_rows 2',
    auM.length === 1 && auM[0]!.details_json.trigger === 'admin' && auM[0]!.details_json.rsvp_rows === 2 &&
      auS.length === 1 && auS[0]!.details_json.rsvp_rows === 2,
    `M rows=${auM.length} rsvp_rows=${String(auM[0]?.details_json.rsvp_rows)} · S rows=${auS.length} rsvp_rows=${String(auS[0]?.details_json.rsvp_rows)}`)

  add('anon-rerun', 're-run anonymize_person(M): false, Mpre row unchanged',
    A.rerunM === false && isDeepStrictEqual(A.l2BeforeRerun, A.l2AfterRerun), `rerun=${JSON.stringify(A.rerunM)} unchanged=${isDeepStrictEqual(A.l2BeforeRerun, A.l2AfterRerun)}`)

  printChecks(checks)
  if (checks.some(c => !c.pass)) abort('verify failed — STOP; fixtures kept for inspection, do not run cleanup until reported')
  console.log('')
  console.log('Live checks (admin, staging alias):')
  console.log(`  V1/V2  ${env.appUrl}/admin/events/${state.eventId}/instances/${state.instances.I1}`)
  console.log(`  V3     ${env.appUrl}/admin/people/${state.people.M}`)
  console.log(`  V4     ${env.appUrl}/admin/analytics?from=${state.i2WibDate}&to=${state.i2WibDate}&eventType=adhoc`)
  console.log('When done: node --env-file=.env.staging.local scripts/.build/scripts/s9-r6-staging-uat.js cleanup')
}

// ---------------------------------------------------------------------------
// Phase: cleanup
// ---------------------------------------------------------------------------

async function cleanup(): Promise<void> {
  const env = await pinStaging('staging-rsvp-r6b-uat-cleanup')
  const state = readState()
  const phones = phonesFor(state.runId)
  const service = serviceClient(env)

  await assertSyntheticFixture(service, state, false)

  const instanceIds = Object.values(state.instances).filter(Boolean)
  const linkIds = Object.values(state.links).filter(Boolean)
  const personIds = Object.values(state.people).filter(Boolean)
  const seededIds = Object.values(state.seeded).filter(Boolean)
  const del = async (table: string, column: string, values: string[]) => {
    const ids = values.filter(v => v !== '')
    if (ids.length === 0) return
    const { error } = await service.from(table).delete().in(column, ids)
    if (error) throw new Error(`delete ${table} failed: ${error.message}`)
  }

  // attendance.person_id has no ON DELETE, so it goes first; then the event:
  // CASCADE to the instances, their links and RSVPs (incl. the V5 row).
  await del('child_attendance', 'event_instance_id', instanceIds)
  await del('attendance', 'event_instance_id', instanceIds)
  await del('events', 'id', [state.eventId])

  // event_rsvps.person_id / retained_person_id are NO ACTION: people go last.
  const rsvpLeft =
    (await countWhere(service, 'event_rsvps', 'event_instance_id', instanceIds)) +
    (await countWhere(service, 'event_rsvps', 'person_id', personIds)) +
    (await countWhere(service, 'event_rsvps', 'retained_person_id', personIds))
  if (rsvpLeft !== 0) abort(`${rsvpLeft} RSVP row(s) remain after the event delete — people NOT deleted; state file kept`)
  console.log('[cleanup] event deleted (cascade: 3 instances, 3 links, all RSVPs); zero RSVP rows remain')

  let deleted = 0
  for (const id of personIds) {
    const { data, error: readErr } = await service.from('people').select('id, full_name, anonymized_at').eq('id', id).maybeSingle()
    if (readErr) throw new Error(`people read failed: ${readErr.message}`)
    if (!data) continue
    const p = data as { full_name: string; anonymized_at: string | null }
    const anonymizedByUs = state.anonymize !== null && p.anonymized_at !== null && (id === state.people.M || id === state.people.S)
    if (!p.full_name.startsWith(SYNTH) && !anonymizedByUs) abort('a state person is not [SYNTH] — refusing; inspect manually')
    const { error } = await service.from('people').delete().eq('id', id)
    if (error) throw new Error(`delete person failed: ${error.message}`)
    await audit(service, AUDIT_ACTIONS.DATA_WIPE, 'person', id)
    deleted += 1
  }
  console.log(`[cleanup] ${deleted} people deleted (data.wipe audited)`)

  // ── residue ──────────────────────────────────────────────────────────────
  const residue: Record<string, number> = {
    events: await countWhere(service, 'events', 'id', [state.eventId]),
    event_instances: await countWhere(service, 'event_instances', 'id', instanceIds),
    event_rsvp_links: await countWhere(service, 'event_rsvp_links', 'id', linkIds),
    event_rsvps_by_instance: await countWhere(service, 'event_rsvps', 'event_instance_id', instanceIds),
    event_rsvps_by_id: await countWhere(service, 'event_rsvps', 'id', [...seededIds, ...(state.anonymize ? [state.anonymize.rsvpIds.l1] : [])]),
    event_rsvps_by_phone: await countWhere(service, 'event_rsvps', 'phone_e164', Object.values(phones)),
    attendance: await countWhere(service, 'attendance', 'event_instance_id', instanceIds),
    attendance_by_person: await countWhere(service, 'attendance', 'person_id', personIds),
    people: await countWhere(service, 'people', 'id', personIds),
    people_by_phone: await countWhere(service, 'people', 'phone_e164', Object.values(phones)),
  }
  const total = Object.values(residue).reduce((a, n) => a + n, 0)
  console.log('')
  console.log(`[residue] ${Object.entries(residue).map(([k, v]) => `${k}=${v}`).join(' ')}`)
  if (total !== 0) abort(`residue remains (${total} row(s)) — state file kept for a re-run`)

  if (existsSync(V5_URL_PATH)) unlinkSync(V5_URL_PATH)
  unlinkSync(STATE_PATH)
  console.log(`${TAG} cleanup done — zero residue; state + V5 URL files removed (audit_log rows are append-only and kept)`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const [phase] = process.argv.slice(2)
  if (phase === 'setup') return setup()
  if (phase === 'drive') return drive()
  if (phase === 'anonymize') return anonymizePhase()
  if (phase === 'verify') return verify()
  if (phase === 'cleanup') return cleanup()
  abort('usage: s9-r6-staging-uat.js setup | drive | anonymize | verify | cleanup')
}

main().catch((err) => {
  console.error(`${TAG} FATAL:`, err instanceof Error ? err.message : err)
  process.exit(1)
})
