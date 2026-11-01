/**
 * S9.5-T5.5 Phase 1 — staging smoke for the schedule lock + public schedule
 * note (verification ladder rung 2). Synthetic/staging data only: the [SYNTH]
 * Saturday series (S9.5-T2) and the standing staging admin account. Prints
 * ids, statuses, counts and the synthetic note/description strings — never
 * tokens, keys, phones or emails of people.
 *
 * Phases (in order):
 *
 *   baseline  Read-only. Saturday event: saturday_monthly 2SA 15:00, notes
 *             null, has future occurrences (schedule locked); an active RSVP
 *             link exists on the 2026-11-14 occurrence. Records the baseline
 *             (duration, updated_at) to scripts/.build/s9-5-t5-5-baseline.json.
 *   note      impl_updateEvent (admin session) sets schedule_note (EN) +
 *             schedule_note_id (ID) → ok; row + one event.update audit row.
 *   context   anon get_rsvp_context on the existing 11-14 link → open, note
 *             keys present; formatter fallback (impl_getRsvpPageData with the
 *             anon client, id + en) prints the metadata description string.
 *             Writes the RSVP URL to scripts/.build/s9-5-t5-5-rsvp-url.txt
 *             (0600) for the local-build head render; token last 4 only.
 *             Needs --conditions=react-server.
 *   locked    impl_updateEvent start_time '16:00' (admin) → schedule_locked;
 *             full event row unchanged; no new audit row.
 *   duration  impl_updateEvent duration_min baseline → 210 → ok.
 *   cleanup   Restores notes null + baseline duration via impl_updateEvent
 *             (admin), then asserts zero residue: event row equals baseline
 *             on every column except updated_at; instance rows unchanged.
 *             Audit rows written by note/duration/cleanup stay (append-only).
 *
 * Run (tsc->node — never tsx):
 *   npx tsc -p scripts/tsconfig.s9-5-t5-5-smoke.json
 *   mkdir -p scripts/.build/node_modules && ln -sfn .. scripts/.build/node_modules/@
 *   node --env-file=.env.staging.local scripts/.build/scripts/s9-5/t5-5-staging-smoke.js <phase>
 *   (context only: RSVP_PUBLIC_ENABLED=true node --conditions=react-server --env-file=… … context)
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
import { formatJakarta } from '../../lib/events/timezone'
import { impl_updateEvent, impl_hasFutureOccurrences } from '../../lib/actions/events.impl'
// Loaded lazily: imports 'server-only' (needs --conditions=react-server).
type RsvpPublicModule = typeof import('../../lib/rsvp/public.impl')

const STAGING_REF = 'sijfyvaodqkawbeuyrpu'
const TAG = '[s9-5-t5-5-smoke]'
const ADMIN_EMAIL = 'admin@example.com'
const SATURDAY_NAME = '[SYNTH] Project Day Sabtu'
const LINK_SLOT_WIB = '2026-11-14 15:00'
const NOTE_ID = '15.00 snack & kopi · 16.00 Project Day dimulai'
const NOTE_EN = '15:00 snacks & coffee · 16:00 Project Day starts'
const NEW_DURATION = 210
const BASELINE_PATH = path.resolve(process.cwd(), 'scripts/.build/s9-5-t5-5-baseline.json')
const RSVP_URL_PATH = path.resolve(process.cwd(), 'scripts/.build/s9-5-t5-5-rsvp-url.txt')

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
    console.error('================== PREFLIGHT ABORT (s9-5-t5-5-staging-smoke) ==================')
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
  name_id: string | null
  event_type: string
  start_date: string
  start_time: string
  duration_min: number
  location: string | null
  description: string | null
  recurrence_rule: string | null
  active: boolean
  schedule_note: string | null
  schedule_note_id: string | null
  updated_at: string
}
const EVENT_COLS =
  'id, name, name_id, event_type, start_date, start_time, duration_min, location, description, recurrence_rule, active, schedule_note, schedule_note_id, updated_at'

const wib = (iso: string) => formatJakarta(new Date(iso), 'yyyy-MM-dd HH:mm')

async function saturdayEvent(service: SupabaseClient): Promise<EventRow> {
  const { data, error } = await service.from('events').select(EVENT_COLS).eq('name', SATURDAY_NAME)
  if (error) throw new Error(`events lookup failed: ${error.message}`)
  const rows = (data ?? []) as EventRow[]
  if (rows.length !== 1) abort(`expected exactly 1 event named "${SATURDAY_NAME}", found ${rows.length}`)
  return rows[0]
}

function describeEvent(e: EventRow): string {
  return `${e.id} type=${e.event_type} rrule=${e.recurrence_rule} start=${e.start_date} ${e.start_time} duration=${e.duration_min} active=${e.active} note_en=${JSON.stringify(e.schedule_note)} note_id=${JSON.stringify(e.schedule_note_id)}`
}

async function instanceKeys(service: SupabaseClient, eventId: string): Promise<string> {
  const { data, error } = await service
    .from('event_instances')
    .select('id, scheduled_at, status')
    .eq('event_id', eventId)
    .order('scheduled_at', { ascending: true })
  if (error) throw new Error(`instances lookup failed: ${error.message}`)
  return JSON.stringify(data)
}

async function updateAuditCount(service: SupabaseClient, eventId: string): Promise<number> {
  const { count, error } = await service
    .from('audit_log').select('*', { count: 'exact', head: true })
    .eq('action', 'event.update').eq('entity_id', eventId)
  if (error) throw new Error(`audit count failed: ${error.message}`)
  return count ?? 0
}

async function latestUpdateAudit(service: SupabaseClient, eventId: string) {
  const { data, error } = await service
    .from('audit_log').select('id, actor_user_id, details_json, created_at')
    .eq('action', 'event.update').eq('entity_id', eventId)
    .order('created_at', { ascending: false }).limit(1)
  if (error) throw new Error(`audit read failed: ${error.message}`)
  return (data ?? [])[0] as { id: number; actor_user_id: string | null; details_json: { changed_fields: string[]; updates: Record<string, unknown> }; created_at: string } | undefined
}

async function linkToken(service: SupabaseClient, eventId: string): Promise<{ linkId: string; instanceId: string; token: string }> {
  const { data, error } = await service
    .from('event_rsvp_links')
    .select('id, token, is_active, event_instances!inner(id, event_id, scheduled_at)')
    .eq('event_instances.event_id', eventId)
    .eq('is_active', true)
  if (error) throw new Error(`link lookup failed: ${error.message}`)
  type LinkRow = { id: string; token: string; event_instances: { id: string; scheduled_at: string } }
  const rows = ((data ?? []) as unknown as LinkRow[]).filter(r => wib(r.event_instances.scheduled_at) === LINK_SLOT_WIB)
  if (rows.length !== 1) abort(`expected exactly 1 active link on the ${LINK_SLOT_WIB} WIB occurrence, found ${rows.length}`)
  return { linkId: rows[0].id, instanceId: rows[0].event_instances.id, token: rows[0].token }
}

type Baseline = { event: EventRow; instances: string }

function readBaseline(): Baseline {
  if (!existsSync(BASELINE_PATH)) abort('baseline file missing — run the baseline phase first')
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

async function phaseBaseline(env: Env): Promise<void> {
  const service = serviceClient(env)
  const ev = await saturdayEvent(service)
  console.log(`${TAG} saturday event ${describeEvent(ev)}`)
  check('baseline: saturday_monthly 2SA 15:00, active', ev.event_type === 'saturday_monthly' && ev.recurrence_rule === 'FREQ=MONTHLY;BYDAY=2SA' && ev.start_time === '15:00:00' && ev.active)
  check('baseline: notes null', ev.schedule_note === null && ev.schedule_note_id === null)
  check('baseline: has future occurrences (locked)', await impl_hasFutureOccurrences({ supabase: service, eventId: ev.id }))
  const link = await linkToken(service, ev.id)
  console.log(`${TAG} rsvp link ${link.linkId} on instance ${link.instanceId} (${LINK_SLOT_WIB} WIB) token=…${link.token.slice(-4)}`)
  const instances = await instanceKeys(service, ev.id)
  console.log(`${TAG} instances: ${JSON.parse(instances).length} rows; event.update audit rows: ${await updateAuditCount(service, ev.id)}`)
  writeFileSync(BASELINE_PATH, JSON.stringify({ event: ev, instances } satisfies Baseline), { mode: 0o600 })
  console.log(`${TAG} baseline written to ${path.relative(process.cwd(), BASELINE_PATH)}`)
}

async function phaseNote(env: Env): Promise<void> {
  const service = serviceClient(env)
  const ev = await saturdayEvent(service)
  const admin = await sessionFor(env, service, ADMIN_EMAIL, 'admin')
  const auditsBefore = await updateAuditCount(service, ev.id)
  const result = await impl_updateEvent({
    supabase: admin.client,
    adminSupabase: service,
    eventId: ev.id,
    input: { schedule_note: NOTE_EN, schedule_note_id: NOTE_ID },
  })
  console.log(`${TAG} impl_updateEvent(notes) → ${JSON.stringify(result)}`)
  check('note: status ok', result.status === 'ok')
  const after = await saturdayEvent(service)
  console.log(`${TAG} after: ${describeEvent(after)}`)
  check('note: row has both notes', after.schedule_note === NOTE_EN && after.schedule_note_id === NOTE_ID)
  check('note: schedule fields untouched', after.start_time === ev.start_time && after.start_date === ev.start_date && after.recurrence_rule === ev.recurrence_rule && after.event_type === ev.event_type)
  check('note: exactly 1 new event.update audit row', (await updateAuditCount(service, ev.id)) === auditsBefore + 1)
  const a = await latestUpdateAudit(service, ev.id)
  if (a) {
    console.log(`${TAG} audit ${a.id} actor=${a.actor_user_id} changed=${JSON.stringify(a.details_json.changed_fields)}`)
    check('note: audit actor = staging admin, changed = notes', a.actor_user_id === admin.id &&
      JSON.stringify([...a.details_json.changed_fields].sort()) === JSON.stringify(['schedule_note', 'schedule_note_id']))
  }
}

async function phaseContext(env: Env): Promise<void> {
  const service = serviceClient(env)
  const ev = await saturdayEvent(service)
  const link = await linkToken(service, ev.id)
  const anon = createClient(env.url, env.anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { data, error } = await anon.rpc('get_rsvp_context', { p_token: link.token })
  if (error) throw new Error(`get_rsvp_context failed: ${error.message}`)
  const ctx = data as Record<string, unknown>
  console.log(`${TAG} get_rsvp_context keys=${JSON.stringify(Object.keys(ctx).sort())}`)
  console.log(`${TAG} get_rsvp_context open=${ctx.open} scheduled_at=${wib(ctx.scheduled_at as string)} WIB duration=${ctx.duration_min} schedule_note=${JSON.stringify(ctx.schedule_note)} schedule_note_id=${JSON.stringify(ctx.schedule_note_id)}`)
  check('context: open', ctx.open === true)
  check('context: schedule_note (EN)', ctx.schedule_note === NOTE_EN)
  check('context: schedule_note_id (ID)', ctx.schedule_note_id === NOTE_ID)

  const { impl_getRsvpPageData } = (await import('../../lib/rsvp/public.impl')) as RsvpPublicModule
  for (const locale of ['id', 'en'] as const) {
    const page = await impl_getRsvpPageData(link.token, locale, anon)
    if (page.kind !== 'open') {
      check(`context: page data open (${locale})`, false, page.kind)
      continue
    }
    const e = page.event
    // Same expression as app/rsvp/[token]/page.tsx generateMetadata.
    const description = [e.dateLabel, e.timeLabel, e.scheduleNote, e.location].filter((p): p is string => !!p).join(' · ')
    console.log(`${TAG} [${locale}] timeLabel=${JSON.stringify(e.timeLabel)} scheduleNote=${JSON.stringify(e.scheduleNote)}`)
    console.log(`${TAG} [${locale}] metadata description = ${JSON.stringify(description)}`)
    check(`context: ${locale} note resolved`, e.scheduleNote === (locale === 'id' ? NOTE_ID : NOTE_EN))
  }

  const url = `http://localhost:3000/rsvp/${link.token}`
  writeFileSync(RSVP_URL_PATH, `${url}\n`, { mode: 0o600 })
  chmodSync(RSVP_URL_PATH, 0o600)
  console.log(`${TAG} local render URL written to ${path.relative(process.cwd(), RSVP_URL_PATH)} (token …${link.token.slice(-4)})`)
}

async function phaseLocked(env: Env): Promise<void> {
  const service = serviceClient(env)
  const before = await saturdayEvent(service)
  const instancesBefore = await instanceKeys(service, before.id)
  const auditsBefore = await updateAuditCount(service, before.id)
  const admin = await sessionFor(env, service, ADMIN_EMAIL, 'admin')
  const result = await impl_updateEvent({
    supabase: admin.client,
    adminSupabase: service,
    eventId: before.id,
    input: { start_time: '16:00' },
  })
  console.log(`${TAG} impl_updateEvent(start_time 16:00) → ${JSON.stringify(result)}`)
  check('locked: schedule_locked', result.status === 'schedule_locked')
  const after = await saturdayEvent(service)
  console.log(`${TAG} after: ${describeEvent(after)} updated_at=${after.updated_at}`)
  check('locked: event row unchanged (all columns incl. updated_at)', JSON.stringify(after) === JSON.stringify(before))
  check('locked: instances unchanged', (await instanceKeys(service, before.id)) === instancesBefore)
  check('locked: no new audit row', (await updateAuditCount(service, before.id)) === auditsBefore)
}

async function phaseDuration(env: Env): Promise<void> {
  const service = serviceClient(env)
  const before = await saturdayEvent(service)
  const admin = await sessionFor(env, service, ADMIN_EMAIL, 'admin')
  const result = await impl_updateEvent({
    supabase: admin.client,
    adminSupabase: service,
    eventId: before.id,
    input: { duration_min: NEW_DURATION },
  })
  console.log(`${TAG} impl_updateEvent(duration_min ${before.duration_min} → ${NEW_DURATION}) → ${JSON.stringify(result)}`)
  check('duration: status ok', result.status === 'ok')
  const after = await saturdayEvent(service)
  check(`duration: now ${NEW_DURATION}`, after.duration_min === NEW_DURATION, `duration=${after.duration_min}`)
}

async function phaseCleanup(env: Env): Promise<void> {
  const service = serviceClient(env)
  const baseline = readBaseline()
  const ev = await saturdayEvent(service)
  const admin = await sessionFor(env, service, ADMIN_EMAIL, 'admin')
  const result = await impl_updateEvent({
    supabase: admin.client,
    adminSupabase: service,
    eventId: ev.id,
    input: {
      schedule_note: baseline.event.schedule_note,
      schedule_note_id: baseline.event.schedule_note_id,
      duration_min: baseline.event.duration_min,
    },
  })
  console.log(`${TAG} impl_updateEvent(restore) → ${JSON.stringify(result)}`)
  check('cleanup: status ok', result.status === 'ok')
  const after = await saturdayEvent(service)
  console.log(`${TAG} after: ${describeEvent(after)}`)
  const strip = (e: EventRow) => JSON.stringify({ ...e, updated_at: undefined })
  check('ZERO-RESIDUE: event row = baseline (all columns except updated_at)', strip(after) === strip(baseline.event))
  check('ZERO-RESIDUE: instance rows = baseline', (await instanceKeys(service, ev.id)) === baseline.instances)
}

async function main(): Promise<void> {
  const phase = process.argv[2]
  const phases: Record<string, (env: Env) => Promise<void>> = {
    baseline: phaseBaseline,
    note: phaseNote,
    context: phaseContext,
    locked: phaseLocked,
    duration: phaseDuration,
    cleanup: phaseCleanup,
  }
  const run = phase ? phases[phase] : undefined
  if (!run) abort(`usage: t5-5-staging-smoke.js <${Object.keys(phases).join('|')}>`)
  const env = await pinStaging(`s9-5-t5-5-smoke-${phase}`)
  await run(env)
  console.log(failures === 0 ? `${TAG} ${phase}: ALL PASS` : `${TAG} ${phase}: ${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(err => {
  console.error(`${TAG} ERROR: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
