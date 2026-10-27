/**
 * S9.5-T2 — staging smoke for the Fri→Sat change (verification ladder rung 2).
 * Synthetic/staging data only. Prints ids, dates, statuses and counts — never
 * phones, names of people, emails, tokens or keys.
 *
 * Phases (run after t2-retire-friday-series.staging.sql has been applied and
 * the "[SYNTH] Project Day Sabtu" event has been created in the staging UI):
 *
 *   materialize  Service role. Staging crons never fire (Vercel crons run on
 *                production deployments only), so this invokes the real
 *                materializeEvents() once, with now = the real clock, exactly
 *                as the 06:30 WIB cron would. Asserts it inserts 0 rows for the
 *                Saturday event (createEvent already materialized it) and 0 for
 *                the retired Friday event, and reports the global result.
 *   verify       Read-only. 12 Saturday instances, ISO dow 6, the expected date
 *                list, 15:00 WIB; Friday event inactive; no Friday instance on
 *                or after 2026-11-01 WIB is 'scheduled'.
 *   invite       Admin session (magic-link token minted with the service role,
 *                no email sent) → impl_sendInvites on the cancelled Friday
 *                11-13 instance with a filter that matches nobody and a stub
 *                transport that counts calls. Asserts 'instance_not_open', 0
 *                transport calls, 0 new event_invitations rows.
 *
 * Run (tsc->node — never tsx):
 *   npx tsc -p scripts/tsconfig.s9-5-t2-smoke.json
 *   mkdir -p scripts/.build/node_modules && ln -sfn .. scripts/.build/node_modules/@
 *     (resolves the app's '@/…' imports to the compiled tree)
 *   node --env-file=.env.staging.local scripts/.build/scripts/s9-5/t2-staging-smoke.js <phase>
 *
 * GUARDS (every phase, before any read or write):
 *   1. Shared preflight guard (branch <-> ref map).
 *   2. Staging pin: resolved ref must be exactly STAGING_REF — no local, no prod.
 *   3. Env URL host must be the staging project (no split-brain).
 */

import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { materializeEvents } from '../../lib/events/materialize.impl'
import { formatJakarta } from '../../lib/events/timezone'
import { impl_sendInvites } from '../../lib/actions/invites.impl'
import type { EmailTransport, SendEmailResult } from '../../lib/email/transport'

const STAGING_REF = 'sijfyvaodqkawbeuyrpu'
const TAG = '[s9-5-t2-smoke]'
const ADMIN_EMAIL = 'admin@example.com'
const SATURDAY_NAME = '[SYNTH] Project Day Sabtu'
const FRIDAY_EVENT_ID = '9ae8cfb8-ba56-48da-bec3-a4242b1260c9'
const FRIDAY_NOV13_ID = '72052fc3-66aa-447b-ac65-d54beac33552'
const NOV_1_WIB = '2026-10-31T17:00:00.000Z'
const EXPECTED_SAT_DATES = [
  '2026-11-14', '2026-12-12', '2027-01-09', '2027-02-13', '2027-03-13', '2027-04-10',
  '2027-05-08', '2027-06-12', '2027-07-10', '2027-08-14', '2027-09-11', '2027-10-09',
]

// ---------------------------------------------------------------------------
// Preflight guard — same preamble as scripts/s9-r6-staging-uat.ts
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
    console.error('================== PREFLIGHT ABORT (s9-5-t2-staging-smoke) ==================')
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

/** In-memory admin session (magic-link token minted with the service role; no email sent). */
async function adminSession(env: Env, service: SupabaseClient): Promise<SupabaseClient> {
  const { data: row, error: rowErr } = await service.from('app_users').select('active, role').eq('email', ADMIN_EMAIL).maybeSingle()
  if (rowErr) throw new Error(`app_users lookup failed: ${rowErr.message}`)
  const r = row as { active: boolean; role: string } | null
  if (!r || r.active !== true || r.role !== 'admin') abort(`${ADMIN_EMAIL} missing, inactive or not admin`)
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
  if (!cond) failures++
}

type InstanceRow = { id: string; scheduled_at: string; status: string }

async function saturdayEventId(service: SupabaseClient): Promise<string> {
  const { data, error } = await service
    .from('events')
    .select('id, event_type, recurrence_rule, start_date, start_time, duration_min, active')
    .eq('name', SATURDAY_NAME)
  if (error) throw new Error(`events lookup failed: ${error.message}`)
  const rows = (data ?? []) as { id: string; event_type: string; recurrence_rule: string; start_date: string; start_time: string; duration_min: number; active: boolean }[]
  if (rows.length !== 1) abort(`expected exactly 1 event named "${SATURDAY_NAME}", found ${rows.length}`)
  const e = rows[0]
  console.log(`${TAG} saturday event ${e.id} type=${e.event_type} rrule=${e.recurrence_rule} start=${e.start_date} ${e.start_time} dur=${e.duration_min} active=${e.active}`)
  return e.id
}

async function instancesOf(service: SupabaseClient, eventId: string): Promise<InstanceRow[]> {
  const { data, error } = await service
    .from('event_instances')
    .select('id, scheduled_at, status')
    .eq('event_id', eventId)
    .order('scheduled_at', { ascending: true })
  if (error) throw new Error(`instances lookup failed: ${error.message}`)
  return (data ?? []) as InstanceRow[]
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

async function phaseMaterialize(env: Env): Promise<void> {
  const service = serviceClient(env)
  const satId = await saturdayEventId(service)
  const satBefore = await instancesOf(service, satId)
  const friBefore = await instancesOf(service, FRIDAY_EVENT_ID)

  const now = new Date()
  const result = await materializeEvents({ supabase: service, now })
  console.log(`${TAG} materializeEvents now=${now.toISOString()} result=${JSON.stringify(result)}`)

  const satAfter = await instancesOf(service, satId)
  const friAfter = await instancesOf(service, FRIDAY_EVENT_ID)
  check('materialize: Saturday event — 0 new instances', satAfter.length === satBefore.length, `before=${satBefore.length} after=${satAfter.length}`)
  check('materialize: retired Friday event — 0 new instances', friAfter.length === friBefore.length, `before=${friBefore.length} after=${friAfter.length}`)
  check('materialize: global instances_inserted = 0', result.instances_inserted === 0, `inserted=${result.instances_inserted}`)
  check('materialize: no event errors', result.events_with_errors.length === 0)
}

async function phaseVerify(env: Env): Promise<void> {
  const service = serviceClient(env)
  const satId = await saturdayEventId(service)
  const sat = await instancesOf(service, satId)
  const dates = sat.map(r => formatJakarta(new Date(r.scheduled_at), 'yyyy-MM-dd'))
  for (const r of sat) console.log(`${TAG} sat ${r.id} ${formatJakarta(new Date(r.scheduled_at), 'yyyy-MM-dd i HH:mm')} ${r.status}`)
  check('verify: 12 Saturday instances', sat.length === 12, `n=${sat.length}`)
  check('verify: expected date list', JSON.stringify(dates) === JSON.stringify(EXPECTED_SAT_DATES), dates.join(' '))
  check('verify: all ISO dow 6 at 15:00 WIB', sat.every(r => formatJakarta(new Date(r.scheduled_at), 'i HH:mm') === '6 15:00'))
  check('verify: all scheduled', sat.every(r => r.status === 'scheduled'))

  const { data: fri, error: friErr } = await service.from('events').select('active').eq('id', FRIDAY_EVENT_ID).single()
  if (friErr) throw new Error(`friday event lookup failed: ${friErr.message}`)
  check('verify: Friday event inactive', (fri as { active: boolean }).active === false)

  const { count, error } = await service
    .from('event_instances')
    .select('id', { count: 'exact', head: true })
    .eq('event_id', FRIDAY_EVENT_ID)
    .eq('status', 'scheduled')
    .gte('scheduled_at', NOV_1_WIB)
  if (error) throw new Error(`friday instances count failed: ${error.message}`)
  check('verify: no Friday instance on/after 2026-11-01 WIB is scheduled', count === 0, `scheduled=${count}`)
}

async function phaseInvite(env: Env): Promise<void> {
  const service = serviceClient(env)
  const admin = await adminSession(env, service)

  const { data: inst, error: instErr } = await service
    .from('event_instances')
    .select('status, event_id')
    .eq('id', FRIDAY_NOV13_ID)
    .single()
  if (instErr) throw new Error(`instance lookup failed: ${instErr.message}`)
  const i = inst as { status: string; event_id: string }
  if (i.event_id !== FRIDAY_EVENT_ID || i.status !== 'cancelled') abort(`instance ${FRIDAY_NOV13_ID} is not the cancelled Friday instance (status=${i.status})`)

  const countInvites = async (): Promise<number> => {
    const { count, error } = await service
      .from('event_invitations')
      .select('id', { count: 'exact', head: true })
      .eq('event_instance_id', FRIDAY_NOV13_ID)
    if (error) throw new Error(`invitations count failed: ${error.message}`)
    return count ?? 0
  }

  let calls = 0
  const transport: EmailTransport = {
    async send(): Promise<SendEmailResult> {
      calls++
      return { ok: false, reason: 'smtp_error', message: 'smoke stub — never sends' }
    },
  }
  const before = await countInvites()
  const result = await impl_sendInvites({
    supabase: admin,
    transport,
    eventInstanceId: FRIDAY_NOV13_ID,
    // Matches nobody — a second net under the guard: even a broken guard sends nothing.
    filter: { tribe: `[SYNTH] s9-5-t2-smoke-none-${Date.now()}` },
    emailIdentity: { organizerEmail: 'organizer@test.invalid', fromName: 'S9.5 smoke', replyTo: 'reply@test.invalid' },
    sendIntervalMs: 0,
    sleep: async () => {},
  })
  const after = await countInvites()
  console.log(`${TAG} sendInvites on cancelled Friday 11-13 → ${JSON.stringify(result)}`)
  check('invite: send on cancelled Friday instance → instance_not_open', result.status === 'instance_not_open')
  check('invite: transport never called', calls === 0, `calls=${calls}`)
  check('invite: no event_invitations rows written', after === before, `before=${before} after=${after}`)
}

async function main(): Promise<void> {
  const phase = process.argv[2]
  const phases: Record<string, (env: Env) => Promise<void>> = {
    materialize: phaseMaterialize,
    verify: phaseVerify,
    invite: phaseInvite,
  }
  const run = phase ? phases[phase] : undefined
  if (!run) abort(`usage: t2-staging-smoke.js <${Object.keys(phases).join('|')}>`)
  const env = await pinStaging(`s9-5-t2-smoke-${phase}`)
  await run(env)
  console.log(failures === 0 ? `${TAG} ${phase}: ALL PASS` : `${TAG} ${phase}: ${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(err => {
  console.error(`${TAG} ERROR: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
