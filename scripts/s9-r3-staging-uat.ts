/**
 * S9-R3 — Staging UAT fixture for the admin RSVP panel, cross-tab, export and
 * per-person history (verification ladder rung 2). Synthetic data only:
 * [SYNTH] names, fresh +62999 phones, @example.com identities.
 *
 * Three phases, run one at a time with the owner driving the staging UI in
 * between:
 *
 *   setup            1 [SYNTH] adhoc event + 1 SCHEDULED instance at now+3 days
 *                    18:00 WIB, and 4 [SYNTH] people (M1, M2, M3, W1). Prints
 *                    the staging admin instance-page URL and stops. The owner
 *                    then clicks "Get RSVP link" in the UI.
 *   rsvps <token>    <token> = the link token the owner generated. Submits 5
 *                    RSVPs through the anon submit_rsvp RPC (3 members matched
 *                    by phone, 2 newcomers), checks in M1, M3 and W1, and
 *                    prints the HAND-COMPUTED panel/export expectation for the
 *                    owner to compare on screen.
 *   cleanup          Deletes everything the run created and asserts zero
 *                    residue.
 *
 * Run (tsc->node, compiled path — libphonenumber-js must not run under tsx):
 *   npx tsc -p scripts/tsconfig.s9-r3-uat.json
 *   node --env-file=.env.staging.local scripts/.build/scripts/s9-r3-staging-uat.js setup
 *   node --env-file=.env.staging.local scripts/.build/scripts/s9-r3-staging-uat.js rsvps <token>
 *   node --env-file=.env.staging.local scripts/.build/scripts/s9-r3-staging-uat.js cleanup
 *
 * GUARDS (every phase, before any read or write):
 *   1. Shared preflight guard (branch <-> ref map).
 *   2. Staging pin: resolved ref must be exactly STAGING_REF — no local, no prod.
 *   3. Env URL ref must equal STAGING_REF (no split-brain).
 * setup additionally: no state file from an earlier run; all 6 synthetic
 *   phones normalise to exactly themselves, start with +62999, and are absent
 *   from people.
 * rsvps additionally: the token must belong to an ACTIVE link on THIS run's
 *   instance (never submits to a real occurrence); the newcomer phones are
 *   still absent from people; the instance has no RSVPs or check-ins yet.
 * cleanup additionally: the event / instance / people rows named in the state
 *   file must still carry "[SYNTH]" names before anything is deleted.
 *
 * STATE: scripts/.build/s9-r3-uat-state.json (scripts/.build/ is gitignored)
 * holds the run id and row ids only — no phones, no names, no secrets. The
 * synthetic phones are re-derived from the run id in each phase.
 *
 * SECRETS: RSVP_GATE_SECRET is read from env and only ever sent as the p_gate
 * RPC argument — never printed, logged or interpolated into output. Keys are
 * never printed. Tokens are printed truncated to 6 chars. Phones are printed
 * as last-4 only.
 *
 * AUDIT (CLAUDE.md rule 6): event.create, people.create and attendance.create
 * on setup/rsvps (as the S8-T5 seed does); data.wipe for each deleted person
 * on cleanup (as the S9-R0 smoke does). All via log_audit with actorUserId =
 * null (service_role/system path). audit_log rows are append-only and are
 * intentionally excluded from the residue check. submit_rsvp itself never
 * touches people / attendance / audit_log.
 */

import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { normalizePhone } from '../lib/utils/phone'
import { AUDIT_ACTIONS, logAudit, type AuditAction } from '../lib/audit'

const STAGING_REF = 'sijfyvaodqkawbeuyrpu'
const SOURCE = 's9-r3-staging-uat'
const TAG = '[s9-r3-uat]'
const STATE_PATH = path.resolve(process.cwd(), 'scripts/.build/s9-r3-uat-state.json')
const SYNTH = '[SYNTH]'
const NEWCOMER_N1_NAME = '[SYNTH] UAT Pendatang'

// ---------------------------------------------------------------------------
// Preflight guard — same preamble as scripts/s8-t5-seed-staging-synthetic.ts
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
    console.error('==================== PREFLIGHT ABORT (s9-r3-staging-uat) ====================')
    console.error(`  branch:        ${branch || '(empty/detached)'}`)
    console.error(`  op:            ${op}`)
    console.error(`  resolved ref:  ${resolved.ref ?? '(none)'} (local=${resolved.local})`)
    console.error(`  reason:        ${result.reason}`)
    console.error('===============================================================================')
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

type PersonKey = 'M1' | 'M2' | 'M3' | 'W1'
type PhoneKey = PersonKey | 'N1' | 'N2'

const PEOPLE: Array<{ key: PersonKey; fullName: string; nickname: string }> = [
  { key: 'M1', fullName: '[SYNTH] UAT Anggota Satu', nickname: 'Satu' },
  { key: 'M2', fullName: '[SYNTH] UAT Anggota Dua', nickname: 'Dua' },
  { key: 'M3', fullName: '[SYNTH] UAT Anggota Tiga', nickname: 'Tiga' },
  { key: 'W1', fullName: '[SYNTH] UAT Walk-in', nickname: 'Walk' },
]
const PHONE_KEYS: PhoneKey[] = ['M1', 'M2', 'M3', 'W1', 'N1', 'N2']

/**
 * Fresh synthetic phones, same 12-digit +62999 shape as the S9-R0 smoke,
 * derived from the run id so the state file never has to store a phone.
 */
function phonesFor(runId: number): Record<PhoneKey, string> {
  const out = {} as Record<PhoneKey, string>
  PHONE_KEYS.forEach((k, i) => {
    out[k] = `+62999${((runId + i) % 10_000_000).toString().padStart(7, '0')}`
  })
  return out
}

const last4 = (phone: string) => phone.slice(-4)
const short = (token: string) => `${token.slice(0, 6)}…`

type RsvpPlan = {
  key: 'M1' | 'M2' | 'M3' | 'N1' | 'N2'
  name: string | null
  status: 'coming' | 'maybe' | 'not_coming'
  children: number
  consent: boolean
  member: boolean
}
const RSVPS: RsvpPlan[] = [
  { key: 'M1', name: null, status: 'coming', children: 2, consent: true, member: true },
  { key: 'M2', name: null, status: 'maybe', children: 1, consent: false, member: true },
  { key: 'M3', name: null, status: 'not_coming', children: 0, consent: false, member: true },
  { key: 'N1', name: NEWCOMER_N1_NAME, status: 'coming', children: 1, consent: true, member: false },
  { key: 'N2', name: null, status: 'coming', children: 0, consent: false, member: false },
]
const CHECK_INS: PersonKey[] = ['M1', 'M3', 'W1']

type State = {
  runId: number
  createdAt: string
  adminId: string
  eventId: string
  instanceId: string
  people: Record<PersonKey, string>
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
  const { data, error } = await supabase.from('app_users').select('id, active').eq('email', email).maybeSingle()
  if (error) throw new Error(`app_users lookup failed: ${error.message}`)
  if (!data || (data as { active: boolean }).active !== true) {
    abort(`${email} missing or inactive in app_users — run scripts/s8-t7-seed-staging-identities.ts first`)
  }
  return (data as { id: string }).id
}

async function countWhere(
  supabase: SupabaseClient,
  table: string,
  column: string,
  values: string[],
): Promise<number> {
  if (values.length === 0) return 0
  const { count, error } = await supabase.from(table).select('id', { count: 'exact', head: true }).in(column, values)
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

/** The 18:00 WIB instant on the WIB calendar date `days` from now. */
function wib1800InDays(days: number): { instant: Date; wibDate: string } {
  const wibNow = new Date(Date.now() + days * 86_400_000 + 7 * 3_600_000) // shift so UTC fields = WIB
  const y = wibNow.getUTCFullYear()
  const m = wibNow.getUTCMonth()
  const d = wibNow.getUTCDate()
  const instant = new Date(Date.UTC(y, m, d, 11, 0, 0)) // 18:00 WIB = 11:00Z
  const wibDate = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  return { instant, wibDate }
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
  const envRef = new URL(url).hostname.split('.')[0]
  if (envRef !== STAGING_REF) abort(`env URL ref ${envRef} is not ${STAGING_REF}`)

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
const anonClient = (env: Env) =>
  createClient(env.url, env.anonKey, { auth: { autoRefreshToken: false, persistSession: false } })

// ---------------------------------------------------------------------------
// Phase: setup
// ---------------------------------------------------------------------------

async function setup(): Promise<void> {
  const env = await pinStaging('staging-rsvp-uat-setup')
  if (existsSync(STATE_PATH)) abort(`state file ${STATE_PATH} exists — run "cleanup" for the previous run first`)

  const runId = Date.now()
  const phones = phonesFor(runId)
  assertSyntheticPhones(phones)

  const service = serviceClient(env)
  if ((await countWhere(service, 'people', 'phone_e164', Object.values(phones))) > 0) {
    abort('a synthetic phone is already present in people — refusing (re-run setup for a fresh run id)')
  }
  const adminId = await activeAppUserId(service, 'admin@example.com')

  const eventName = `[SYNTH] S9-R3 UAT ${runId}`
  const { instant, wibDate } = wib1800InDays(3)

  // ── writes ──────────────────────────────────────────────────────────────
  const eventId = await insertOne(service, 'events', {
    name: eventName,
    name_id: eventName,
    event_type: 'adhoc',
    start_date: wibDate,
    start_time: '18:00',
    duration_min: 120,
    location: '[SYNTH] Aula Uji',
    recurrence_rule: null,
    created_by: adminId,
  })
  await audit(service, AUDIT_ACTIONS.EVENT_CREATE, 'event', eventId)

  const instanceId = await insertOne(service, 'event_instances', {
    event_id: eventId,
    scheduled_at: instant.toISOString(),
    event_name_snapshot: eventName,
    event_name_snapshot_id: eventName,
    status: 'scheduled',
  })

  // State is written as soon as the parent rows exist, so a failure below
  // still leaves something for "cleanup" to find.
  const people = {} as Record<PersonKey, string>
  const state: State = { runId, createdAt: new Date().toISOString(), adminId, eventId, instanceId, people }
  writeState(state)

  for (const p of PEOPLE) {
    const id = await insertOne(service, 'people', { full_name: p.fullName, nickname: p.nickname, phone_e164: phones[p.key] })
    people[p.key] = id
    writeState(state)
    await audit(service, AUDIT_ACTIONS.PEOPLE_CREATE, 'person', id)
  }

  console.log('')
  console.log(`${TAG} setup done:`)
  console.log(`  - event "${eventName}" + 1 SCHEDULED instance at ${wibDate} 18:00 WIB`)
  console.log(`  - people: ${PEOPLE.map(p => `${p.key} (…${last4(phones[p.key])})`).join(', ')}`)
  console.log(`  - state:  ${path.relative(process.cwd(), STATE_PATH)}`)
  console.log('')
  console.log('NEXT (owner, in the staging UI as admin@example.com):')
  console.log(`  1. open ${env.appUrl}/admin/events/${eventId}/instances/${instanceId}`)
  console.log('  2. click "Get RSVP link", copy the link; the token is the last path segment')
  console.log('  3. run:  node --env-file=.env.staging.local scripts/.build/scripts/s9-r3-staging-uat.js rsvps <token>')
}

// ---------------------------------------------------------------------------
// Phase: rsvps <token>
// ---------------------------------------------------------------------------

type CheckRow = { id: string; label: string; pass: boolean; detail: string }

async function rsvps(token: string | undefined): Promise<void> {
  const env = await pinStaging('staging-rsvp-uat-rsvps')
  if (!token || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) abort('usage: rsvps <token>  (URL-safe link token from the UI)')
  const state = readState()
  const phones = phonesFor(state.runId)
  assertSyntheticPhones(phones)
  for (const k of ['M1', 'M2', 'M3', 'W1'] as const) {
    if (!state.people[k]) abort(`state has no person ${k} — setup did not finish; run "cleanup" then "setup"`)
  }

  const service = serviceClient(env)
  const anon = anonClient(env)

  // The token must belong to an ACTIVE link on THIS run's instance — never
  // submit synthetic RSVPs to a real occurrence.
  const { data: link, error: linkErr } = await service
    .from('event_rsvp_links')
    .select('id, event_instance_id, is_active')
    .eq('token', token)
    .maybeSingle()
  if (linkErr) throw new Error(`link lookup failed: ${linkErr.message}`)
  const l = link as { id: string; event_instance_id: string; is_active: boolean } | null
  if (!l || l.event_instance_id !== state.instanceId) abort(`token ${short(token)} is not a link on this run's instance — refusing`)
  if (!l.is_active) abort(`token ${short(token)} belongs to a deactivated link — generate a new one in the UI`)
  console.log(`[link] OK -- token=${short(token)} is the active link on the UAT instance`)

  // Newcomers must still be unknown phones, or they would match as members.
  if ((await countWhere(service, 'people', 'phone_e164', [phones.N1, phones.N2])) > 0) {
    abort('a newcomer phone is now present in people — refusing')
  }
  if ((await countWhere(service, 'event_rsvps', 'event_instance_id', [state.instanceId])) > 0) {
    abort('the UAT instance already has RSVPs — run "cleanup" and start again')
  }
  if ((await countWhere(service, 'attendance', 'event_instance_id', [state.instanceId])) > 0) {
    abort('the UAT instance already has check-ins — run "cleanup" and start again')
  }

  const checks: CheckRow[] = []

  // ── submit_rsvp via anon + gate ───────────────────────────────────────────
  for (const r of RSVPS) {
    const { data, error } = await anon.rpc('submit_rsvp', {
      p_gate: env.gate,
      p_token: token,
      p_phone_e164: phones[r.key],
      p_name: r.name,
      p_children_count: r.children,
      p_followup_consent: r.consent,
      p_status: r.status,
    })
    const body = error ? `error=${error.code}` : JSON.stringify(data)
    checks.push({ id: `s-${r.key}`, label: `submit ${r.key} ${r.status}/${r.children}/consent=${r.consent}`, pass: body === '{"ok":true}', detail: body })
  }
  if (checks.some(c => !c.pass)) {
    printChecks(checks)
    abort('a submit_rsvp response was not exactly {"ok":true} — not checking anyone in; run "cleanup"')
  }

  // ── check-ins (service role, attributed to admin, audited like the app) ──
  for (const k of CHECK_INS) {
    const id = await insertOne(service, 'attendance', {
      person_id: state.people[k],
      event_instance_id: state.instanceId,
      checked_in_by: state.adminId,
      source: 'volunteer_checkin',
    })
    await audit(service, AUDIT_ACTIONS.ATTENDANCE_CREATE, 'attendance', id)
  }

  // ── read-back (service role reads base tables; the cross-tab view is
  //    is_admin()-filtered and returns nothing to service role by design) ──
  const { data: rows, error: rowsErr } = await service
    .from('event_rsvps')
    .select('phone_e164, name, person_id, status, children_count, followup_consent')
    .eq('event_instance_id', state.instanceId)
  if (rowsErr) throw new Error(`read rsvps failed: ${rowsErr.message}`)
  const got = rows as Array<{ phone_e164: string; name: string | null; person_id: string | null; status: string; children_count: number; followup_consent: boolean }>
  checks.push({ id: 'r-count', label: 'exactly 5 RSVP rows on the instance', pass: got.length === 5, detail: `rows=${got.length}` })
  for (const r of RSVPS) {
    const row = got.find(g => g.phone_e164 === phones[r.key])
    const expectPerson = r.member ? state.people[r.key as PersonKey] : null
    const ok = !!row &&
      row.person_id === expectPerson &&
      row.status === r.status &&
      row.children_count === r.children &&
      row.followup_consent === r.consent &&
      (r.member ? row.name === null : row.name === r.name)
    checks.push({
      id: `r-${r.key}`,
      label: `${r.key} stored as ${r.member ? 'member (person_id, NULL name)' : 'newcomer (no person_id)'}`,
      pass: ok,
      detail: row ? `person=${row.person_id === expectPerson ? 'ok' : 'MISMATCH'} name=${row.name === null ? 'NULL' : 'set'}` : 'missing',
    })
  }
  const newcomerPeople = await countWhere(service, 'people', 'phone_e164', [phones.N1, phones.N2])
  checks.push({ id: 'r-people', label: 'no people row created for newcomers', pass: newcomerPeople === 0, detail: `people=${newcomerPeople}` })
  const attendance = await countWhere(service, 'attendance', 'event_instance_id', [state.instanceId])
  checks.push({ id: 'r-att', label: 'exactly 3 check-ins (M1, M3, W1)', pass: attendance === 3, detail: `attendance=${attendance}` })
  printChecks(checks)
  if (checks.some(c => !c.pass)) abort('read-back failed — do not UAT against this data; run "cleanup"')

  // ── hand-computed expectation for the owner ──────────────────────────────
  const p = (k: PhoneKey) => `…${last4(phones[k])}`
  console.log('')
  console.log('================ EXPECTED ON THE ADMIN INSTANCE PAGE (hand-computed) ================')
  console.log(`  ${env.appUrl}/admin/events/${state.eventId}/instances/${state.instanceId}`)
  console.log('')
  console.log('  Totals')
  console.log('    total responses ............ 5')
  console.log('    coming people .............. 3   (M1, N1, N2)')
  console.log('    coming children ............ 3   (M1 2 + N1 1 + N2 0)')
  console.log('    expected headcount (food) .. 6   (3 people + 3 children)')
  console.log('    maybe ...................... 1 person, headcount 2   (M2 + 1 child)')
  console.log('    not coming ................. 1   (M3)')
  console.log('')
  console.log('  RSVP vs check-in')
  console.log('    coming · came .............. 1   (M1)')
  console.log("    coming · didn't come ....... 2   (N1, N2)")
  console.log('    maybe · came ............... 0')
  console.log("    maybe · didn't come ........ 1   (M2)")
  console.log('    not coming · came anyway ... 1   (M3)')
  console.log("    not coming · didn't come ... 0")
  console.log('    walk-in (no RSVP) .......... 1   (W1)')
  console.log('    children: 3 expected · 0 checked in')
  console.log('')
  console.log('  Responses list (panel: every phone masked "•••• NNNN")')
  console.log(`    M1  Member    "[SYNTH] UAT Anggota Satu"  Coming      2 children  follow-up OK  •••• ${last4(phones.M1)}  ✓ came`)
  console.log(`    M2  Member    "[SYNTH] UAT Anggota Dua"   Maybe       1 child                   •••• ${last4(phones.M2)}`)
  console.log(`    M3  Member    "[SYNTH] UAT Anggota Tiga"  Not coming  0 children                •••• ${last4(phones.M3)}  ✓ came`)
  console.log(`    N1  Newcomer  "${NEWCOMER_N1_NAME}"     Coming      1 child     follow-up OK  •••• ${last4(phones.N1)}`)
  console.log(`    N2  Newcomer  "(no name)"                 Coming      0 children                •••• ${last4(phones.N2)}`)
  console.log('')
  console.log('  Export (Excel) — Phone column')
  console.log(`    FULL phone (follow-up consent): M1 ${p('M1')}, N1 ${p('N1')}   — the full +62999… number, ending as shown`)
  console.log(`    last-4 mask only:               M2 •••• ${last4(phones.M2)}, M3 •••• ${last4(phones.M3)}, N2 •••• ${last4(phones.N2)}`)
  console.log(`    never in the export:            W1 ${p('W1')} (walk-in, no RSVP)`)
  console.log('    audit export.create details: row_counts.responses = 5, full_phone_rows = 2')
  console.log('')
  console.log('  Person pages: M1, M2, M3 each show 1 RSVP-history row for this occurrence; W1 shows none.')
  console.log('=====================================================================================')
  console.log('')
  console.log('When done: node --env-file=.env.staging.local scripts/.build/scripts/s9-r3-staging-uat.js cleanup')
}

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
// Phase: cleanup
// ---------------------------------------------------------------------------

async function cleanup(): Promise<void> {
  const env = await pinStaging('staging-rsvp-uat-cleanup')
  const state = readState()
  const phones = phonesFor(state.runId)
  const service = serviceClient(env)

  // Safety: everything we are about to delete must still look synthetic.
  const { data: ev, error: evErr } = await service.from('events').select('id, name').eq('id', state.eventId).maybeSingle()
  if (evErr) throw new Error(`event lookup failed: ${evErr.message}`)
  if (ev && !(ev as { name: string }).name.startsWith(SYNTH)) abort('state event is not a [SYNTH] event — refusing')
  const { data: inst, error: instErr } = await service.from('event_instances').select('id, event_id').eq('id', state.instanceId).maybeSingle()
  if (instErr) throw new Error(`instance lookup failed: ${instErr.message}`)
  if (inst && (inst as { event_id: string }).event_id !== state.eventId) abort('state instance does not belong to the state event — refusing')

  // People to remove: the state's four + any row that took a newcomer phone
  // (none expected — submit_rsvp never inserts people).
  const statePeople = Object.values(state.people ?? {}).filter(Boolean)
  const { data: phonePeople, error: ppErr } = await service.from('people').select('id').in('phone_e164', [phones.N1, phones.N2])
  if (ppErr) throw new Error(`newcomer-phone lookup failed: ${ppErr.message}`)
  const extraPeople = ((phonePeople ?? []) as Array<{ id: string }>).map(r => r.id)
  if (extraPeople.length > 0) console.log(`[cleanup] NOTE: ${extraPeople.length} people row(s) hold a newcomer phone — removing`)
  const peopleIds = [...new Set([...statePeople, ...extraPeople])]
  if (peopleIds.length > 0) {
    const { data: names, error: nErr } = await service.from('people').select('id, full_name').in('id', peopleIds)
    if (nErr) throw new Error(`people lookup failed: ${nErr.message}`)
    // Never delete a non-synthetic person, even one holding a synthetic phone.
    for (const n of (names ?? []) as Array<{ full_name: string }>) {
      if (!n.full_name.startsWith(SYNTH)) abort('a person to delete is not [SYNTH] — refusing; inspect manually')
    }
  }

  const del = async (table: string, column: string, values: string[]) => {
    if (values.length === 0) return
    const { error } = await service.from(table).delete().in(column, values)
    if (error) throw new Error(`delete ${table} failed: ${error.message}`)
  }

  // Children of the instance first (RSVPs reference links; attendance
  // references people), then people, then the instance and the event.
  await del('event_rsvps', 'event_instance_id', [state.instanceId])
  await del('event_rsvp_links', 'event_instance_id', [state.instanceId])
  await del('child_attendance', 'event_instance_id', [state.instanceId])
  await del('attendance', 'event_instance_id', [state.instanceId])
  for (const id of peopleIds) {
    const { error } = await service.from('people').delete().eq('id', id)
    if (error) throw new Error(`delete person failed: ${error.message}`)
    await audit(service, AUDIT_ACTIONS.DATA_WIPE, 'person', id)
  }
  await del('event_instances', 'id', [state.instanceId])
  await del('events', 'id', [state.eventId])

  // ── residue ──────────────────────────────────────────────────────────────
  const residue: Record<string, number> = {
    events: await countWhere(service, 'events', 'id', [state.eventId]),
    event_instances: await countWhere(service, 'event_instances', 'id', [state.instanceId]),
    event_rsvp_links: await countWhere(service, 'event_rsvp_links', 'event_instance_id', [state.instanceId]),
    event_rsvps: await countWhere(service, 'event_rsvps', 'event_instance_id', [state.instanceId]),
    event_rsvps_by_phone: await countWhere(service, 'event_rsvps', 'phone_e164', Object.values(phones)),
    attendance: await countWhere(service, 'attendance', 'event_instance_id', [state.instanceId]),
    child_attendance: await countWhere(service, 'child_attendance', 'event_instance_id', [state.instanceId]),
    people_by_id: await countWhere(service, 'people', 'id', peopleIds),
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
  const [phase, arg] = process.argv.slice(2)
  if (phase === 'setup') return setup()
  if (phase === 'rsvps') return rsvps(arg)
  if (phase === 'cleanup') return cleanup()
  abort('usage: s9-r3-staging-uat.js setup | rsvps <token> | cleanup')
}

main().catch((err) => {
  console.error(`${TAG} FATAL:`, err instanceof Error ? err.message : err)
  process.exit(1)
})
