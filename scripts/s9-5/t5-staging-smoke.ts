/**
 * S9.5-T5 — staging smoke for "RSVP form: coming-only + mandatory name"
 * (verification ladder rung 2). Synthetic data only, on a throwaway
 * "[SYNTH] S9.5-T5 smoke" event that cleanup deletes again. Prints ids,
 * statuses, counts and error codes — never tokens, keys or full phones
 * (phones are synthetic +629985505xxxx and shown as last 4 only).
 *
 * Phases:
 *
 *   seed     Service role. One [SYNTH] adhoc event + one scheduled instance
 *            (+10 days, 18:00 WIB) + one active RSVP link. The link is inserted
 *            directly (as the integration suites do), NOT via
 *            impl_getOrCreateRsvpLink, which writes an audit row we could not
 *            remove. Refuses if the event already exists or a smoke phone is
 *            already present in people / event_rsvps.
 *   submit   The REAL impl_submitRsvp with the cookie-less anon client —
 *            exactly the server action's path (Vault gate included):
 *              S1 no status + valid name        -> success, row status 'coming'
 *              S2 status 'maybe'                -> error form_outdated, 0 rows
 *              S3 status 'not_coming'           -> error form_outdated, 0 rows
 *              S4 blank name                    -> invalid name 'required', 0 rows
 *              S5 1-char name                   -> invalid name 'too_short', 0 rows
 *              S6 S1 phone re-submit, 2 children -> success, SAME row updated
 *              S7 S1 phone with 'maybe'         -> form_outdated, row untouched
 *            Abuse deps are stubbed (no IP, no Turnstile — the run sets
 *            RSVP_TURNSTILE_ENABLED=false); those paths are covered by the
 *            unit and integration suites and are unchanged by T5.
 *   totals   Service role inserts the legacy fixture (1 'maybe' + 1 child,
 *            1 'not_coming'), then impl_getInstanceRsvpPanel and
 *            impl_getInstanceRsvpExport + buildSummaryRows under the staging
 *            admin session (read-only; no audit). Asserts coming-only totals,
 *            legacy rows still listed, and no Maybe / Not coming summary line.
 *   cleanup  Deletes the smoke event (CASCADE: instance, link, RSVPs) and
 *            asserts zero residue.
 *
 * Run (tsc->node — never tsx; normalizePhone is on this path):
 *   npx tsc -p scripts/tsconfig.s9-5-t5-smoke.json
 *   mkdir -p scripts/.build/node_modules && ln -sfn .. scripts/.build/node_modules/@
 *   RSVP_PUBLIC_ENABLED=true RSVP_TURNSTILE_ENABLED=false node --conditions=react-server \
 *     --env-file=.env.staging.local scripts/.build/scripts/s9-5/t5-staging-smoke.js <phase>
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
import { normalizePhone } from '../../lib/utils/phone'
import type { RsvpFormState } from '../../lib/rsvp/public.types'
// Loaded lazily: the RSVP modules import 'server-only' (needs
// --conditions=react-server), same as t2-staging-smoke.
type RsvpPublicModule = typeof import('../../lib/rsvp/public.impl')
type RsvpAdminModule = typeof import('../../lib/rsvp/admin.impl')
type RsvpExportModule = typeof import('../../lib/rsvp/export')
type AnonModule = typeof import('../../lib/supabase/anon')

const STAGING_REF = 'sijfyvaodqkawbeuyrpu'
const TAG = '[s9-5-t5-smoke]'
const ADMIN_EMAIL = 'admin@example.com'
const EVENT_NAME = '[SYNTH] S9.5-T5 smoke'
const PHONE_PREFIX = '+629985505'                   // + 4 sequence digits
const phone = (seq: number) => `${PHONE_PREFIX}${String(seq).padStart(4, '0')}`
const local = (e164: string) => `0${e164.slice(3)}`   // +62… -> 0…
const last4 = (e164: string) => `…${e164.slice(-4)}`

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
    console.error('================== PREFLIGHT ABORT (s9-5-t5-staging-smoke) ==================')
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
  return anon
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
  if (!cond) failures++
}

/** The tsx/ESM normalizePhone trap (memory/feedback_collab.md, S4-T2): fail loudly, never silently. */
function assertPhoneUtilTrustworthy(): void {
  const r = normalizePhone('081808247576', 'ID')
  if (!r.ok || r.e164 !== '+6281808247576') abort('normalizePhone self-check failed — run via tsc->node, never tsx')
  const s = normalizePhone(local(phone(1)), 'ID')
  if (!s.ok || s.e164 !== phone(1)) abort('synthetic smoke phone does not normalize back to itself')
}

type Smoke = { eventId: string; instanceId: string; token: string }

async function findSmoke(service: SupabaseClient): Promise<Smoke | null> {
  const { data: ev, error } = await service.from('events').select('id').eq('name', EVENT_NAME)
  if (error) throw new Error(`events lookup failed: ${error.message}`)
  const events = (ev ?? []) as { id: string }[]
  if (events.length === 0) return null
  if (events.length > 1) abort(`expected at most 1 "${EVENT_NAME}" event, found ${events.length}`)
  const eventId = events[0].id
  const { data: inst, error: instErr } = await service.from('event_instances').select('id').eq('event_id', eventId)
  if (instErr) throw new Error(`instance lookup failed: ${instErr.message}`)
  const instances = (inst ?? []) as { id: string }[]
  if (instances.length !== 1) abort(`expected 1 smoke instance, found ${instances.length}`)
  const { data: link, error: linkErr } = await service
    .from('event_rsvp_links').select('token').eq('event_instance_id', instances[0].id).eq('is_active', true)
  if (linkErr) throw new Error(`link lookup failed: ${linkErr.message}`)
  const links = (link ?? []) as { token: string }[]
  if (links.length !== 1) abort(`expected 1 active smoke link, found ${links.length}`)
  return { eventId, instanceId: instances[0].id, token: links[0].token }
}

async function requireSmoke(service: SupabaseClient): Promise<Smoke> {
  const smoke = await findSmoke(service)
  if (!smoke) abort(`no "${EVENT_NAME}" event — run seed first`)
  console.log(`${TAG} smoke event=${smoke.eventId} instance=${smoke.instanceId} token=…${smoke.token.slice(-4)}`)
  return smoke
}

type RsvpRow = { id: string; phone_e164: string | null; name: string | null; status: string; children_count: number; updated_at: string }

async function rsvpRows(service: SupabaseClient, instanceId: string): Promise<RsvpRow[]> {
  const { data, error } = await service
    .from('event_rsvps')
    .select('id, phone_e164, name, status, children_count, updated_at')
    .eq('event_instance_id', instanceId)
    .order('created_at')
  if (error) throw new Error(`rsvps lookup failed: ${error.message}`)
  return (data ?? []) as RsvpRow[]
}

const fmtRow = (r: RsvpRow) =>
  `${r.id.slice(0, 8)} ${r.phone_e164 ? last4(r.phone_e164) : 'null'} name=${JSON.stringify(r.name)} ${r.status} children=${r.children_count}`

async function smokePhoneCounts(service: SupabaseClient): Promise<{ people: number; rsvps: number }> {
  const people = await service.from('people').select('id', { count: 'exact', head: true }).like('phone_e164', `${PHONE_PREFIX}%`)
  const rsvps = await service.from('event_rsvps').select('id', { count: 'exact', head: true }).like('phone_e164', `${PHONE_PREFIX}%`)
  if (people.error || rsvps.error) throw new Error(`smoke phone count failed: ${people.error?.message ?? rsvps.error?.message}`)
  return { people: people.count ?? 0, rsvps: rsvps.count ?? 0 }
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

async function phaseSeed(env: Env): Promise<void> {
  const service = serviceClient(env)
  if (await findSmoke(service)) abort(`"${EVENT_NAME}" already exists — run cleanup first`)
  const counts = await smokePhoneCounts(service)
  if (counts.people > 0 || counts.rsvps > 0) abort(`smoke phone range already in use (people=${counts.people} rsvps=${counts.rsvps})`)

  const { data: admin, error: adminErr } = await service.from('app_users').select('id').eq('email', ADMIN_EMAIL).single()
  if (adminErr) throw new Error(`admin lookup failed: ${adminErr.message}`)
  const adminId = (admin as { id: string }).id

  // 11:00Z = 18:00 WIB, 10 days out — inside the RSVP window.
  const day = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10)
  const scheduledAt = `${day}T11:00:00Z`
  const { data: ev, error: evErr } = await service
    .from('events')
    .insert({
      name: EVENT_NAME, name_id: EVENT_NAME, event_type: 'adhoc', start_date: day, start_time: '18:00:00',
      duration_min: 120, location: '[SYNTH] Smoke Hall', active: true, created_by: adminId,
    })
    .select('id').single()
  if (evErr || !ev) throw new Error(`insert event failed: ${evErr?.message}`)
  const eventId = (ev as { id: string }).id
  const { data: inst, error: instErr } = await service
    .from('event_instances')
    .insert({ event_id: eventId, scheduled_at: scheduledAt, event_name_snapshot: EVENT_NAME, event_name_snapshot_id: EVENT_NAME, status: 'scheduled' })
    .select('id').single()
  if (instErr || !inst) throw new Error(`insert instance failed: ${instErr?.message}`)
  const instanceId = (inst as { id: string }).id
  const { error: linkErr } = await service
    .from('event_rsvp_links').insert({ event_instance_id: instanceId, is_active: true, created_by: adminId })
  if (linkErr) throw new Error(`insert link failed: ${linkErr.message}`)

  const smoke = await requireSmoke(service)
  check('seed: event + instance + active link', smoke.instanceId === instanceId, `scheduled_at=${scheduledAt}`)
}

async function phaseSubmit(env: Env): Promise<void> {
  assertPhoneUtilTrustworthy()
  const service = serviceClient(env)
  const smoke = await requireSmoke(service)
  const { impl_submitRsvp } = (await import('../../lib/rsvp/public.impl')) as RsvpPublicModule
  const { createAnonServerClient } = (await import('../../lib/supabase/anon')) as AnonModule
  const deps = {
    verifyTurnstile: async () => 'ok' as const,
    throttle: () => true,
    getClientIp: async () => null,
  }
  const submit = (fields: Record<string, string>): Promise<RsvpFormState> => {
    const fd = new FormData()
    for (const [k, v] of Object.entries(fields)) fd.set(k, v)
    return impl_submitRsvp(smoke.token, fd, createAnonServerClient(), deps)
  }
  const show = (s: RsvpFormState) => JSON.stringify(s)
  if ((await rsvpRows(service, smoke.instanceId)).length !== 0) abort('smoke instance already has RSVP rows — run cleanup + seed')

  const p1 = phone(1)
  const s1 = await submit({ phone: local(p1), name: '[SYNTH] T5 Satu' })
  let rows = await rsvpRows(service, smoke.instanceId)
  check('S1 no status + name -> success', s1.kind === 'success' && s1.status === 'coming', show(s1))
  check('S1 one row, status coming', rows.length === 1 && rows[0].status === 'coming' && rows[0].phone_e164 === p1, rows.map(fmtRow).join(' | '))
  const first = rows[0]

  for (const [label, status, seq] of [['S2', 'maybe', 2], ['S3', 'not_coming', 3]] as const) {
    const s = await submit({ status, phone: local(phone(seq)), name: '[SYNTH] T5 Stale' })
    rows = await rsvpRows(service, smoke.instanceId)
    check(`${label} status '${status}' -> form_outdated`, s.kind === 'error' && s.reason === 'form_outdated', show(s))
    check(`${label} no row written`, rows.length === 1 && !rows.some(r => r.phone_e164 === phone(seq)), `rows=${rows.length}`)
  }

  for (const [label, name, code, seq] of [['S4', '   ', 'required', 4], ['S5', 'B', 'too_short', 5]] as const) {
    const s = await submit({ phone: local(phone(seq)), name })
    rows = await rsvpRows(service, smoke.instanceId)
    check(`${label} name ${JSON.stringify(name)} -> invalid ${code}`, s.kind === 'invalid' && s.fieldErrors.name === code, show(s))
    check(`${label} no row written`, rows.length === 1, `rows=${rows.length}`)
  }

  const s6 = await submit({ phone: `+62 ${p1.slice(3)}`, name: '[SYNTH] T5 Satu', bringing_children: 'yes', children_count: '2' })
  rows = await rsvpRows(service, smoke.instanceId)
  check('S6 re-submit -> success, children 2', s6.kind === 'success' && s6.children === 2, show(s6))
  check('S6 same row updated', rows.length === 1 && rows[0].id === first.id && rows[0].children_count === 2 && rows[0].updated_at !== first.updated_at, rows.map(fmtRow).join(' | '))

  const s7 = await submit({ status: 'maybe', phone: local(p1), name: '[SYNTH] T5 Satu' })
  const after = await rsvpRows(service, smoke.instanceId)
  check("S7 existing phone + 'maybe' -> form_outdated", s7.kind === 'error' && s7.reason === 'form_outdated', show(s7))
  check('S7 stored row untouched', JSON.stringify(after) === JSON.stringify(rows), after.map(fmtRow).join(' | '))
}

async function phaseTotals(env: Env): Promise<void> {
  const service = serviceClient(env)
  const smoke = await requireSmoke(service)
  const before = await rsvpRows(service, smoke.instanceId)
  if (before.length !== 1 || before[0].status !== 'coming' || before[0].children_count !== 2) {
    abort(`expected exactly the S6 row (coming, 2 children) — found ${before.map(fmtRow).join(' | ') || 'none'}`)
  }
  const { data: link, error: linkErr } = await service.from('event_rsvp_links').select('id').eq('token', smoke.token).single()
  if (linkErr) throw new Error(`link lookup failed: ${linkErr.message}`)
  const linkId = (link as { id: string }).id
  // Legacy fixture — rows the pre-T5 form could write.
  const { error } = await service.from('event_rsvps').insert([
    { event_instance_id: smoke.instanceId, link_id: linkId, phone_e164: phone(8), name: '[SYNTH] T5 Legacy Maybe', status: 'maybe', children_count: 1 },
    { event_instance_id: smoke.instanceId, link_id: linkId, phone_e164: phone(9), name: '[SYNTH] T5 Legacy Not', status: 'not_coming', children_count: 0 },
  ])
  if (error) throw new Error(`legacy fixture insert failed: ${error.message}`)
  for (const r of await rsvpRows(service, smoke.instanceId)) console.log(`${TAG} row ${fmtRow(r)}`)

  const admin = await adminSession(env, service)
  const { impl_getInstanceRsvpPanel, impl_getInstanceRsvpExport } = (await import('../../lib/rsvp/admin.impl')) as RsvpAdminModule
  const { buildSummaryRows, mapRsvpToExportRow } = (await import('../../lib/rsvp/export')) as RsvpExportModule

  const panel = await impl_getInstanceRsvpPanel(smoke.instanceId, admin)
  if (panel.status !== 'ok') abort(`panel: ${JSON.stringify(panel)}`)
  const { totals, rows, buckets, children } = panel.panel
  console.log(`${TAG} panel.totals ${JSON.stringify(totals)}`)
  console.log(`${TAG} panel.buckets ${JSON.stringify(buckets)} children ${JSON.stringify(children)}`)
  check('totals: coming-only figures', JSON.stringify(totals) === JSON.stringify({ responses: 3, coming_people: 1, coming_headcount: 3, coming_children: 2 }))
  check('totals: no maybe / not_coming keys', !Object.keys(totals).some(k => /maybe|not_coming/.test(k)), Object.keys(totals).join(','))
  check('children expected = coming children only (2)', children.expected === 2)
  check('legacy rows still listed (3 rows; statuses coming/maybe/not_coming)',
    rows.length === 3 && ['coming', 'maybe', 'not_coming'].every(s => rows.some(r => r.status === s)), rows.map(r => r.status).join(','))

  const exp = await impl_getInstanceRsvpExport(smoke.instanceId, admin)
  if (exp.status !== 'ok') abort(`export: ${JSON.stringify(exp)}`)
  const summary = buildSummaryRows(exp.totals, exp.buckets, exp.children)
  for (const s of summary) console.log(`${TAG} summary ${s.Metric} = ${s.Value}`)
  check('export summary: no Maybe / Not coming line', !summary.some(s => /maybe|not coming/i.test(s.Metric)))
  check('export summary: Expected headcount (food) = 3', summary.find(s => s.Metric === 'Expected headcount (food)')?.Value === 3)
  const statuses = exp.rows.map(r => mapRsvpToExportRow(r).Status).sort()
  check('export Status column keeps legacy labels', JSON.stringify(statuses) === JSON.stringify(['Coming', 'Maybe', 'Not coming']), statuses.join(','))
}

async function phaseCleanup(env: Env): Promise<void> {
  const service = serviceClient(env)
  const smoke = await findSmoke(service)
  if (smoke) {
    const { error } = await service.from('events').delete().eq('id', smoke.eventId)
    if (error) throw new Error(`delete smoke event failed: ${error.message}`)
    console.log(`${TAG} deleted event ${smoke.eventId} (CASCADE instance ${smoke.instanceId}, link, RSVPs)`)
  } else {
    console.log(`${TAG} no smoke event present`)
  }
  // Zero-residue assertion.
  const events = await service.from('events').select('id', { count: 'exact', head: true }).eq('name', EVENT_NAME)
  const instances = await service.from('event_instances').select('id', { count: 'exact', head: true }).eq('event_name_snapshot', EVENT_NAME)
  if (events.error || instances.error) throw new Error('residue count failed')
  const counts = await smokePhoneCounts(service)
  let links = 0
  let audits = 0
  if (smoke) {
    const l = await service.from('event_rsvp_links').select('id', { count: 'exact', head: true }).eq('event_instance_id', smoke.instanceId)
    const a = await service.from('audit_log').select('id', { count: 'exact', head: true }).in('entity_id', [smoke.eventId, smoke.instanceId])
    if (l.error || a.error) throw new Error('residue count failed')
    links = l.count ?? 0
    audits = a.count ?? 0
  }
  const residue = { events: events.count ?? 0, instances: instances.count ?? 0, links, rsvps: counts.rsvps, people: counts.people, audit_rows: audits }
  console.log(`${TAG} residue ${JSON.stringify(residue)}`)
  check('zero residue', Object.values(residue).every(n => n === 0))
}

async function main(): Promise<void> {
  const phase = process.argv[2]
  const phases: Record<string, (env: Env) => Promise<void>> = {
    seed: phaseSeed,
    submit: phaseSubmit,
    totals: phaseTotals,
    cleanup: phaseCleanup,
  }
  const run = phase ? phases[phase] : undefined
  if (!run) abort(`usage: t5-staging-smoke.js <${Object.keys(phases).join('|')}>`)
  const env = await pinStaging(`s9-5-t5-smoke-${phase}`)
  await run(env)
  console.log(failures === 0 ? `${TAG} ${phase}: ALL PASS` : `${TAG} ${phase}: ${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(err => {
  console.error(`${TAG} ERROR: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
