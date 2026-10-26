/**
 * S9-R2 — Staging smoke for the public RSVP member match / newcomer behaviour
 * (verification ladder rung 2). Verify-only: R2 ships no app code. Synthetic
 * data only: [SYNTH] names, fresh +62999 phones, staging accounts
 * (admin@example.com). Like S9-R1/R4, NOTHING is submitted by this script —
 * the owner types every RSVP into the real public page (Turnstile on); this
 * script builds the fixture, reads back what the page wrote, and cleans up.
 *
 * Three phases, run one at a time with the owner driving the staging UI in
 * between:
 *
 *   setup    1 [SYNTH] adhoc event + 1 SCHEDULED instance at now+3 days
 *            18:00 WIB + 1 active RSVP link; 1 [SYNTH] roster member
 *            (people insert + people.create audit) holding the MEMBER phone.
 *            Snapshots the member's full people row into the state file.
 *            Prints the MEMBER phone in two formats and the NEWCOMER phone
 *            (synthetic +62999 — printing them in full is intended, the
 *            owner has to type them).
 *   verify   Reads back event_rsvps for the instance (service role) and
 *            asserts the rows the owner steps produce, that the member's
 *            people row still deep-equals the snapshot, that no people row
 *            exists for the NEWCOMER phone, and that no attendance was written.
 *   cleanup  Deletes the event (cascades instance, link, RSVPs), asserts zero
 *            RSVP rows, then deletes the [SYNTH] member (data.wipe audit) and
 *            asserts zero residue.
 *
 * Run (tsc->node, compiled path — libphonenumber-js must not run under tsx):
 *   npx tsc -p scripts/tsconfig.s9-r2-smoke.json
 *   node --env-file=.env.staging.local scripts/.build/scripts/s9-r2-staging-smoke.js setup
 *   node --env-file=.env.staging.local scripts/.build/scripts/s9-r2-staging-smoke.js verify
 *   node --env-file=.env.staging.local scripts/.build/scripts/s9-r2-staging-smoke.js cleanup
 *
 * OWNER CHECKLIST (between "setup" and "verify"; staging branch Vercel
 * deployment against staging Supabase; RSVP_PUBLIC_ENABLED=true,
 * RSVP_GATE_SECRET = staging vault value and RSVP_TURNSTILE_ENABLED=true on
 * Preview). Every browser step is in a PRIVATE window unless stated otherwise.
 *   A. As admin@example.com open the admin instance URL that setup prints and
 *      click "Get RSVP link" — it returns the link setup created (no new one).
 *      Open it in a PRIVATE window; the Turnstile challenge renders.
 *   B. MEMBER: Hadir; phone = MEMBER in local format (0999…); Nama =
 *      "[SYNTH] Typed Name"; Kirim -> the normal thank-you.
 *   C. NEWCOMER: reload; Mungkin; phone = NEWCOMER (local format); Nama =
 *      "[SYNTH] UAT R2 New"; Kirim -> the normal thank-you (identical to B).
 *   D. MEMBER resubmit: reload; Tidak hadir; phone = MEMBER in the OTHER
 *      format (+62 999 …); Nama left blank; Kirim -> thank-you.
 *   E. Back in the admin window, reload the instance page. The RSVP panel
 *      lists 2 responses: the MEMBER row shows the ROSTER name
 *      "[SYNTH] UAT R2 Member" (never "[SYNTH] Typed Name") with status
 *      Tidak hadir; the NEWCOMER row shows "[SYNTH] UAT R2 New", Mungkin.
 *
 *   Then run "verify". Expected rows (and nothing else):
 *     MEMBER    person = member, name NULL, not_coming, created_at < updated_at
 *     NEWCOMER  no person, name "[SYNTH] UAT R2 New", maybe
 *
 * GUARDS (every phase, before any read or write):
 *   1. Shared preflight guard (branch <-> ref map).
 *   2. Staging pin: resolved ref must be exactly STAGING_REF — no local, no prod.
 *   3. Env URL ref must equal STAGING_REF (no split-brain), and
 *      NEXT_PUBLIC_APP_URL must not be localhost.
 * setup additionally: no state file from an earlier run; both synthetic
 *   phones normalise to exactly themselves (from E.164, local and spaced
 *   format), start with +62999, and are absent from people and event_rsvps.
 * verify / cleanup additionally: the state event is [SYNTH], the state
 *   instance still belongs to it, and the state person is [SYNTH].
 *
 * STATE: scripts/.build/s9-r2-smoke-state.json (scripts/.build/ is gitignored,
 * mode 0600) holds the run id, row ids and the member's people-row snapshot.
 * Unlike R4 the snapshot carries the SYNTHETIC member's phone and [SYNTH]
 * name — the deep-equal needs the full row. No secrets, no tokens.
 *
 * SECRETS: none read. The gate secret and Turnstile keys live only in the
 * Vercel deployment; this script never calls submit_rsvp or siteverify.
 *
 * AUDIT (CLAUDE.md rule 6): the member insert logs people.create and the
 * cleanup hard-delete logs data.wipe (log_audit, actorUserId = null —
 * service_role/system path), as in the S9-R0 smoke. event.create and
 * rsvp_link.create are logged on setup. audit_log rows are append-only and
 * excluded from the residue check. The public page never touches people /
 * attendance / audit_log.
 */

import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { normalizePhone } from '../lib/utils/phone'
import { AUDIT_ACTIONS, logAudit, type AuditAction } from '../lib/audit'

const STAGING_REF = 'sijfyvaodqkawbeuyrpu'
const SOURCE = 's9-r2-staging-smoke'
const TAG = '[s9-r2-smoke]'
const STATE_PATH = path.resolve(process.cwd(), 'scripts/.build/s9-r2-smoke-state.json')
const SYNTH = '[SYNTH]'
const MEMBER_NAME = '[SYNTH] UAT R2 Member'
const TYPED_NAME = '[SYNTH] Typed Name'
const NEWCOMER_NAME = '[SYNTH] UAT R2 New'

// ---------------------------------------------------------------------------
// Preflight guard — same preamble as scripts/s9-r4-staging-uat.ts
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
    console.error('=================== PREFLIGHT ABORT (s9-r2-staging-smoke) ===================')
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

type PhoneKey = 'MEMBER' | 'NEWCOMER'
const PHONE_KEYS: PhoneKey[] = ['MEMBER', 'NEWCOMER']

/**
 * Fresh synthetic phones, same 12-digit +62999 shape as the S9-R1/R4 UATs,
 * derived from the run id so a re-run never reuses a phone.
 */
function phonesFor(runId: number): Record<PhoneKey, string> {
  const out = {} as Record<PhoneKey, string>
  PHONE_KEYS.forEach((k, i) => {
    out[k] = `+62999${((runId + i) % 10_000_000).toString().padStart(7, '0')}`
  })
  return out
}

/** National format with a leading 0 (what most visitors type). */
const localFormat = (e164: string) => `0${e164.slice(3)}`
/** International format with spaces: "+62 999 1234 567". */
const spacedFormat = (e164: string) => `+62 ${e164.slice(3, 6)} ${e164.slice(6, 10)} ${e164.slice(10)}`
const last4 = (phone: string) => phone.slice(-4)

type PersonSnapshot = Record<string, unknown>

type State = {
  runId: number
  createdAt: string
  eventId: string
  instanceId: string
  linkId: string
  memberId: string
  memberSnapshot: PersonSnapshot | null
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
  const ids = values.filter(v => v !== '')
  if (ids.length === 0) return 0
  const { count, error } = await supabase.from(table).select('id', { count: 'exact', head: true }).in(column, ids)
  if (error || count === null) throw new Error(`count ${table} failed: ${error?.message ?? 'null count'}`)
  return count
}

async function personRow(supabase: SupabaseClient, personId: string): Promise<PersonSnapshot | null> {
  const { data, error } = await supabase.from('people').select('*').eq('id', personId).maybeSingle()
  if (error) throw new Error(`people read failed: ${error.message}`)
  return (data as PersonSnapshot | null) ?? null
}

function assertSyntheticPhones(phones: Record<PhoneKey, string>): void {
  for (const k of PHONE_KEYS) {
    const p = phones[k]
    for (const typed of [p, localFormat(p), spacedFormat(p)]) {
      const n = normalizePhone(typed, 'ID')
      if (!n.ok || n.e164 !== p || !p.startsWith('+62999')) {
        abort(`synthetic phone for ${k} failed normalisation (E.164, local or spaced format) or is outside +62999`)
      }
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

type Env = { url: string; serviceKey: string; appUrl: string }

/**
 * Staging pin, on top of the shared preflight guard: the resolved ref, the
 * env Supabase URL and the app URL must all point at staging — this script
 * refuses any other host.
 */
async function pinStaging(op: string): Promise<Env> {
  const resolved = await runPreflightGuard(op)
  if (resolved.local || resolved.ref !== STAGING_REF) {
    abort(`resolved ref ${resolved.ref ?? '(none)'} (local=${resolved.local}) is not staging (${STAGING_REF}) — refusing`)
  }
  console.log(`[staging-pin] OK -- ref=${resolved.ref}`)

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!url || !serviceKey || !appUrl) {
    abort('missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_APP_URL — pass --env-file explicitly')
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
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') throw new Error('local')
    appOrigin = parsed.origin
  } catch {
    abort('NEXT_PUBLIC_APP_URL is not a non-local http(s) URL')
  }
  return { url, serviceKey, appUrl: appOrigin }
}

const serviceClient = (env: Env) =>
  createClient(env.url, env.serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })

/** The state event/instance/person must still be ours and synthetic. */
async function assertSyntheticFixture(service: SupabaseClient, state: State, requirePresent: boolean): Promise<void> {
  const { data: ev, error: evErr } = await service.from('events').select('id, name').eq('id', state.eventId).maybeSingle()
  if (evErr) throw new Error(`event lookup failed: ${evErr.message}`)
  if (ev && !(ev as { name: string }).name.startsWith(SYNTH)) abort('state event is not a [SYNTH] event — refusing')
  if (state.instanceId) {
    const { data: inst, error: instErr } = await service.from('event_instances').select('id, event_id').eq('id', state.instanceId).maybeSingle()
    if (instErr) throw new Error(`instance lookup failed: ${instErr.message}`)
    if (inst && (inst as { event_id: string }).event_id !== state.eventId) abort('state instance does not belong to the state event — refusing')
    if (requirePresent && !inst) abort('state instance no longer exists — run "cleanup"')
  }
  if (state.memberId) {
    const person = await personRow(service, state.memberId)
    if (person && !String(person.full_name).startsWith(SYNTH)) abort('state person is not [SYNTH] — refusing; inspect manually')
    if (requirePresent && !person) abort('state person no longer exists — run "cleanup"')
  }
  if (requirePresent && !ev) abort('state event no longer exists — run "cleanup"')
}

// ---------------------------------------------------------------------------
// Phase: setup
// ---------------------------------------------------------------------------

async function setup(): Promise<void> {
  const env = await pinStaging('staging-rsvp-r2-smoke-setup')
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
  const adminId = await activeAppUserId(service, 'admin@example.com')

  const eventName = `[SYNTH] S9-R2 Smoke ${runId}`
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

  // Write state after every insert so a failure still leaves something for
  // "cleanup" to find.
  const state: State = {
    runId,
    createdAt: new Date().toISOString(),
    eventId,
    instanceId: '',
    linkId: '',
    memberId: '',
    memberSnapshot: null,
  }
  writeState(state)

  state.instanceId = await insertOne(service, 'event_instances', {
    event_id: eventId,
    scheduled_at: instant.toISOString(),
    event_name_snapshot: eventName,
    event_name_snapshot_id: eventName,
    status: 'scheduled',
    image_url: null,
  })
  writeState(state)

  state.linkId = await insertOne(service, 'event_rsvp_links', {
    event_instance_id: state.instanceId,
    created_by: adminId,
  })
  await audit(service, AUDIT_ACTIONS.RSVP_LINK_CREATE, 'event_rsvp_link', state.linkId)
  writeState(state)

  state.memberId = await insertOne(service, 'people', {
    full_name: MEMBER_NAME,
    nickname: 'Anggota',
    phone_e164: phones.MEMBER,
  })
  await audit(service, AUDIT_ACTIONS.PEOPLE_CREATE, 'person', state.memberId)
  writeState(state)

  state.memberSnapshot = await personRow(service, state.memberId)
  if (!state.memberSnapshot) throw new Error('member row vanished right after insert')
  writeState(state)

  console.log('')
  console.log(`${TAG} setup done:`)
  console.log(`  - event "${eventName}" + 1 SCHEDULED instance at ${wibDate} 18:00 WIB + 1 active RSVP link`)
  console.log(`  - roster member "${MEMBER_NAME}" (people row snapshotted)`)
  console.log(`  - state:  ${path.relative(process.cwd(), STATE_PATH)}`)
  console.log('')
  // Every phone printed below goes through the compiled normalizePhone
  // (region ID) once more, immediately before printing — abort on any miss.
  assertSyntheticPhones(phones)
  console.log('================ PHONES TO TYPE (synthetic +62999 — full number intended) ================')
  console.log(`  MEMBER    ${localFormat(phones.MEMBER)}       (step B, local format)`)
  console.log(`  MEMBER    ${spacedFormat(phones.MEMBER)}    (step D, the OTHER format; = ${phones.MEMBER})`)
  console.log(`  NEWCOMER  ${localFormat(phones.NEWCOMER)}       (step C; = ${phones.NEWCOMER})`)
  console.log('==========================================================================================')
  console.log('')
  console.log('NEXT (owner): follow checklist steps A–E in the header of scripts/s9-r2-staging-smoke.ts')
  console.log(`  A. as admin@example.com open ${env.appUrl}/admin/events/${eventId}/instances/${state.instanceId}`)
  console.log('     click "Get RSVP link" and open it in a PRIVATE window')
  console.log('  then: node --env-file=.env.staging.local scripts/.build/scripts/s9-r2-staging-smoke.js verify')
}

// ---------------------------------------------------------------------------
// Phase: verify
// ---------------------------------------------------------------------------

type CheckRow = { id: string; label: string; pass: boolean; detail: string }

type RsvpRow = {
  phone_e164: string
  name: string | null
  person_id: string | null
  status: string
  link_id: string
  created_at: string
  updated_at: string
}

async function verify(): Promise<void> {
  const env = await pinStaging('staging-rsvp-r2-smoke-verify')
  const state = readState()
  if (!state.instanceId || !state.linkId || !state.memberId || !state.memberSnapshot) {
    abort('state is incomplete — setup did not finish; run "cleanup" then "setup"')
  }
  const phones = phonesFor(state.runId)
  assertSyntheticPhones(phones)

  const service = serviceClient(env)
  await assertSyntheticFixture(service, state, true)

  const { data: rows, error: rowsErr } = await service
    .from('event_rsvps')
    .select('phone_e164, name, person_id, status, link_id, created_at, updated_at')
    .eq('event_instance_id', state.instanceId)
    .order('created_at')
  if (rowsErr) throw new Error(`read rsvps failed: ${rowsErr.message}`)
  const got = (rows ?? []) as RsvpRow[]

  const keyOf = (phone: string): string =>
    (PHONE_KEYS.find(k => phones[k] === phone) as string | undefined) ?? 'UNEXPECTED'

  console.log('')
  console.log(`${TAG} event_rsvps on the smoke instance (${got.length} row(s)):`)
  console.log('  KEY        PHONE   PERSON  NAME  STATUS      UPDATED>CREATED')
  for (const r of got) {
    const person = r.person_id === null ? 'no' : r.person_id === state.memberId ? 'member' : 'OTHER'
    console.log(
      `  ${keyOf(r.phone_e164).padEnd(10)} …${last4(r.phone_e164)}   ${person.padEnd(6)}  ` +
        `${(r.name === null ? 'NULL' : 'set').padEnd(4)}  ${r.status.padEnd(10)}  ` +
        `${Date.parse(r.updated_at) > Date.parse(r.created_at) ? 'yes' : 'no'}`,
    )
  }

  const checks: CheckRow[] = []
  checks.push({ id: 'v-count', label: 'exactly 2 RSVP rows on the instance', pass: got.length === 2, detail: `rows=${got.length}` })
  const unexpected = got.filter(r => keyOf(r.phone_e164) === 'UNEXPECTED').length
  checks.push({ id: 'v-phones', label: 'no row for any other phone', pass: unexpected === 0, detail: `unexpected=${unexpected}` })

  const member = got.find(r => r.phone_e164 === phones.MEMBER)
  const memberFields = member
    ? {
        person: member.person_id === state.memberId,
        name_null: member.name === null,
        not_coming: member.status === 'not_coming',
        resubmitted: Date.parse(member.created_at) < Date.parse(member.updated_at),
        link: member.link_id === state.linkId,
      }
    : null
  const memberFailed = memberFields ? Object.entries(memberFields).filter(([, ok]) => !ok).map(([f]) => f) : []
  checks.push({
    id: 'v-member',
    label: 'MEMBER: person = member, name NULL, not_coming, created_at < updated_at',
    pass: !!memberFields && memberFailed.length === 0,
    detail: !member ? 'missing' : memberFailed.length === 0 ? 'ok' : `MISMATCH: ${memberFailed.join(', ')}`,
  })

  const newcomer = got.find(r => r.phone_e164 === phones.NEWCOMER)
  const newcomerFields = newcomer
    ? { person_null: newcomer.person_id === null, name: newcomer.name === NEWCOMER_NAME, maybe: newcomer.status === 'maybe' }
    : null
  const newcomerFailed = newcomerFields ? Object.entries(newcomerFields).filter(([, ok]) => !ok).map(([f]) => f) : []
  checks.push({
    id: 'v-newcomer',
    label: `NEWCOMER: no person, name "${NEWCOMER_NAME}", maybe`,
    pass: !!newcomerFields && newcomerFailed.length === 0,
    detail: !newcomer ? 'missing' : newcomerFailed.length === 0 ? 'ok' : `MISMATCH: ${newcomerFailed.join(', ')}`,
  })

  const typedLeak = got.filter(r => r.name === TYPED_NAME).length
  checks.push({ id: 'v-typed', label: 'the member\'s typed name is stored nowhere', pass: typedLeak === 0, detail: `rows=${typedLeak}` })

  const newcomerPeople = await countWhere(service, 'people', 'phone_e164', [phones.NEWCOMER])
  checks.push({ id: 'v-people-new', label: 'no people row for the NEWCOMER phone', pass: newcomerPeople === 0, detail: `people=${newcomerPeople}` })

  const now = await personRow(service, state.memberId)
  const unchanged = now !== null && isDeepStrictEqual(now, state.memberSnapshot)
  const changedCols = now
    ? Object.keys({ ...now, ...state.memberSnapshot }).filter(k => !isDeepStrictEqual(now[k], state.memberSnapshot?.[k]))
    : []
  checks.push({
    id: 'v-people-member',
    label: 'member people row deep-equals the setup snapshot',
    pass: unchanged,
    detail: now === null ? 'missing' : unchanged ? 'ok' : `CHANGED: ${changedCols.join(', ')}`,
  })

  const attendance = await countWhere(service, 'attendance', 'event_instance_id', [state.instanceId])
  checks.push({ id: 'v-att', label: 'RSVP wrote no attendance', pass: attendance === 0, detail: `attendance=${attendance}` })

  printChecks(checks)
  if (checks.some(c => !c.pass)) abort('verify failed — see the table above; the fixture is kept for inspection, run "cleanup" when done')
  console.log('')
  console.log('When done: node --env-file=.env.staging.local scripts/.build/scripts/s9-r2-staging-smoke.js cleanup')
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
  const env = await pinStaging('staging-rsvp-r2-smoke-cleanup')
  const state = readState()
  const phones = phonesFor(state.runId)
  const service = serviceClient(env)

  // Safety: everything we are about to delete must still look synthetic.
  await assertSyntheticFixture(service, state, false)

  const instanceIds = state.instanceId ? [state.instanceId] : []
  const del = async (table: string, column: string, values: string[]) => {
    const ids = values.filter(v => v !== '')
    if (ids.length === 0) return
    const { error } = await service.from(table).delete().in(column, ids)
    if (error) throw new Error(`delete ${table} failed: ${error.message}`)
  }

  // attendance / child_attendance are not expected (RSVP never checks anyone
  // in) but are swept so the event delete and the person delete can't trip
  // their FKs. Then the event: CASCADE to the instance, its link and RSVPs.
  await del('child_attendance', 'event_instance_id', instanceIds)
  await del('attendance', 'event_instance_id', instanceIds)
  await del('events', 'id', [state.eventId])

  // event_rsvps.person_id is NO ACTION: the person goes only once no RSVP
  // row can reference it.
  const rsvpLeft =
    (await countWhere(service, 'event_rsvps', 'event_instance_id', instanceIds)) +
    (await countWhere(service, 'event_rsvps', 'phone_e164', Object.values(phones))) +
    (await countWhere(service, 'event_rsvps', 'person_id', [state.memberId]))
  if (rsvpLeft !== 0) abort(`${rsvpLeft} RSVP row(s) remain after the event delete — person NOT deleted; state file kept`)
  console.log('[cleanup] event deleted (cascade); zero RSVP rows remain')

  if (state.memberId) {
    const person = await personRow(service, state.memberId)
    if (person) {
      if (!String(person.full_name).startsWith(SYNTH)) abort('state person is not [SYNTH] — refusing; inspect manually')
      const { error } = await service.from('people').delete().eq('id', state.memberId)
      if (error) throw new Error(`delete person failed: ${error.message}`)
      await audit(service, AUDIT_ACTIONS.DATA_WIPE, 'person', state.memberId)
      console.log('[cleanup] [SYNTH] member deleted (data.wipe audited)')
    }
  }

  // ── residue ──────────────────────────────────────────────────────────────
  const residue: Record<string, number> = {
    events: await countWhere(service, 'events', 'id', [state.eventId]),
    event_instances: await countWhere(service, 'event_instances', 'id', instanceIds),
    event_rsvp_links: await countWhere(service, 'event_rsvp_links', 'event_instance_id', instanceIds),
    event_rsvps: await countWhere(service, 'event_rsvps', 'event_instance_id', instanceIds),
    event_rsvps_by_phone: await countWhere(service, 'event_rsvps', 'phone_e164', Object.values(phones)),
    attendance: await countWhere(service, 'attendance', 'event_instance_id', instanceIds),
    child_attendance: await countWhere(service, 'child_attendance', 'event_instance_id', instanceIds),
    people: await countWhere(service, 'people', 'id', [state.memberId]),
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
  abort('usage: s9-r2-staging-smoke.js setup | verify | cleanup')
}

main().catch((err) => {
  console.error(`${TAG} FATAL:`, err instanceof Error ? err.message : err)
  process.exit(1)
})
