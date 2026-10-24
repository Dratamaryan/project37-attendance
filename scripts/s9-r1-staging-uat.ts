/**
 * S9-R1 — Staging UAT fixture for the public RSVP form /rsvp/[token]
 * (verification ladder rung 2). Synthetic data only: [SYNTH] names, fresh
 * +62999 phones. Unlike S9-R3, NOTHING is submitted by this script — the
 * owner types every RSVP into the real public page; this script only builds
 * the fixture, reads back what the page wrote, and cleans up.
 *
 * Three phases, run one at a time with the owner driving the staging UI in
 * between:
 *
 *   setup    1 [SYNTH] adhoc event + 1 SCHEDULED instance at now+3 days
 *            18:00 WIB (image_url = an existing staging event-images public
 *            URL if one is referenced by any instance, else NULL), and 1
 *            [SYNTH] member person. Prints the staging admin instance URL and
 *            the two phones, IN FULL and IN LOCAL FORMAT, for the owner to
 *            type: MEMBER (matches the person) and NEWCOMER (absent from
 *            people). They are synthetic +62999 numbers — printing them in
 *            full is intended here, the owner has to type them.
 *   verify   Reads back event_rsvps for the instance (service role), prints
 *            one line per row (last-4, person matched yes/no, name NULL/set,
 *            status, children, consent) and asserts exactly the 2 rows the
 *            UAT steps below produce.
 *   cleanup  Deletes RSVPs, links, the member person (+ any people row
 *            holding the newcomer phone, [SYNTH]-checked), the instance and
 *            the event; asserts zero residue. Never touches Storage — the
 *            borrowed poster object belongs to another instance.
 *
 * Run (tsc->node, compiled path — libphonenumber-js must not run under tsx):
 *   npx tsc -p scripts/tsconfig.s9-r1-uat.json
 *   node --env-file=.env.staging.local scripts/.build/scripts/s9-r1-staging-uat.js setup
 *   node --env-file=.env.staging.local scripts/.build/scripts/s9-r1-staging-uat.js verify
 *   node --env-file=.env.staging.local scripts/.build/scripts/s9-r1-staging-uat.js cleanup
 *
 * UAT STEPS (owner, between "setup" and "verify"; staging Vercel deployment,
 * RSVP_PUBLIC_ENABLED=true and RSVP_GATE_SECRET = staging vault value on
 * Preview):
 *   A. Admin (signed in as admin@example.com): open the printed admin
 *      instance URL, click "Get RSVP link", copy the link.
 *   B. Open the link in a PRIVATE window (no cookies, signed out). Expect:
 *      Indonesian UI; event "[SYNTH] S9-R1 UAT <run>", date, "18.00–20.00 WIB",
 *      "[SYNTH] Aula Uji"; poster shown iff setup printed one; logo not a
 *      link; page source has <meta name="robots" content="noindex, nofollow">
 *      and <meta name="referrer" content="no-referrer">.
 *   C. Error path (writes nothing): pick Hadir, phone "0812", Kirim ->
 *      inline phone error; the form keeps your answers.
 *   D. MEMBER, first answer: Hadir; phone = MEMBER (local format); Nama =
 *      "[SYNTH] Nama Diketik" (typed on purpose — it must NOT be stored for
 *      a member); Membawa anak? Ya, Jumlah anak 2; tick the consent box;
 *      Kirim. Expect the generic thank-you with recap "Hadir" + "2" — no
 *      name, no "welcome back".
 *   E. MEMBER, change: click "Ubah jawaban" (the form returns pre-filled);
 *      choose Mungkin; Membawa anak? Tidak; leave consent ticked; Kirim.
 *      Expect thank-you with "Mungkin" + no children.
 *   F. NEWCOMER: reload the page (fresh form). Tidak hadir (the children
 *      question disappears); phone = NEWCOMER (local format); Nama =
 *      "[SYNTH] UAT Pendatang R1"; consent NOT ticked; Kirim. Expect the SAME
 *      thank-you screen as D/E (only the recap differs: "Tidak hadir").
 *   G. Click "EN" in the header: same /rsvp/<token> page, now in English.
 *   H. Admin: deactivate the link on the instance page, reload the private
 *      window -> the generic "not available" page.
 *   Then run "verify". Expected rows (and nothing else):
 *     MEMBER    person matched, name NULL, maybe,      children 0, consent yes
 *     NEWCOMER  no person,      name set,  not_coming, children 0, consent no
 *
 * GUARDS (every phase, before any read or write):
 *   1. Shared preflight guard (branch <-> ref map).
 *   2. Staging pin: resolved ref must be exactly STAGING_REF — no local, no prod.
 *   3. Env URL ref must equal STAGING_REF (no split-brain).
 * setup additionally: no state file from an earlier run; both synthetic
 *   phones normalise to exactly themselves (and from their local format),
 *   start with +62999, and are absent from people and event_rsvps.
 * verify additionally: the state instance still belongs to the state event
 *   and is [SYNTH].
 * cleanup additionally: the event / people rows named in the state file (and
 *   any people row holding the newcomer phone) must still carry "[SYNTH]"
 *   names before anything is deleted.
 *
 * STATE: scripts/.build/s9-r1-uat-state.json (scripts/.build/ is gitignored)
 * holds the run id and row ids only — no phones, no names, no secrets. The
 * synthetic phones are re-derived from the run id in each phase.
 *
 * SECRETS: none read. The gate secret lives only in the Vercel deployment;
 * this script never calls submit_rsvp. Keys are never printed. Phones are
 * printed in full by "setup" only (synthetic, intended); "verify" prints
 * last-4 only.
 *
 * AUDIT (CLAUDE.md rule 6): event.create and people.create on setup (as the
 * S8-T5 seed does); data.wipe for each deleted person on cleanup (as the
 * S9-R0 smoke does). All via log_audit with actorUserId = null
 * (service_role/system path). audit_log rows are append-only and are
 * intentionally excluded from the residue check. The public page itself
 * never touches people / attendance / audit_log.
 */

import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { normalizePhone } from '../lib/utils/phone'
import { AUDIT_ACTIONS, logAudit, type AuditAction } from '../lib/audit'

const STAGING_REF = 'sijfyvaodqkawbeuyrpu'
const SOURCE = 's9-r1-staging-uat'
const TAG = '[s9-r1-uat]'
const STATE_PATH = path.resolve(process.cwd(), 'scripts/.build/s9-r1-uat-state.json')
const SYNTH = '[SYNTH]'
const MEMBER_FULL_NAME = '[SYNTH] UAT Anggota R1'
const NEWCOMER_NAME = '[SYNTH] UAT Pendatang R1'
const EVENT_IMAGES_BUCKET = 'event-images'

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
    console.error('==================== PREFLIGHT ABORT (s9-r1-staging-uat) ====================')
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

type PhoneKey = 'MEMBER' | 'NEWCOMER'
const PHONE_KEYS: PhoneKey[] = ['MEMBER', 'NEWCOMER']

/**
 * Fresh synthetic phones, same 12-digit +62999 shape as the S9-R0 smoke /
 * S9-R3 UAT (valid for libphonenumber ID; 14+ digits is not), derived from
 * the run id so the state file never has to store a phone.
 */
function phonesFor(runId: number): Record<PhoneKey, string> {
  const out = {} as Record<PhoneKey, string>
  PHONE_KEYS.forEach((k, i) => {
    out[k] = `+62999${((runId + i) % 10_000_000).toString().padStart(7, '0')}`
  })
  return out
}

/** What the owner types into the form: national format with a leading 0. */
const localFormat = (e164: string) => `0${e164.slice(3)}`
const last4 = (phone: string) => phone.slice(-4)

type ExpectedRow = {
  key: PhoneKey
  member: boolean
  name: string | null
  status: 'coming' | 'maybe' | 'not_coming'
  children: number
  consent: boolean
}
// Final state after UAT steps D, E (member updated in place) and F.
const EXPECTED: ExpectedRow[] = [
  { key: 'MEMBER', member: true, name: null, status: 'maybe', children: 0, consent: true },
  { key: 'NEWCOMER', member: false, name: NEWCOMER_NAME, status: 'not_coming', children: 0, consent: false },
]

type State = {
  runId: number
  createdAt: string
  adminId: string
  eventId: string
  instanceId: string
  memberId: string | null
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
    const fromLocal = normalizePhone(localFormat(p), 'ID')
    if (!n.ok || n.e164 !== p || !fromLocal.ok || fromLocal.e164 !== p || !p.startsWith('+62999')) {
      abort(`synthetic phone for ${k} failed normalisation (E.164 or local format) or is outside +62999`)
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

/**
 * A poster for the UAT instance without uploading anything: the public URL of
 * an event-images object some existing staging instance already references.
 * Only URLs under THIS project's event-images public prefix qualify. Null
 * when none is found — the page must then render cleanly without an image.
 */
async function findExistingPosterUrl(service: SupabaseClient): Promise<string | null> {
  const prefix = service.storage.from(EVENT_IMAGES_BUCKET).getPublicUrl('').data.publicUrl
  const { data, error } = await service
    .from('event_instances')
    .select('image_url')
    .like('image_url', `${prefix}%`)
    .limit(1)
  if (error) throw new Error(`poster lookup failed: ${error.message}`)
  const url = ((data ?? []) as Array<{ image_url: string | null }>)[0]?.image_url ?? null
  return url && url.startsWith(prefix) && url.length > prefix.length ? url : null
}

type Env = { url: string; serviceKey: string; appUrl: string }

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
  return { url, serviceKey, appUrl: appOrigin }
}

const serviceClient = (env: Env) =>
  createClient(env.url, env.serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })

/** The state event/instance must still be ours and synthetic. */
async function assertSyntheticFixture(service: SupabaseClient, state: State, requirePresent: boolean): Promise<void> {
  const { data: ev, error: evErr } = await service.from('events').select('id, name').eq('id', state.eventId).maybeSingle()
  if (evErr) throw new Error(`event lookup failed: ${evErr.message}`)
  if (ev && !(ev as { name: string }).name.startsWith(SYNTH)) abort('state event is not a [SYNTH] event — refusing')
  const { data: inst, error: instErr } = await service.from('event_instances').select('id, event_id').eq('id', state.instanceId).maybeSingle()
  if (instErr) throw new Error(`instance lookup failed: ${instErr.message}`)
  if (inst && (inst as { event_id: string }).event_id !== state.eventId) abort('state instance does not belong to the state event — refusing')
  if (requirePresent && (!ev || !inst)) abort('state event/instance no longer exists — run "cleanup"')
}

// ---------------------------------------------------------------------------
// Phase: setup
// ---------------------------------------------------------------------------

async function setup(): Promise<void> {
  const env = await pinStaging('staging-rsvp-public-uat-setup')
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
  const posterUrl = await findExistingPosterUrl(service)

  const eventName = `[SYNTH] S9-R1 UAT ${runId}`
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
    image_url: posterUrl,
  })

  // State is written as soon as the parent rows exist, so a failure below
  // still leaves something for "cleanup" to find.
  const state: State = { runId, createdAt: new Date().toISOString(), adminId, eventId, instanceId, memberId: null }
  writeState(state)

  const memberId = await insertOne(service, 'people', {
    full_name: MEMBER_FULL_NAME,
    nickname: 'AnggotaR1',
    phone_e164: phones.MEMBER,
  })
  state.memberId = memberId
  writeState(state)
  await audit(service, AUDIT_ACTIONS.PEOPLE_CREATE, 'person', memberId)

  console.log('')
  console.log(`${TAG} setup done:`)
  console.log(`  - event "${eventName}" + 1 SCHEDULED instance at ${wibDate} 18:00 WIB`)
  console.log(`  - poster: ${posterUrl ? 'borrowed existing event-images object (expect an image)' : 'none found -> image_url NULL (expect NO image)'}`)
  console.log(`  - member person "${MEMBER_FULL_NAME}" (…${last4(phones.MEMBER)})`)
  console.log(`  - state:  ${path.relative(process.cwd(), STATE_PATH)}`)
  console.log('')
  console.log('================ PHONES TO TYPE (synthetic +62999 — full number intended) ================')
  console.log(`  MEMBER    ${localFormat(phones.MEMBER)}    (= ${phones.MEMBER}, matches the [SYNTH] person)`)
  console.log(`  NEWCOMER  ${localFormat(phones.NEWCOMER)}    (= ${phones.NEWCOMER}, in no people row)`)
  console.log('==========================================================================================')
  console.log('')
  console.log('NEXT (owner): follow UAT steps A–H in the header of scripts/s9-r1-staging-uat.ts')
  console.log(`  A. as admin@example.com open ${env.appUrl}/admin/events/${eventId}/instances/${instanceId}`)
  console.log('     click "Get RSVP link" and open it in a PRIVATE window')
  console.log('  then: node --env-file=.env.staging.local scripts/.build/scripts/s9-r1-staging-uat.js verify')
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
  children_count: number
  followup_consent: boolean
}

async function verify(): Promise<void> {
  const env = await pinStaging('staging-rsvp-public-uat-verify')
  const state = readState()
  if (!state.memberId) abort('state has no member person — setup did not finish; run "cleanup" then "setup"')
  const phones = phonesFor(state.runId)
  assertSyntheticPhones(phones)

  const service = serviceClient(env)
  await assertSyntheticFixture(service, state, true)

  const { data: rows, error: rowsErr } = await service
    .from('event_rsvps')
    .select('phone_e164, name, person_id, status, children_count, followup_consent')
    .eq('event_instance_id', state.instanceId)
    .order('created_at')
  if (rowsErr) throw new Error(`read rsvps failed: ${rowsErr.message}`)
  const got = (rows ?? []) as RsvpRow[]

  const keyOf = (phone: string): string =>
    (PHONE_KEYS.find(k => phones[k] === phone) as string | undefined) ?? 'UNEXPECTED'

  console.log('')
  console.log(`${TAG} event_rsvps on the UAT instance (${got.length} row(s)):`)
  console.log('  KEY        PHONE   PERSON  NAME  STATUS      CHILDREN  CONSENT')
  for (const r of got) {
    console.log(
      `  ${keyOf(r.phone_e164).padEnd(10)} …${last4(r.phone_e164)}   ${(r.person_id ? 'yes' : 'no').padEnd(6)}  ` +
        `${(r.name === null ? 'NULL' : 'set').padEnd(4)}  ${r.status.padEnd(10)}  ${String(r.children_count).padEnd(8)}  ` +
        `${r.followup_consent ? 'yes' : 'no'}`,
    )
  }

  const checks: CheckRow[] = []
  checks.push({ id: 'v-count', label: 'exactly 2 RSVP rows on the instance', pass: got.length === 2, detail: `rows=${got.length}` })
  const unexpected = got.filter(r => keyOf(r.phone_e164) === 'UNEXPECTED').length
  checks.push({ id: 'v-phones', label: 'no row for any other phone', pass: unexpected === 0, detail: `unexpected=${unexpected}` })

  for (const e of EXPECTED) {
    const row = got.find(g => g.phone_e164 === phones[e.key])
    const expectPerson = e.member ? state.memberId : null
    const fields = row
      ? {
          person: row.person_id === expectPerson,
          name: row.name === e.name,
          status: row.status === e.status,
          children: row.children_count === e.children,
          consent: row.followup_consent === e.consent,
        }
      : null
    const failed = fields ? Object.entries(fields).filter(([, ok]) => !ok).map(([f]) => f) : []
    checks.push({
      id: `v-${e.key.toLowerCase()}`,
      label: `${e.key}: ${e.member ? 'person matched, name NULL' : 'no person, name set'}, ${e.status}, ${e.children} children, consent ${e.consent ? 'yes' : 'no'}`,
      pass: !!fields && failed.length === 0,
      detail: !row ? 'missing' : failed.length === 0 ? 'ok' : `MISMATCH: ${failed.join(', ')}`,
    })
  }

  const newcomerPeople = await countWhere(service, 'people', 'phone_e164', [phones.NEWCOMER])
  checks.push({ id: 'v-people', label: 'no people row created for the newcomer', pass: newcomerPeople === 0, detail: `people=${newcomerPeople}` })
  const memberPeople = await countWhere(service, 'people', 'phone_e164', [phones.MEMBER])
  checks.push({ id: 'v-member-people', label: 'member still exactly 1 people row', pass: memberPeople === 1, detail: `people=${memberPeople}` })
  const attendance = await countWhere(service, 'attendance', 'event_instance_id', [state.instanceId])
  checks.push({ id: 'v-att', label: 'RSVP wrote no attendance', pass: attendance === 0, detail: `attendance=${attendance}` })

  printChecks(checks)
  if (checks.some(c => !c.pass)) abort('verify failed — see the table above; the fixture is kept for inspection, run "cleanup" when done')
  console.log('')
  console.log('When done: node --env-file=.env.staging.local scripts/.build/scripts/s9-r1-staging-uat.js cleanup')
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
  const env = await pinStaging('staging-rsvp-public-uat-cleanup')
  const state = readState()
  const phones = phonesFor(state.runId)
  const service = serviceClient(env)

  // Safety: everything we are about to delete must still look synthetic.
  await assertSyntheticFixture(service, state, false)

  // People to remove: the state's member + any row that took the newcomer
  // phone (none expected — the public path never inserts people).
  const statePeople = state.memberId ? [state.memberId] : []
  const { data: phonePeople, error: ppErr } = await service.from('people').select('id').in('phone_e164', [phones.NEWCOMER])
  if (ppErr) throw new Error(`newcomer-phone lookup failed: ${ppErr.message}`)
  const extraPeople = ((phonePeople ?? []) as Array<{ id: string }>).map(r => r.id)
  if (extraPeople.length > 0) console.log(`[cleanup] NOTE: ${extraPeople.length} people row(s) hold the newcomer phone — removing`)
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

  // Children of the instance first (RSVPs reference links and people), then
  // people, then the instance and the event. attendance / child_attendance
  // are not expected (RSVP never checks anyone in) but are swept anyway.
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
  console.log(`${TAG} cleanup done — zero residue; state file removed (audit_log rows are append-only and kept; Storage untouched)`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const [phase] = process.argv.slice(2)
  if (phase === 'setup') return setup()
  if (phase === 'verify') return verify()
  if (phase === 'cleanup') return cleanup()
  abort('usage: s9-r1-staging-uat.js setup | verify | cleanup')
}

main().catch((err) => {
  console.error(`${TAG} FATAL:`, err instanceof Error ? err.message : err)
  process.exit(1)
})
