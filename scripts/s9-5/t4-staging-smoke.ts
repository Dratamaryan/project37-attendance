/**
 * S9.5-T4 — staging smoke for "reschedule one occurrence" (verification ladder
 * rung 2). Synthetic/staging data only: the [SYNTH] Saturday series created in
 * S9.5-T2 and the standing staging accounts (admin@example.com,
 * organizer@example.com). Prints ids, dates, statuses and counts — never
 * tokens, keys, phones or emails of people.
 *
 * Phases (in order):
 *
 *   baseline     Read-only. The Saturday series has its 12 rule slots
 *                (2026-11-14..2027-10-09, dow 6, 15:00 WIB); the 2026-12-12
 *                slot is scheduled with no notes and nothing exists at
 *                2026-12-19 15:00 WIB yet. Refuses to continue otherwise.
 *   reschedule   impl_rescheduleInstance — the action the Reschedule dialog
 *                calls — under the admin session: 2026-12-12 → 2026-12-19
 *                15:00 WIB. Refuses if baseline does not hold (runs once).
 *   verify       Read-only. Original cancelled + its note, one-off scheduled +
 *                its note + snapshot names = the event's, exactly one audit row
 *                event_instance.reschedule with the admin actor and the
 *                {from/to instance id, from/to at, reason} details. Also
 *                reports the series shape (12 rule slots kept + 1 one-off).
 *   materialize  Service role, once, now = real clock (staging crons never
 *                fire): 0 new instances for the Saturday event, the cancelled
 *                slot not recreated, the one-off not pruned; global result
 *                reported.
 *   organizer    impl_rescheduleInstance under the organizer session on the
 *                2027-01-09 slot → not_admin; Saturday rows and reschedule
 *                audit count unchanged.
 *   rsvp         impl_getOrCreateRsvpLink on the one-off (admin session), then
 *                get_rsvp_context(token) with the anon key: open, scheduled_at
 *                = 2026-12-19 15:00 WIB. URL written to
 *                scripts/.build/s9-5-t4-rsvp-url.txt (0600), never printed
 *                (token last 4 only). Needs --conditions=react-server.
 *
 * Cleanup: none by design — the rescheduled pair stays as the staging mirror
 * of the feature (S9.5-T4 prompt).
 *
 * Run (tsc->node — never tsx):
 *   npx tsc -p scripts/tsconfig.s9-5-t4-smoke.json
 *   mkdir -p scripts/.build/node_modules && ln -sfn .. scripts/.build/node_modules/@
 *   node --env-file=.env.staging.local scripts/.build/scripts/s9-5/t4-staging-smoke.js <phase>
 *   (rsvp only: RSVP_PUBLIC_ENABLED=true node --conditions=react-server --env-file=… … rsvp)
 *
 * GUARDS (every phase, before any read or write):
 *   1. Shared preflight guard (branch <-> ref map).
 *   2. Staging pin: resolved ref must be exactly STAGING_REF — no local, no prod.
 *   3. Env URL host must be the staging project (no split-brain).
 */

import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { materializeEvents } from '../../lib/events/materialize.impl'
import { formatJakarta } from '../../lib/events/timezone'
import { impl_rescheduleInstance } from '../../lib/actions/events.impl'
// Loaded lazily: imports 'server-only' (needs --conditions=react-server).
type RsvpAdminModule = typeof import('../../lib/rsvp/admin.impl')

const STAGING_REF = 'sijfyvaodqkawbeuyrpu'
const TAG = '[s9-5-t4-smoke]'
const ADMIN_EMAIL = 'admin@example.com'
const ORGANIZER_EMAIL = 'organizer@example.com'
const SATURDAY_NAME = '[SYNTH] Project Day Sabtu'
const FROM_WIB = '2026-12-12 15:00'
const TO_DATE = '2026-12-19'
const TO_TIME = '15:00'
const ORGANIZER_SLOT_WIB = '2027-01-09 15:00'
const REASON = '[SYNTH] S9.5-T4 staging smoke'
const RSVP_URL_PATH = path.resolve(process.cwd(), 'scripts/.build/s9-5-t4-rsvp-url.txt')
const EXPECTED_SAT_DATES = [
  '2026-11-14', '2026-12-12', '2027-01-09', '2027-02-13', '2027-03-13', '2027-04-10',
  '2027-05-08', '2027-06-12', '2027-07-10', '2027-08-14', '2027-09-11', '2027-10-09',
]

// ---------------------------------------------------------------------------
// Preflight guard — same preamble as scripts/s9-5/t2-staging-smoke.ts
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
    console.error('================== PREFLIGHT ABORT (s9-5-t4-staging-smoke) ==================')
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

type Env = { url: string; serviceKey: string; anonKey: string }

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
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    abort('NEXT_PUBLIC_SUPABASE_URL is not a URL')
  }
  if (host !== `${STAGING_REF}.supabase.co`) abort(`env Supabase host ${host} is not the staging project — refusing`)
  return { url, serviceKey, anonKey }
}

const serviceClient = (env: Env) =>
  createClient(env.url, env.serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })

/** In-memory session for a staging account (magic-link token minted with the service role; no email sent). */
async function sessionFor(env: Env, service: SupabaseClient, email: string, role: 'admin' | 'organizer'): Promise<{ client: SupabaseClient; id: string }> {
  const { data: row, error: rowErr } = await service.from('app_users').select('id, active, role').eq('email', email).maybeSingle()
  if (rowErr) throw new Error(`app_users lookup failed: ${rowErr.message}`)
  const r = row as { id: string; active: boolean; role: string } | null
  if (!r || r.active !== true || r.role !== role) abort(`${email} missing, inactive or not ${role}`)
  const { data: link, error: linkErr } = await service.auth.admin.generateLink({ type: 'magiclink', email })
  if (linkErr) throw new Error(`generateLink failed: ${linkErr.message}`)
  const anon = createClient(env.url, env.anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { data, error } = await anon.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' })
  if (error) throw new Error(`verifyOtp failed: ${error.message}`)
  if (!data.session) throw new Error('verifyOtp returned no session')
  return { client: anon, id: r.id }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
  if (!cond) failures++
}

type InstanceRow = {
  id: string
  scheduled_at: string
  status: string
  notes: string | null
  event_name_snapshot: string
  event_name_snapshot_id: string | null
}
type EventRow = { id: string; name: string; name_id: string | null; active: boolean; event_type: string; recurrence_rule: string | null }

const wib = (iso: string) => formatJakarta(new Date(iso), 'yyyy-MM-dd HH:mm')

async function saturdayEvent(service: SupabaseClient): Promise<EventRow> {
  const { data, error } = await service
    .from('events')
    .select('id, name, name_id, active, event_type, recurrence_rule')
    .eq('name', SATURDAY_NAME)
  if (error) throw new Error(`events lookup failed: ${error.message}`)
  const rows = (data ?? []) as EventRow[]
  if (rows.length !== 1) abort(`expected exactly 1 event named "${SATURDAY_NAME}", found ${rows.length}`)
  const e = rows[0]
  console.log(`${TAG} saturday event ${e.id} type=${e.event_type} rrule=${e.recurrence_rule} active=${e.active}`)
  return e
}

async function instancesOf(service: SupabaseClient, eventId: string): Promise<InstanceRow[]> {
  const { data, error } = await service
    .from('event_instances')
    .select('id, scheduled_at, status, notes, event_name_snapshot, event_name_snapshot_id')
    .eq('event_id', eventId)
    .order('scheduled_at', { ascending: true })
  if (error) throw new Error(`instances lookup failed: ${error.message}`)
  return (data ?? []) as InstanceRow[]
}

function printRows(rows: InstanceRow[]): void {
  for (const r of rows) {
    console.log(`${TAG}   ${r.id} ${formatJakarta(new Date(r.scheduled_at), 'yyyy-MM-dd i HH:mm')} ${r.status}${r.notes ? ` notes=${JSON.stringify(r.notes)}` : ''}`)
  }
}

async function rescheduleAudits(service: SupabaseClient, entityId?: string) {
  let q = service
    .from('audit_log')
    .select('id, actor_user_id, action, entity_type, entity_id, details_json, created_at')
    .eq('action', 'event_instance.reschedule')
  if (entityId) q = q.eq('entity_id', entityId)
  const { data, error } = await q
  if (error) throw new Error(`audit lookup failed: ${error.message}`)
  return (data ?? []) as { id: string; actor_user_id: string | null; action: string; entity_type: string; entity_id: string; details_json: Record<string, unknown>; created_at: string }[]
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

async function phaseBaseline(env: Env): Promise<void> {
  const service = serviceClient(env)
  const ev = await saturdayEvent(service)
  const rows = await instancesOf(service, ev.id)
  printRows(rows)
  check('baseline: event active + recurring', ev.active && ev.event_type === 'saturday_monthly' && !!ev.recurrence_rule)
  check('baseline: 12 rule slots at the expected dates', JSON.stringify(rows.map(r => wib(r.scheduled_at).slice(0, 10))) === JSON.stringify(EXPECTED_SAT_DATES))
  const from = rows.find(r => wib(r.scheduled_at) === FROM_WIB)
  check(`baseline: ${FROM_WIB} WIB slot scheduled, no notes`, !!from && from.status === 'scheduled' && from.notes === null, from ? `${from.id} ${from.status}` : 'missing')
  check(`baseline: nothing at ${TO_DATE} ${TO_TIME} WIB`, !rows.some(r => wib(r.scheduled_at) === `${TO_DATE} ${TO_TIME}`))
  const audits = await rescheduleAudits(service)
  console.log(`${TAG} reschedule audit rows (all): ${audits.length}`)
  const { data: s } = await service.from('app_settings').select('materialization_horizon_mo').limit(1).maybeSingle()
  console.log(`${TAG} materialization_horizon_mo=${(s as { materialization_horizon_mo: number | null } | null)?.materialization_horizon_mo}`)
}

async function phaseReschedule(env: Env): Promise<void> {
  const service = serviceClient(env)
  const ev = await saturdayEvent(service)
  const rows = await instancesOf(service, ev.id)
  const from = rows.find(r => wib(r.scheduled_at) === FROM_WIB)
  if (!from || from.status !== 'scheduled' || from.notes !== null) abort(`${FROM_WIB} slot is not an untouched scheduled row — reschedule refuses to run twice`)
  if (rows.some(r => wib(r.scheduled_at) === `${TO_DATE} ${TO_TIME}`)) abort(`a row already exists at ${TO_DATE} ${TO_TIME} WIB — refusing`)

  const admin = await sessionFor(env, service, ADMIN_EMAIL, 'admin')
  const result = await impl_rescheduleInstance({
    supabase: admin.client,
    instanceId: from.id,
    wibDate: TO_DATE,
    wibTime: TO_TIME,
    reason: REASON,
  })
  console.log(`${TAG} impl_rescheduleInstance(${from.id}, ${TO_DATE}, ${TO_TIME}) → ${JSON.stringify(result)}`)
  check('reschedule: status ok', result.status === 'ok')
  if (result.status === 'ok') {
    check('reschedule: event_id = Saturday event', result.event_id === ev.id)
    check('reschedule: new id differs from the original', result.instance_id !== from.id)
  }
}

async function phaseVerify(env: Env): Promise<void> {
  const service = serviceClient(env)
  const ev = await saturdayEvent(service)
  const rows = await instancesOf(service, ev.id)
  printRows(rows)
  const orig = rows.find(r => wib(r.scheduled_at) === FROM_WIB)
  const oneOff = rows.find(r => wib(r.scheduled_at) === `${TO_DATE} ${TO_TIME}`)
  if (!orig || !oneOff) abort('original or one-off row missing')

  check('verify: original cancelled', orig.status === 'cancelled')
  check('verify: original note', orig.notes === `Rescheduled to ${TO_DATE} ${TO_TIME} WIB: ${REASON}`, JSON.stringify(orig.notes))
  check('verify: one-off scheduled', oneOff.status === 'scheduled')
  check('verify: one-off note', oneOff.notes === `Rescheduled from ${FROM_WIB} WIB: ${REASON}`, JSON.stringify(oneOff.notes))
  check('verify: one-off snapshot names = event names (materializer parity)',
    oneOff.event_name_snapshot === ev.name && oneOff.event_name_snapshot_id === ev.name_id)
  check('verify: one-off dow 6 15:00 WIB', formatJakarta(new Date(oneOff.scheduled_at), 'i HH:mm') === '6 15:00')

  const audits = await rescheduleAudits(service, orig.id)
  const { data: adminRow } = await service.from('app_users').select('id').eq('email', ADMIN_EMAIL).single()
  const adminId = (adminRow as { id: string }).id
  check('verify: exactly 1 audit row for the original', audits.length === 1, `n=${audits.length}`)
  if (audits.length === 1) {
    const a = audits[0]
    console.log(`${TAG} audit ${a.id} actor=${a.actor_user_id} entity=${a.entity_type}/${a.entity_id} details=${JSON.stringify(a.details_json)}`)
    check('verify: audit actor = staging admin', a.actor_user_id === adminId)
    check('verify: audit entity = event_instance/original', a.entity_type === 'event_instance' && a.entity_id === orig.id)
    const d = a.details_json
    check('verify: audit details keys', JSON.stringify(Object.keys(d).sort()) === JSON.stringify(['from_at', 'from_instance_id', 'reason', 'to_at', 'to_instance_id']))
    check('verify: audit details values',
      d.from_instance_id === orig.id && d.to_instance_id === oneOff.id && d.reason === REASON &&
      Date.parse(d.from_at as string) === Date.parse(orig.scheduled_at) && Date.parse(d.to_at as string) === Date.parse(oneOff.scheduled_at))
  }

  // Series shape after the reschedule (12-slot expectation, reported not fixed).
  const ruleSlots = rows.filter(r => EXPECTED_SAT_DATES.includes(wib(r.scheduled_at).slice(0, 10)) && wib(r.scheduled_at).endsWith('15:00'))
  console.log(`${TAG} series shape: rows=${rows.length} rule_slots=${ruleSlots.length} scheduled=${rows.filter(r => r.status === 'scheduled').length} cancelled=${rows.filter(r => r.status === 'cancelled').length} one_offs=${rows.length - ruleSlots.length}`)
  check('verify: 12 rule slots still present (cancelled one keeps its slot)', ruleSlots.length === 12 && JSON.stringify(ruleSlots.map(r => wib(r.scheduled_at).slice(0, 10))) === JSON.stringify(EXPECTED_SAT_DATES))
}

async function phaseMaterialize(env: Env): Promise<void> {
  const service = serviceClient(env)
  const ev = await saturdayEvent(service)
  const before = await instancesOf(service, ev.id)
  const now = new Date()
  const result = await materializeEvents({ supabase: service, now })
  console.log(`${TAG} materializeEvents now=${now.toISOString()} result=${JSON.stringify(result)}`)
  const after = await instancesOf(service, ev.id)
  check('materialize: Saturday event rows unchanged (0 new, cancelled slot not recreated)', JSON.stringify(after) === JSON.stringify(before), `before=${before.length} after=${after.length}`)
  check('materialize: one-off still present + scheduled', after.some(r => wib(r.scheduled_at) === `${TO_DATE} ${TO_TIME}` && r.status === 'scheduled'))
  check('materialize: global instances_inserted = 0', result.instances_inserted === 0, `inserted=${result.instances_inserted}`)
  check('materialize: global instances_pruned = 0', result.instances_pruned === 0, `pruned=${result.instances_pruned}`)
  check('materialize: no event errors', result.events_with_errors.length === 0)
}

async function phaseOrganizer(env: Env): Promise<void> {
  const service = serviceClient(env)
  const ev = await saturdayEvent(service)
  const before = await instancesOf(service, ev.id)
  const auditsBefore = (await rescheduleAudits(service)).length
  const slot = before.find(r => wib(r.scheduled_at) === ORGANIZER_SLOT_WIB)
  if (!slot || slot.status !== 'scheduled') abort(`${ORGANIZER_SLOT_WIB} slot missing or not scheduled`)
  const organizer = await sessionFor(env, service, ORGANIZER_EMAIL, 'organizer')
  const result = await impl_rescheduleInstance({
    supabase: organizer.client,
    instanceId: slot.id,
    wibDate: '2027-01-16',
    wibTime: '15:00',
    reason: REASON,
  })
  console.log(`${TAG} organizer impl_rescheduleInstance(${slot.id}) → ${JSON.stringify(result)}`)
  check('organizer: refused with not_admin', result.status === 'error' && result.code === 'not_admin')
  const after = await instancesOf(service, ev.id)
  check('organizer: Saturday rows unchanged', JSON.stringify(after) === JSON.stringify(before))
  check('organizer: reschedule audit count unchanged', (await rescheduleAudits(service)).length === auditsBefore)
}

async function phaseRsvp(env: Env): Promise<void> {
  const service = serviceClient(env)
  const ev = await saturdayEvent(service)
  const rows = await instancesOf(service, ev.id)
  const oneOff = rows.find(r => wib(r.scheduled_at) === `${TO_DATE} ${TO_TIME}`)
  const orig = rows.find(r => wib(r.scheduled_at) === FROM_WIB)
  if (!oneOff || !orig) abort('one-off or original missing — run reschedule first')
  const admin = await sessionFor(env, service, ADMIN_EMAIL, 'admin')
  const { impl_getOrCreateRsvpLink } = (await import('../../lib/rsvp/admin.impl')) as RsvpAdminModule

  const closed = await impl_getOrCreateRsvpLink(orig.id, admin.client)
  console.log(`${TAG} getOrCreateRsvpLink(original ${orig.id}) → ${JSON.stringify(closed)}`)
  check('rsvp: cancelled original → closed', closed.status === 'closed')

  const result = await impl_getOrCreateRsvpLink(oneOff.id, admin.client)
  if (result.status !== 'ok') {
    check('rsvp: getOrCreateRsvpLink on one-off ok', false, JSON.stringify(result))
    return
  }
  const token = decodeURIComponent(result.url.split('/rsvp/')[1] ?? '')
  writeFileSync(RSVP_URL_PATH, `${result.url}\n`, { mode: 0o600 })
  chmodSync(RSVP_URL_PATH, 0o600)
  console.log(`${TAG} getOrCreateRsvpLink(one-off ${oneOff.id}) → ok link=${result.linkId} created=${result.created} token=…${token.slice(-4)} (URL in ${path.relative(process.cwd(), RSVP_URL_PATH)})`)
  check('rsvp: link minted on the one-off', token.length >= 32)

  const anon = createClient(env.url, env.anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { data, error } = await anon.rpc('get_rsvp_context', { p_token: token })
  if (error) throw new Error(`get_rsvp_context failed: ${error.message}`)
  const ctx = data as { open: boolean; scheduled_at?: string }
  console.log(`${TAG} get_rsvp_context → open=${ctx.open} scheduled_at=${ctx.scheduled_at}`)
  check('rsvp: context open', ctx.open === true)
  check(`rsvp: context scheduled_at = ${TO_DATE} ${TO_TIME} WIB`, !!ctx.scheduled_at && wib(ctx.scheduled_at) === `${TO_DATE} ${TO_TIME}`)
}

async function main(): Promise<void> {
  const phase = process.argv[2]
  const phases: Record<string, (env: Env) => Promise<void>> = {
    baseline: phaseBaseline,
    reschedule: phaseReschedule,
    verify: phaseVerify,
    materialize: phaseMaterialize,
    organizer: phaseOrganizer,
    rsvp: phaseRsvp,
  }
  const run = phase ? phases[phase] : undefined
  if (!run) abort(`usage: t4-staging-smoke.js <${Object.keys(phases).join('|')}>`)
  const env = await pinStaging(`s9-5-t4-smoke-${phase}`)
  await run(env)
  console.log(failures === 0 ? `${TAG} ${phase}: ALL PASS` : `${TAG} ${phase}: ${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(err => {
  console.error(`${TAG} ERROR: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
