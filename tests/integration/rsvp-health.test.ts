// Integration tests for the S9-R6 A2 admin RSVP health check
// (lib/rsvp/health.ts + lib/rsvp/health.impl.ts) against local Docker:
//   - the gate probe through the real anon submit_rsvp RPC: correct gate ->
//     'match', wrong gate -> 'mismatch', and event_rsvps gains no row either way;
//   - authz of the server action: anonymous and organizer sessions are
//     rejected, an admin session gets the result.
// Prerequisite: supabase db reset (R0 migration + seed.sql's local rsvp_gate
// vault secret, whose literal this suite sets as RSVP_GATE_SECRET).
// Turnstile keys are cleared for the whole suite: secret -> 'skipped', so
// Cloudflare is never contacted.
// Run: npm test -- rsvp-health

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomUUID } from 'crypto'

vi.mock('server-only', () => ({}))

// The server action's cookie-backed client is swapped for whichever session the
// test is exercising.
let currentSession: SupabaseClient | null = null
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    if (!currentSession) throw new Error('test did not set currentSession')
    return currentSession
  },
}))

import { impl_runRsvpHealthCheck } from '@/lib/rsvp/health.impl'
import { runRsvpHealthCheck } from '@/lib/rsvp/health'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !anonKey || !serviceKey) {
  throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY')
}

const { hostname } = new URL(url)
if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
  throw new Error(
    `[rsvp-health.test.ts] NEXT_PUBLIC_SUPABASE_URL (${hostname}) is not local Docker. This suite ` +
      `uses the seed.sql gate literal — local Docker only.`,
  )
}

// Same literal as supabase/seed.sql — local-only placeholder, not a secret.
const LOCAL_GATE = 'local-dev-only-rsvp-gate-not-a-secret'
// Seeded baseline admin (supabase/seed.sql) — app_users FK target for created_by.
const BASELINE_ADMIN_ID = '00000000-0000-0000-0000-000000000001'

const MANAGED_ENV = [
  'RSVP_GATE_SECRET',
  'RSVP_TURNSTILE_ENABLED',
  'RSVP_TURNSTILE_SITE_KEY',
  'RSVP_TURNSTILE_SECRET_KEY',
] as const
const ORIGINAL_ENV = MANAGED_ENV.map((k) => process.env[k])

function setEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

let svc: SupabaseClient
let anonSession: SupabaseClient
let adminSession: SupabaseClient
let organizerSession: SupabaseClient
const authUserIds: string[] = []
let eventId = ''

async function createAppUserSession(label: string, role: 'admin' | 'organizer'): Promise<SupabaseClient> {
  const email = `a2-${label}-${randomUUID()}@example.com`
  const pass = `A2-${label}-${Date.now()}!`
  const { data: authData, error: authErr } = await svc.auth.admin.createUser({
    email, password: pass, email_confirm: true,
  })
  if (authErr || !authData.user) throw new Error(`createUser (${label}): ${authErr?.message}`)
  authUserIds.push(authData.user.id)

  const { error: appErr } = await svc
    .from('app_users')
    .insert({ id: authData.user.id, email, full_name: `[SYNTH] A2 ${label}`, role, active: true })
  if (appErr) throw new Error(`insert app_user (${label}): ${appErr.message}`)

  const session = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { error: signInErr } = await session.auth.signInWithPassword({ email, password: pass })
  if (signInErr) throw new Error(`sign-in (${label}): ${signInErr.message}`)
  return session
}

async function rsvpCount(): Promise<number> {
  const { count, error } = await svc.from('event_rsvps').select('id', { count: 'exact', head: true })
  if (error || count === null) throw new Error(`count event_rsvps: ${error?.message}`)
  return count
}

beforeAll(async () => {
  svc = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
  anonSession = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  adminSession = await createAppUserSession('admin', 'admin')
  organizerSession = await createAppUserSession('organizer', 'organizer')

  setEnv('RSVP_TURNSTILE_ENABLED', undefined)
  setEnv('RSVP_TURNSTILE_SITE_KEY', undefined)
  setEnv('RSVP_TURNSTILE_SECRET_KEY', undefined)

  // A live, open link with an existing RSVP, so the probe runs against a
  // non-empty link table and a non-zero event_rsvps count.
  const scheduledAt = `${new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10)}T11:00:00Z`
  const name = `[SYNTH] A2 Health ${randomUUID().slice(0, 8)}`
  const { data: ev, error: evErr } = await svc.from('events').insert({
    name, name_id: name, event_type: 'adhoc', start_date: scheduledAt.slice(0, 10),
    start_time: '18:00:00', duration_min: 120, location: 'A2 Test Hall', active: true,
    created_by: BASELINE_ADMIN_ID,
  }).select('id').single()
  if (evErr || !ev) throw new Error(`insert event: ${evErr?.message}`)
  eventId = (ev as { id: string }).id

  const { data: inst, error: instErr } = await svc.from('event_instances').insert({
    event_id: eventId, scheduled_at: scheduledAt, event_name_snapshot: name,
    event_name_snapshot_id: name, status: 'scheduled',
  }).select('id').single()
  if (instErr || !inst) throw new Error(`insert instance: ${instErr?.message}`)
  const instanceId = (inst as { id: string }).id

  const { data: link, error: linkErr } = await svc.from('event_rsvp_links').insert({
    event_instance_id: instanceId, is_active: true, created_by: BASELINE_ADMIN_ID,
  }).select('id').single()
  if (linkErr || !link) throw new Error(`insert link: ${linkErr?.message}`)

  const { error: rsvpErr } = await svc.from('event_rsvps').insert({
    event_instance_id: instanceId, link_id: (link as { id: string }).id,
    phone_e164: '+6299900938001', name: '[SYNTH] A2 Newcomer', children_count: 0,
    followup_consent: false, status: 'coming',
  })
  if (rsvpErr) throw new Error(`insert rsvp: ${rsvpErr.message}`)
}, 60_000)

afterAll(async () => {
  MANAGED_ENV.forEach((k, i) => setEnv(k, ORIGINAL_ENV[i]))
  if (!svc) return
  // events → event_instances (CASCADE) → event_rsvp_links + event_rsvps (CASCADE)
  if (eventId) await svc.from('events').delete().eq('id', eventId)
  if (authUserIds.length > 0) {
    await svc.from('audit_log').delete().in('actor_user_id', authUserIds)
    await svc.from('app_users').delete().in('id', authUserIds)
    for (const id of authUserIds) await svc.auth.admin.deleteUser(id)
  }
}, 60_000)

describe('gate probe — real submit_rsvp via the anon client', () => {
  it('correct gate -> match; wrong gate -> mismatch; event_rsvps row count unchanged', async () => {
    const before = await rsvpCount()
    expect(before).toBeGreaterThan(0)

    setEnv('RSVP_GATE_SECRET', LOCAL_GATE)
    const ok = await impl_runRsvpHealthCheck()
    expect(ok.gate).toBe('match')
    expect(ok.turnstile).toEqual({ enabled: false, keys: 'missing', secret: 'skipped' })

    setEnv('RSVP_GATE_SECRET', `wrong-${randomUUID()}`)
    const bad = await impl_runRsvpHealthCheck()
    expect(bad.gate).toBe('mismatch')

    const after = await rsvpCount()
    expect(after).toBe(before)
  })

  it('missing env -> missing-env', async () => {
    setEnv('RSVP_GATE_SECRET', undefined)
    expect((await impl_runRsvpHealthCheck()).gate).toBe('missing-env')
  })
})

describe('runRsvpHealthCheck — authz', () => {
  it('anonymous -> not_authorized', async () => {
    setEnv('RSVP_GATE_SECRET', LOCAL_GATE)
    currentSession = anonSession
    expect(await runRsvpHealthCheck()).toEqual({ status: 'not_authorized' })
  })

  it('organizer -> not_authorized', async () => {
    setEnv('RSVP_GATE_SECRET', LOCAL_GATE)
    currentSession = organizerSession
    expect(await runRsvpHealthCheck()).toEqual({ status: 'not_authorized' })
  })

  it('admin -> result', async () => {
    setEnv('RSVP_GATE_SECRET', LOCAL_GATE)
    currentSession = adminSession
    const res = await runRsvpHealthCheck()
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    expect(res.result.gate).toBe('match')
    expect(Object.keys(res.result).sort()).toEqual(['checkedAt', 'environment', 'gate', 'publicEnabled', 'turnstile'])
  })
})
