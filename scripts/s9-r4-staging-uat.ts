/**
 * S9-R4 — Staging UAT fixture for the public RSVP abuse controls (honeypot,
 * Turnstile toggle) and the admin-default-en locale override on
 * /rsvp/[token] (verification ladder rung 2). Synthetic data only: [SYNTH]
 * names, fresh +62999 phones, staging accounts (admin@example.com). Like
 * S9-R1, NOTHING is submitted by this script — the owner types every RSVP
 * into the real public page; this script builds the fixture, reads back what
 * the page wrote, and cleans up.
 *
 * Three phases, run one at a time with the owner driving the staging UI in
 * between:
 *
 *   setup    1 [SYNTH] adhoc event + 1 SCHEDULED instance at now+3 days
 *            18:00 WIB (no poster). No people rows: every phone is a
 *            newcomer. Prints the admin instance URL and the four phones to
 *            type, IN FULL and IN LOCAL FORMAT (synthetic +62999 — printing
 *            them in full is intended, the owner has to type them).
 *   verify   Reads back event_rsvps for the instance (service role), prints
 *            one line per row (last-4, name NULL/set, status) and asserts
 *            exactly the 2 rows the UAT steps produce — and NONE for the
 *            HONEYPOT and TAMPER phones. Also asserts app_settings.default_language is
 *            back to 'id' (step I).
 *   cleanup  Deletes RSVPs, links, the instance and the event; asserts zero
 *            residue. Never touches Storage or app_settings.
 *
 * Run (tsc->node, compiled path — libphonenumber-js must not run under tsx):
 *   npx tsc -p scripts/tsconfig.s9-r4-uat.json
 *   node --env-file=.env.staging.local scripts/.build/scripts/s9-r4-staging-uat.js setup
 *   node --env-file=.env.staging.local scripts/.build/scripts/s9-r4-staging-uat.js verify
 *   node --env-file=.env.staging.local scripts/.build/scripts/s9-r4-staging-uat.js cleanup
 *
 * OWNER UAT CHECKLIST (between "setup" and "verify"; staging branch Vercel
 * deployment against staging Supabase; RSVP_PUBLIC_ENABLED=true and
 * RSVP_GATE_SECRET = staging vault value on Preview). Every browser step is
 * in a PRIVATE window (signed out, no 'locale' cookie) unless it says
 * otherwise. Vercel env changes need a redeploy of the staging branch.
 *
 *   Before the push: the staging Turnstile keys (RSVP_TURNSTILE_SITE_KEY /
 *   RSVP_TURNSTILE_SECRET_KEY, an "Invisible" widget whose hostnames include
 *   the staging deployment domain) are already set on Preview, and
 *   RSVP_TURNSTILE_ENABLED is UNSET on Preview.
 *
 *   Part 1 — Turnstile OFF (Preview: RSVP_TURNSTILE_ENABLED unset)
 *   A. Admin (signed in as admin@example.com): open the printed admin
 *      instance URL, click "Get RSVP link", copy the link.
 *   B. Open the link. Expect: Indonesian UI; no Turnstile iframe in the DOM;
 *      no request to challenges.cloudflare.com in DevTools > Network; the
 *      "Kirim" button is enabled straight away.
 *   C. TOGGLE-OFF submit: Hadir; phone = OFF (local format); Nama =
 *      "[SYNTH] UAT R4 Off"; Kirim -> the normal thank-you.
 *   D. HONEYPOT trip: reload (fresh form). In DevTools > Elements find
 *      <input name="website"> (inside the aria-hidden off-screen div) and set
 *      its value to "https://spam.example" (Console:
 *      document.querySelector('input[name=website]').value = 'https://spam.example').
 *      Hadir; phone = HONEYPOT (local format); Kirim -> the SAME thank-you as
 *      C. ("verify" asserts this phone has zero rows.)
 *   E. Tab order: reload; Tab from the page top through the form — focus
 *      never lands on an invisible field.
 *
 *   Part 2 — admin default_language = en (still RSVP_TURNSTILE_ENABLED unset)
 *   F. Admin: /admin/settings -> Default language = English -> Save.
 *   G. A NEW private window (no 'locale' cookie): open the RSVP link. Expect
 *      the visible page (event header, form labels, button "Kirim", consent
 *      line, privacy link text) in INDONESIAN. Known and accepted until
 *      S11-T18: page source shows <html lang="en">. Do NOT submit.
 *   H. Same window: click "EN" in the header -> English; click "ID" ->
 *      Indonesian again (the cookie wins over everything).
 *   I. Admin: /admin/settings -> Default language = Bahasa Indonesia -> Save.
 *      (Must be done before "verify" — it checks.)
 *
 *   Part 3 — Turnstile ON
 *   0. Owner sets Preview RSVP_TURNSTILE_ENABLED=true and redeploys staging
 *      (the keys are already set). Wait for the deployment to be Ready.
 *   J. Open the link in a new private window. Expect: the button shows
 *      "Memverifikasi…" briefly, then "Kirim" (token issued) with no visible
 *      challenge; page source still has <meta name="referrer"
 *      content="no-referrer">; DevTools > Console has no Turnstile errors;
 *      no "Verifikasi keamanan tidak dapat dimuat" note.
 *      REFERRER CHECK (addendum 5a): if the widget fails to issue a token, or
 *      the console shows a Turnstile/referrer error, STOP — do not change the
 *      referrer policy (owner decision R1 (K)); capture the console + network
 *      and report.
 *   K. TOGGLE-ON submit: Mungkin; phone = ON (local format); Nama =
 *      "[SYNTH] UAT R4 On"; Kirim -> the normal thank-you.
 *   L. Optional blocked-script check: with an ad blocker that blocks
 *      challenges.cloudflare.com (or DevTools > Network request blocking on
 *      that domain), reload -> the button stays disabled and the
 *      "Verifikasi keamanan tidak dapat dimuat…" note appears (immediately or
 *      within 15s). Do NOT submit.
 *   M. TAMPER: reload without the blocker; wait until the button reads
 *      "Kirim" (token issued). Hadir; phone = TAMPER (local format). In the
 *      Console run
 *        document.querySelector('input[name="cf-turnstile-response"]').value = 'x'
 *      then click Kirim -> the generic try-later banner ("RSVP sedang tidak
 *      dapat diproses. Silakan coba lagi nanti."), no thank-you. Owner checks
 *      the Vercel function logs for the staging deployment: a line
 *      "[rsvp] turnstile rejected: <error-codes>" at that time, and no token
 *      or secret in any log line. ("verify" asserts zero rows for TAMPER.)
 *   Afterwards: set RSVP_TURNSTILE_ENABLED back to the agreed staging value.
 *
 *   Then run "verify". Expected rows (and nothing else):
 *     OFF       no person, name set, coming
 *     ON        no person, name set, maybe
 *     HONEYPOT  — no row —
 *     TAMPER    — no row —
 *
 *   NOT covered here (by decision): the per-IP throttle is verified at
 *   vitest only — its in-memory state across Fluid Compute instances is not
 *   deterministically testable live, so there is no staging burst.
 *   Prod rung (separate, after deploy): GET <prod>/rsvp/<any-token> is 404
 *   (RSVP_PUBLIC_ENABLED off in Production).
 *
 * GUARDS (every phase, before any read or write):
 *   1. Shared preflight guard (branch <-> ref map).
 *   2. Staging pin: resolved ref must be exactly STAGING_REF — no local, no prod.
 *   3. Env URL ref must equal STAGING_REF (no split-brain), and
 *      NEXT_PUBLIC_APP_URL must not be localhost.
 * setup additionally: no state file from an earlier run; all synthetic
 *   phones normalise to exactly themselves (and from their local format),
 *   start with +62999, and are absent from people and event_rsvps.
 * verify / cleanup additionally: the state event is [SYNTH] and the state
 *   instance still belongs to it.
 *
 * STATE: scripts/.build/s9-r4-uat-state.json (scripts/.build/ is gitignored)
 * holds the run id and row ids only — no phones, no names, no secrets. The
 * synthetic phones are re-derived from the run id in each phase.
 *
 * SECRETS: none read. The gate secret and Turnstile keys live only in the
 * Vercel deployment; this script never calls submit_rsvp or siteverify.
 *
 * AUDIT (CLAUDE.md rule 6): no PII mutation — no people rows are created or
 * deleted. event.create is logged on setup as in S9-R1 (log_audit,
 * actorUserId = null). audit_log rows are append-only and excluded from the
 * residue check. The public page never touches people / attendance /
 * audit_log.
 */

import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { normalizePhone } from '../lib/utils/phone'
import { AUDIT_ACTIONS, logAudit, type AuditAction } from '../lib/audit'

const STAGING_REF = 'sijfyvaodqkawbeuyrpu'
const SOURCE = 's9-r4-staging-uat'
const TAG = '[s9-r4-uat]'
const STATE_PATH = path.resolve(process.cwd(), 'scripts/.build/s9-r4-uat-state.json')
const SYNTH = '[SYNTH]'
const NAME_OFF = '[SYNTH] UAT R4 Off'
const NAME_ON = '[SYNTH] UAT R4 On'

// ---------------------------------------------------------------------------
// Preflight guard — same preamble as scripts/s9-r1-staging-uat.ts
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
    console.error('==================== PREFLIGHT ABORT (s9-r4-staging-uat) ====================')
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

type PhoneKey = 'OFF' | 'HONEYPOT' | 'ON' | 'TAMPER'
const PHONE_KEYS: PhoneKey[] = ['OFF', 'HONEYPOT', 'ON', 'TAMPER']

/**
 * Fresh synthetic phones, same 12-digit +62999 shape as the S9-R1 UAT,
 * derived from the run id so the state file never has to store a phone.
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

type ExpectedRow = { key: PhoneKey; name: string; status: 'coming' | 'maybe' }
const EXPECTED: ExpectedRow[] = [
  { key: 'OFF', name: NAME_OFF, status: 'coming' },
  { key: 'ON', name: NAME_ON, status: 'maybe' },
]

type State = {
  runId: number
  createdAt: string
  eventId: string
  instanceId: string
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
  const env = await pinStaging('staging-rsvp-r4-uat-setup')
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

  const eventName = `[SYNTH] S9-R4 UAT ${runId}`
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

  // Write state before the child row so a failure still leaves something
  // for "cleanup" to find (the instance id is filled in right after).
  const state: State = { runId, createdAt: new Date().toISOString(), eventId, instanceId: '' }
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

  console.log('')
  console.log(`${TAG} setup done:`)
  console.log(`  - event "${eventName}" + 1 SCHEDULED instance at ${wibDate} 18:00 WIB (no poster)`)
  console.log(`  - state:  ${path.relative(process.cwd(), STATE_PATH)}`)
  console.log('')
  // Every phone printed below goes through the compiled normalizePhone
  // (region ID) once more, immediately before printing — abort on any miss.
  assertSyntheticPhones(phones)
  console.log('================ PHONES TO TYPE (synthetic +62999 — full number intended) ================')
  console.log(`  OFF       ${localFormat(phones.OFF)}    (= ${phones.OFF}, step C, Turnstile off)`)
  console.log(`  HONEYPOT  ${localFormat(phones.HONEYPOT)}    (= ${phones.HONEYPOT}, step D, must write NOTHING)`)
  console.log(`  ON        ${localFormat(phones.ON)}    (= ${phones.ON}, step K, Turnstile on)`)
  console.log(`  TAMPER    ${localFormat(phones.TAMPER)}    (= ${phones.TAMPER}, step M, must write NOTHING)`)
  console.log('==========================================================================================')
  console.log('')
  console.log('NEXT (owner): follow checklist steps A–M in the header of scripts/s9-r4-staging-uat.ts')
  console.log(`  A. as admin@example.com open ${env.appUrl}/admin/events/${eventId}/instances/${state.instanceId}`)
  console.log('     click "Get RSVP link" and open it in a PRIVATE window')
  console.log('  then: node --env-file=.env.staging.local scripts/.build/scripts/s9-r4-staging-uat.js verify')
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
}

async function verify(): Promise<void> {
  const env = await pinStaging('staging-rsvp-r4-uat-verify')
  const state = readState()
  if (!state.instanceId) abort('state has no instance — setup did not finish; run "cleanup" then "setup"')
  const phones = phonesFor(state.runId)
  assertSyntheticPhones(phones)

  const service = serviceClient(env)
  await assertSyntheticFixture(service, state, true)

  const { data: rows, error: rowsErr } = await service
    .from('event_rsvps')
    .select('phone_e164, name, person_id, status')
    .eq('event_instance_id', state.instanceId)
    .order('created_at')
  if (rowsErr) throw new Error(`read rsvps failed: ${rowsErr.message}`)
  const got = (rows ?? []) as RsvpRow[]

  const keyOf = (phone: string): string =>
    (PHONE_KEYS.find(k => phones[k] === phone) as string | undefined) ?? 'UNEXPECTED'

  console.log('')
  console.log(`${TAG} event_rsvps on the UAT instance (${got.length} row(s)):`)
  console.log('  KEY        PHONE   PERSON  NAME  STATUS')
  for (const r of got) {
    console.log(
      `  ${keyOf(r.phone_e164).padEnd(10)} …${last4(r.phone_e164)}   ${(r.person_id ? 'yes' : 'no').padEnd(6)}  ` +
        `${(r.name === null ? 'NULL' : 'set').padEnd(4)}  ${r.status}`,
    )
  }

  const checks: CheckRow[] = []
  checks.push({ id: 'v-count', label: 'exactly 2 RSVP rows on the instance', pass: got.length === 2, detail: `rows=${got.length}` })
  const unexpected = got.filter(r => keyOf(r.phone_e164) === 'UNEXPECTED').length
  checks.push({ id: 'v-phones', label: 'no row for any other phone', pass: unexpected === 0, detail: `unexpected=${unexpected}` })

  for (const e of EXPECTED) {
    const row = got.find(g => g.phone_e164 === phones[e.key])
    const fields = row ? { person: row.person_id === null, name: row.name === e.name, status: row.status === e.status } : null
    const failed = fields ? Object.entries(fields).filter(([, ok]) => !ok).map(([f]) => f) : []
    checks.push({
      id: `v-${e.key.toLowerCase()}`,
      label: `${e.key}: no person, name set, ${e.status}`,
      pass: !!fields && failed.length === 0,
      detail: !row ? 'missing' : failed.length === 0 ? 'ok' : `MISMATCH: ${failed.join(', ')}`,
    })
  }

  for (const k of ['HONEYPOT', 'TAMPER'] as const) {
    const n = await countWhere(service, 'event_rsvps', 'phone_e164', [phones[k]])
    checks.push({ id: `v-${k.toLowerCase()}`, label: `${k} phone wrote zero rows (anywhere)`, pass: n === 0, detail: `rows=${n}` })
  }
  const people = await countWhere(service, 'people', 'phone_e164', Object.values(phones))
  checks.push({ id: 'v-people', label: 'no people row for any UAT phone', pass: people === 0, detail: `people=${people}` })
  const attendance = await countWhere(service, 'attendance', 'event_instance_id', [state.instanceId])
  checks.push({ id: 'v-att', label: 'RSVP wrote no attendance', pass: attendance === 0, detail: `attendance=${attendance}` })

  // Step I restored the admin default. Read-only: this script never writes app_settings.
  const { data: settings, error: settingsErr } = await service.from('app_settings').select('default_language').eq('id', 1).maybeSingle()
  if (settingsErr) throw new Error(`app_settings read failed: ${settingsErr.message}`)
  const lang = (settings as { default_language: string | null } | null)?.default_language ?? null
  checks.push({ id: 'v-lang', label: "admin default_language restored to 'id' (step I)", pass: lang === 'id', detail: `default_language=${lang}` })

  printChecks(checks)
  if (checks.some(c => !c.pass)) abort('verify failed — see the table above; the fixture is kept for inspection, run "cleanup" when done')
  console.log('')
  console.log('When done: node --env-file=.env.staging.local scripts/.build/scripts/s9-r4-staging-uat.js cleanup')
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
  const env = await pinStaging('staging-rsvp-r4-uat-cleanup')
  const state = readState()
  const phones = phonesFor(state.runId)
  const service = serviceClient(env)

  // Safety: everything we are about to delete must still look synthetic.
  await assertSyntheticFixture(service, state, false)

  const del = async (table: string, column: string, values: string[]) => {
    const ids = values.filter(v => v !== '')
    if (ids.length === 0) return
    const { error } = await service.from(table).delete().in(column, ids)
    if (error) throw new Error(`delete ${table} failed: ${error.message}`)
  }

  // Children of the instance first (RSVPs reference links), then the
  // instance and the event. attendance / child_attendance are not expected
  // (RSVP never checks anyone in) but are swept anyway. No people rows exist
  // for this run, so nothing PII-bearing is deleted (no data.wipe audit).
  await del('event_rsvps', 'event_instance_id', [state.instanceId])
  await del('event_rsvp_links', 'event_instance_id', [state.instanceId])
  await del('child_attendance', 'event_instance_id', [state.instanceId])
  await del('attendance', 'event_instance_id', [state.instanceId])
  await del('event_instances', 'id', [state.instanceId])
  await del('events', 'id', [state.eventId])

  // ── residue ──────────────────────────────────────────────────────────────
  const instanceIds = state.instanceId ? [state.instanceId] : []
  const residue: Record<string, number> = {
    events: await countWhere(service, 'events', 'id', [state.eventId]),
    event_instances: await countWhere(service, 'event_instances', 'id', instanceIds),
    event_rsvp_links: await countWhere(service, 'event_rsvp_links', 'event_instance_id', instanceIds),
    event_rsvps: await countWhere(service, 'event_rsvps', 'event_instance_id', instanceIds),
    event_rsvps_by_phone: await countWhere(service, 'event_rsvps', 'phone_e164', Object.values(phones)),
    attendance: await countWhere(service, 'attendance', 'event_instance_id', instanceIds),
    child_attendance: await countWhere(service, 'child_attendance', 'event_instance_id', instanceIds),
    people_by_phone: await countWhere(service, 'people', 'phone_e164', Object.values(phones)),
  }
  const total = Object.values(residue).reduce((a, b) => a + b, 0)
  console.log('')
  console.log(`[residue] ${Object.entries(residue).map(([k, v]) => `${k}=${v}`).join(' ')}`)
  if (total !== 0) abort(`residue remains (${total} row(s)) — state file kept for a re-run`)

  unlinkSync(STATE_PATH)
  console.log(`${TAG} cleanup done — zero residue; state file removed (audit_log rows are append-only and kept; app_settings untouched)`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const [phase] = process.argv.slice(2)
  if (phase === 'setup') return setup()
  if (phase === 'verify') return verify()
  if (phase === 'cleanup') return cleanup()
  abort('usage: s9-r4-staging-uat.js setup | verify | cleanup')
}

main().catch((err) => {
  console.error(`${TAG} FATAL:`, err instanceof Error ? err.message : err)
  process.exit(1)
})
