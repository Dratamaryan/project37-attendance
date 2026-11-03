/**
 * S9.5-T5.5 Phase 2 — staging smoke for schedule-edit propagation
 * (verification ladder rung 2). Synthetic/staging data only: the [SYNTH]
 * Saturday series (S9.5-T2), a temporary [SYNTH] adhoc event created and
 * deleted by this script, and the standing staging admin account. Prints ids,
 * statuses, counts and WIB times — never tokens (last 4 only), keys, phones or
 * emails of people.
 *
 * Phases (in order):
 *
 *   baseline  Read-only. Saturday event 2SA 15:00 with future rows; one active
 *             RSVP link on 2026-11-14; the materializer would insert 0 for it
 *             (rows cover the new-rule window). Records event row + instance
 *             keys to scripts/.build/s9-5-t5-5-p2-baseline.json.
 *   r16       preview + impl_updateEvent(start_time 16:00, confirm) as admin →
 *             ok; rule rows (scheduled + cancelled) at 16:00 on the same WIB
 *             date, the T4 one-off unmoved, ids unchanged, RSVP link still on
 *             its instance and get_rsvp_context shows 16:00; one
 *             event.schedule_change audit row; materializer inserts 0 (×2).
 *   r15       the same back to 15:00; instance rows == baseline exactly.
 *   adhoc     impl_createEvent [SYNTH] adhoc (+10 d 15:00) → 1 row; A move to
 *             +11 d 17:30 → ok, same id; materializer 0. Event id saved to
 *             scripts/.build/s9-5-t5-5-p2-adhoc.json for cleanup.
 *   refuse    Saturday 15:00 → 06:00 → schedule_change_refused/early_time;
 *             event + rows unchanged; no audit row.
 *   cleanup   Deletes the [SYNTH] adhoc event (cascade), then asserts zero
 *             residue: Saturday event row == baseline except updated_at,
 *             instance rows == baseline, no event named like the temp adhoc.
 *             Audit rows stay (append-only).
 *
 * Run (tsc->node — never tsx):
 *   npx tsc -p scripts/tsconfig.s9-5-t5-5-p2-smoke.json
 *   mkdir -p scripts/.build/node_modules && ln -sfn .. scripts/.build/node_modules/@
 *   node --env-file=.env.staging.local scripts/.build/scripts/s9-5/t5-5-p2-staging-smoke.js <phase>
 *
 * GUARDS (every phase, before any read or write):
 *   1. Shared preflight guard (branch <-> ref map).
 *   2. Staging pin: resolved ref must be exactly STAGING_REF — no local, no prod.
 *   3. Env URL host must be the staging project (no split-brain).
 */

import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { addDays } from 'date-fns'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { formatJakarta, toJakartaInstant } from '../../lib/events/timezone'
import { materializeEvents } from '../../lib/events/materialize.impl'
import {
  impl_createEvent,
  impl_previewScheduleChange,
  impl_updateEvent,
} from '../../lib/actions/events.impl'

const STAGING_REF = 'sijfyvaodqkawbeuyrpu'
const TAG = '[s9-5-t5-5-p2-smoke]'
const ADMIN_EMAIL = 'admin@example.com'
const SATURDAY_NAME = '[SYNTH] Project Day Sabtu'
const ADHOC_NAME = '[SYNTH] S9.5-T5.5 P2 Adhoc'
const LINK_SLOT_DATE = '2026-11-14'
const BASELINE_PATH = path.resolve(process.cwd(), 'scripts/.build/s9-5-t5-5-p2-baseline.json')
const ADHOC_PATH = path.resolve(process.cwd(), 'scripts/.build/s9-5-t5-5-p2-adhoc.json')

// ---------------------------------------------------------------------------
// Preflight guard — same preamble as scripts/s9-5/t5-5-staging-smoke.ts
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
    console.error('================== PREFLIGHT ABORT (s9-5-t5-5-p2-staging-smoke) ==================')
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type EventRow = {
  id: string
  name: string
  event_type: string
  start_date: string
  start_time: string
  duration_min: number
  recurrence_rule: string | null
  active: boolean
  schedule_note: string | null
  schedule_note_id: string | null
  updated_at: string
}
type Inst = { id: string; scheduled_at: string; status: string }

const EVENT_COLS =
  'id, name, event_type, start_date, start_time, duration_min, recurrence_rule, active, schedule_note, schedule_note_id, updated_at'

const wib = (iso: string) => formatJakarta(new Date(iso), 'yyyy-MM-dd HH:mm')
const wibDate = (iso: string) => wib(iso).slice(0, 10)
const wibTime = (iso: string) => wib(iso).slice(11)
const short = (id: string) => id.slice(0, 8)

async function eventByName(service: SupabaseClient, name: string): Promise<EventRow[]> {
  const { data, error } = await service.from('events').select(EVENT_COLS).eq('name', name)
  if (error) throw new Error(`events lookup failed: ${error.message}`)
  return (data ?? []) as EventRow[]
}

async function saturdayEvent(service: SupabaseClient): Promise<EventRow> {
  const rows = await eventByName(service, SATURDAY_NAME)
  if (rows.length !== 1) abort(`expected exactly 1 event named "${SATURDAY_NAME}", found ${rows.length}`)
  return rows[0]
}

async function instances(service: SupabaseClient, eventId: string): Promise<Inst[]> {
  const { data, error } = await service
    .from('event_instances')
    .select('id, scheduled_at, status')
    .eq('event_id', eventId)
    .order('scheduled_at', { ascending: true })
  if (error) throw new Error(`instances lookup failed: ${error.message}`)
  return ((data ?? []) as Inst[]).map(r => ({ ...r, scheduled_at: new Date(r.scheduled_at).toISOString() }))
}

const future = (rows: Inst[]) =>
  rows.filter(r => Date.parse(r.scheduled_at) > Date.now() && (r.status === 'scheduled' || r.status === 'cancelled'))

function printRows(label: string, rows: Inst[]): void {
  console.log(`${TAG} ${label}:`)
  for (const r of rows) console.log(`    ${short(r.id)} ${wib(r.scheduled_at)} ${r.status}`)
}

async function scheduleAudits(service: SupabaseClient, eventId: string) {
  const { data, error } = await service
    .from('audit_log').select('id, actor_user_id, details_json, created_at')
    .eq('action', 'event.schedule_change').eq('entity_id', eventId)
    .order('id', { ascending: true })
  if (error) throw new Error(`audit read failed: ${error.message}`)
  return (data ?? []) as {
    id: number
    actor_user_id: string | null
    details_json: { old: Record<string, unknown>; new: Record<string, unknown>; moves: { id: string; status: string }[]; expected_count: number }
  }[]
}

async function linkOnSlot(service: SupabaseClient, eventId: string): Promise<{ instanceId: string; token: string }> {
  const { data, error } = await service
    .from('event_rsvp_links')
    .select('token, is_active, event_instances!inner(id, event_id, scheduled_at)')
    .eq('event_instances.event_id', eventId)
    .eq('is_active', true)
  if (error) throw new Error(`link lookup failed: ${error.message}`)
  type LinkRow = { token: string; event_instances: { id: string; scheduled_at: string } }
  const rows = ((data ?? []) as unknown as LinkRow[]).filter(r => wibDate(r.event_instances.scheduled_at) === LINK_SLOT_DATE)
  if (rows.length !== 1) abort(`expected 1 active RSVP link on ${LINK_SLOT_DATE}, found ${rows.length}`)
  return { instanceId: rows[0].event_instances.id, token: rows[0].token }
}

async function materializeZero(service: SupabaseClient, eventId: string, label: string): Promise<void> {
  for (let i = 1; i <= 2; i++) {
    const before = JSON.stringify(await instances(service, eventId))
    const result = await materializeEvents({ supabase: service, now: new Date() })
    console.log(`${TAG} materializer run ${i} (${label}): processed=${result.events_processed} inserted=${result.instances_inserted} pruned=${result.instances_pruned} errors=${result.events_with_errors.length}`)
    check(`materializer run ${i} inserted 0 (${label})`, result.instances_inserted === 0 && result.events_with_errors.length === 0)
    check(`instance rows unchanged by run ${i} (${label})`, JSON.stringify(await instances(service, eventId)) === before)
  }
}

type Baseline = { event: EventRow; rows: Inst[]; linkInstanceId: string }

function readBaseline(): Baseline {
  if (!existsSync(BASELINE_PATH)) abort('baseline missing — run the baseline phase first')
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

async function phaseBaseline(env: Env): Promise<void> {
  const service = serviceClient(env)
  const e = await saturdayEvent(service)
  console.log(`${TAG} saturday event ${e.id} type=${e.event_type} rrule=${e.recurrence_rule} start=${e.start_date} ${e.start_time} active=${e.active}`)
  check('saturday_monthly 2SA 15:00, active', e.event_type === 'saturday_monthly' && e.recurrence_rule === 'FREQ=MONTHLY;BYDAY=2SA' && e.start_time === '15:00:00' && e.active)
  const rows = await instances(service, e.id)
  const fut = future(rows)
  printRows('future rows', fut)
  check('has future rows (schedule locked)', fut.length > 0)
  const link = await linkOnSlot(service, e.id)
  console.log(`${TAG} rsvp link on ${short(link.instanceId)} (${LINK_SLOT_DATE}) token=…${link.token.slice(-4)}`)
  const baseline: Baseline = { event: e, rows, linkInstanceId: link.instanceId }
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2))
  console.log(`${TAG} baseline written (${rows.length} rows)`)
}

async function phaseMove(env: Env, to: '16:00' | '15:00'): Promise<void> {
  const service = serviceClient(env)
  const admin = await sessionFor(env, service, ADMIN_EMAIL, 'admin')
  const base = readBaseline()
  const e = await saturdayEvent(service)
  const from = e.start_time.slice(0, 5)
  const before = await instances(service, e.id)
  const auditsBefore = (await scheduleAudits(service, e.id)).length

  const preview = await impl_previewScheduleChange({ supabase: admin.client, eventId: e.id, input: { start_date: e.start_date, start_time: to } })
  console.log(`${TAG} preview ${from}→${to} → ${JSON.stringify(preview)}`)
  check(`preview ok (R)`, preview.status === 'ok' && preview.shape === 'R')

  const result = await impl_updateEvent({
    supabase: admin.client, adminSupabase: service, eventId: e.id,
    input: { start_time: to }, options: { confirmScheduleChange: true },
  })
  console.log(`${TAG} impl_updateEvent(start_time ${to}, confirm) → ${JSON.stringify(result)}`)
  check('update ok with schedule_change', result.status === 'ok' && result.schedule_change !== undefined)
  if (preview.status === 'ok' && result.status === 'ok' && result.schedule_change) {
    check('moved / cancelled_moved match the preview', result.schedule_change.moved === preview.moved && result.schedule_change.cancelled_moved === preview.cancelled_moved,
      `${result.schedule_change.moved}/${result.schedule_change.cancelled_moved}`)
  }

  const after = await instances(service, e.id)
  printRows('rows after', future(after))
  check('event start_time updated', (await saturdayEvent(service)).start_time === `${to}:00`)
  check('same instance ids', JSON.stringify(after.map(r => r.id).sort()) === JSON.stringify(before.map(r => r.id).sort()))
  check('statuses unchanged', after.every(a => before.find(b => b.id === a.id)?.status === a.status))
  const moved = future(after).filter(a => {
    const b = before.find(x => x.id === a.id)!
    return b.scheduled_at !== a.scheduled_at
  })
  check('every moved row kept its WIB date and is at the new time', moved.length > 0 && moved.every(a => {
    const b = before.find(x => x.id === a.id)!
    return wibDate(a.scheduled_at) === wibDate(b.scheduled_at) && wibTime(a.scheduled_at) === to
  }), `${moved.length} moved`)
  const stayed = future(after).filter(a => before.find(x => x.id === a.id)!.scheduled_at === a.scheduled_at)
  console.log(`${TAG} unmoved future rows: ${stayed.map(r => `${short(r.id)} ${wib(r.scheduled_at)} ${r.status}`).join(', ') || '(none)'}`)

  const link = await linkOnSlot(service, e.id)
  check('RSVP link still on the same instance', link.instanceId === base.linkInstanceId)
  const anon = createClient(env.url, env.anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { data: ctx, error: ctxErr } = await anon.rpc('get_rsvp_context', { p_token: link.token })
  const c = ctx as { open?: boolean; scheduled_at?: string } | null
  console.log(`${TAG} get_rsvp_context(…${link.token.slice(-4)}) open=${c?.open} scheduled_at=${c?.scheduled_at ? wib(c.scheduled_at) : null} err=${ctxErr?.message ?? null}`)
  check('public RSVP context shows the new time', c?.open === true && !!c.scheduled_at && wibTime(c.scheduled_at) === to)

  const audits = await scheduleAudits(service, e.id)
  const last = audits[audits.length - 1]
  console.log(`${TAG} audit ${last?.id} actor=${last?.actor_user_id} old.start_time=${String(last?.details_json.old.start_time)} new.start_time=${String(last?.details_json.new.start_time)} moves=${last?.details_json.moves.length} cancelled=${last?.details_json.moves.filter(m => m.status === 'cancelled').length} expected_count=${last?.details_json.expected_count}`)
  check('one new event.schedule_change audit row by the admin', audits.length === auditsBefore + 1 && last.actor_user_id === admin.id)

  await materializeZero(service, e.id, `after ${to}`)

  if (to === '15:00') {
    const final = await instances(service, e.id)
    check('instance rows == baseline (ids, times, statuses)', JSON.stringify(final) === JSON.stringify(base.rows))
  }
}

async function phaseAdhoc(env: Env): Promise<void> {
  const service = serviceClient(env)
  const admin = await sessionFor(env, service, ADMIN_EMAIL, 'admin')
  if ((await eventByName(service, ADHOC_NAME)).length !== 0) abort(`"${ADHOC_NAME}" already exists — run cleanup first`)
  const d0 = formatJakarta(addDays(new Date(), 10), 'yyyy-MM-dd')
  const d1 = formatJakarta(addDays(new Date(), 11), 'yyyy-MM-dd')
  const created = await impl_createEvent({
    supabase: admin.client, adminSupabase: service,
    input: { name: ADHOC_NAME, name_id: ADHOC_NAME, event_type: 'adhoc', start_date: d0, start_time: '15:00', duration_min: 120, location: '[SYNTH] Hall', recurrence_rule: null },
  })
  console.log(`${TAG} impl_createEvent(adhoc ${d0} 15:00) → ${JSON.stringify(created)}`)
  if (created.status !== 'ok') abort('adhoc create failed')
  writeFileSync(ADHOC_PATH, JSON.stringify({ id: created.event_id }))
  const before = await instances(service, created.event_id)
  printRows('adhoc rows before', before)
  check('adhoc has exactly 1 future row', before.length === 1 && future(before).length === 1)

  const preview = await impl_previewScheduleChange({ supabase: admin.client, eventId: created.event_id, input: { start_date: d1, start_time: '17:30' } })
  console.log(`${TAG} preview → ${JSON.stringify(preview)}`)
  const result = await impl_updateEvent({
    supabase: admin.client, adminSupabase: service, eventId: created.event_id,
    input: { start_date: d1, start_time: '17:30' }, options: { confirmScheduleChange: true },
  })
  console.log(`${TAG} impl_updateEvent(adhoc → ${d1} 17:30, confirm) → ${JSON.stringify(result)}`)
  check('adhoc move ok, moved 1', result.status === 'ok' && result.schedule_change?.moved === 1)
  const after = await instances(service, created.event_id)
  printRows('adhoc rows after', after)
  check('same id, new instant', after.length === 1 && after[0].id === before[0].id && after[0].scheduled_at === toJakartaInstant(d1, '17:30').toISOString())
  await materializeZero(service, created.event_id, 'adhoc')
}

async function phaseRefuse(env: Env): Promise<void> {
  const service = serviceClient(env)
  const admin = await sessionFor(env, service, ADMIN_EMAIL, 'admin')
  const e = await saturdayEvent(service)
  const before = JSON.stringify({ e, rows: await instances(service, e.id) })
  const auditsBefore = (await scheduleAudits(service, e.id)).length
  const result = await impl_updateEvent({
    supabase: admin.client, adminSupabase: service, eventId: e.id,
    input: { start_time: '06:00' }, options: { confirmScheduleChange: true },
  })
  console.log(`${TAG} impl_updateEvent(start_time 06:00, confirm) → ${JSON.stringify(result)}`)
  check('refused early_time', result.status === 'schedule_change_refused' && result.reason === 'early_time')
  const e2 = await saturdayEvent(service)
  check('event + rows unchanged (all columns incl. updated_at)', JSON.stringify({ e: e2, rows: await instances(service, e.id) }) === before)
  check('no audit row', (await scheduleAudits(service, e.id)).length === auditsBefore)
}

async function phaseCleanup(env: Env): Promise<void> {
  const service = serviceClient(env)
  const base = readBaseline()
  if (existsSync(ADHOC_PATH)) {
    const { id } = JSON.parse(readFileSync(ADHOC_PATH, 'utf8')) as { id: string }
    const temp = await eventByName(service, ADHOC_NAME)
    if (temp.length === 1 && temp[0].id === id) {
      const { error } = await service.from('events').delete().eq('id', id)
      console.log(`${TAG} delete temp adhoc ${short(id)} → ${error ? error.message : 'ok'}`)
    } else {
      console.log(`${TAG} temp adhoc ${short(id)} not found by name/id (${temp.length}) — nothing deleted`)
    }
  }
  const e = await saturdayEvent(service)
  const strip = (x: EventRow) => ({ ...x, updated_at: undefined })
  check('ZERO-RESIDUE: saturday event row = baseline (all columns except updated_at)', JSON.stringify(strip(e)) === JSON.stringify(strip(base.event)))
  check('ZERO-RESIDUE: saturday instance rows = baseline', JSON.stringify(await instances(service, e.id)) === JSON.stringify(base.rows))
  check(`ZERO-RESIDUE: no event named "${ADHOC_NAME}"`, (await eventByName(service, ADHOC_NAME)).length === 0)
  const { count } = await service.from('event_instances').select('id', { count: 'exact', head: true }).like('event_name_snapshot', `${ADHOC_NAME}%`)
  check('ZERO-RESIDUE: no instance snapshot of the temp adhoc', (count ?? 0) === 0)
}

async function main(): Promise<void> {
  const phase = process.argv[2]
  const phases: Record<string, (env: Env) => Promise<void>> = {
    baseline: phaseBaseline,
    r16: env => phaseMove(env, '16:00'),
    r15: env => phaseMove(env, '15:00'),
    adhoc: phaseAdhoc,
    refuse: phaseRefuse,
    cleanup: phaseCleanup,
  }
  if (!phase || !phases[phase]) abort(`usage: <${Object.keys(phases).join('|')}>`)
  const env = await pinStaging(`s9-5-t5-5-p2-smoke-${phase}`)
  await phases[phase](env)
  console.log(`${TAG} ${phase}: ${failures === 0 ? 'ALL PASS' : `${failures} FAIL`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(e => {
  console.error(`${TAG} ERROR`, e instanceof Error ? e.message : e)
  process.exit(1)
})
