// Integration tests for Sprint 9 R2 — member match / newcomer behaviour of the
// public RSVP path (submit_rsvp, 20261020120000_sprint9_r0_rsvp.sql) driven
// end-to-end through impl_submitRsvp + createAnonServerClient(), the same
// path the server action uses, and read back through the R3 admin panel
// derivation (impl_getInstanceRsvpPanel) with a REAL admin session.
// Verify-only: no app code or migration is exercised beyond what R0/R1/R3/R4
// shipped. Runs against local Docker Supabase only (.env.test.local).
// Prerequisite: supabase db reset (R0 migration + seed.sql's local rsvp_gate
// vault secret, whose literal this suite sets as RSVP_GATE_SECRET).
// Run: npm test -- rsvp-match
//
// Synthetic phones: +62998 + 4 run digits + 4 sequence digits (13 digits after
// '+', accepted by libphonenumber for ID) — a range no other suite uses, so
// parallel suites can't collide on people.phone_e164 UNIQUE. The overseas case
// uses ACMA's fictitious mobile 0491 570 156 (+61491570156), pre-cleaned in
// beforeAll in case an earlier run crashed before afterAll.
//
//   G1  newcomer -> later on roster -> resubmit links the person, name NULL
//   G2  member -> later soft-deleted -> resubmit (PINNED current behaviour, D1)
//   G3  the public path never updates people (full-row snapshot)
//   G4  resubmit keeps row identity; link rotation re-points link_id
//   G5  phone input variants land on one row
//   G6  overseas +61 stays international and matches the roster
//   G7  admin panel display name: roster / typed / null

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { randomUUID } from 'crypto'

vi.mock('server-only', () => ({}))

import { createAnonServerClient } from '@/lib/supabase/anon'
import { impl_submitRsvp, type RsvpSubmitDeps } from '@/lib/rsvp/public.impl'
import type { RsvpFormState } from '@/lib/rsvp/public.types'
import {
  impl_deactivateRsvpLink,
  impl_getInstanceRsvpPanel,
  impl_getOrCreateRsvpLink,
} from '@/lib/rsvp/admin.impl'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !anonKey || !serviceRoleKey) {
  throw new Error(
    'Missing env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY',
  )
}

const { hostname } = new URL(url)
if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
  throw new Error(
    `[rsvp-match.test.ts] NEXT_PUBLIC_SUPABASE_URL (${hostname}) is not local Docker. This suite ` +
      `creates/deletes auth users, people and RSVP rows — must run against local Docker only.`,
  )
}

// Same literal as supabase/seed.sql — local-only placeholder, not a secret.
const LOCAL_GATE = 'local-dev-only-rsvp-gate-not-a-secret'
// Seeded baseline admin (supabase/seed.sql) — app_users FK target for created_by.
const BASELINE_ADMIN_ID = '00000000-0000-0000-0000-000000000001'
const APP_URL = 'http://localhost:3000'
const ROSTER_PREFIX = '[SYNTH] R2 Roster'
const AU_PHONE = '+61491570156'

let svc: SupabaseClient
let adminSession: SupabaseClient

const ts = Date.now()
let phoneSeq = 0
const nextPhone = () => {
  if (phoneSeq > 9999) throw new Error('nextPhone: sequence exhausted (4 digits)')
  return `+62998${(ts % 10_000).toString().padStart(4, '0')}${String(phoneSeq++).padStart(4, '0')}`
}
// What a visitor types: local format with a leading 0.
const localFormat = (e164: string) => `0${e164.slice(3)}`

const eventIds: string[] = []
const personIds: string[] = []
const authUserIds: string[] = []

const ENV_KEYS = [
  'RSVP_PUBLIC_ENABLED',
  'RSVP_GATE_SECRET',
  'NEXT_PUBLIC_APP_URL',
  'RSVP_TURNSTILE_ENABLED',
  'RSVP_TURNSTILE_SITE_KEY',
  'RSVP_TURNSTILE_SECRET_KEY',
] as const
const ORIGINAL_ENV = ENV_KEYS.map((k) => process.env[k])

// Injected S9-R4 deps: no client IP -> throttle skipped; Turnstile toggle off.
const NO_ABUSE_DEPS: RsvpSubmitDeps = {
  verifyTurnstile: async () => 'fail',
  throttle: () => true,
  getClientIp: async () => null,
}

function setEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

async function createInstance(): Promise<string> {
  // 11:00Z = 18:00 WIB; 5 days out keeps the RSVP window open.
  const scheduledAt = `${new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10)}T11:00:00Z`
  const name = `[SYNTH] R2 Match ${randomUUID().slice(0, 8)}`
  const { data: ev, error: evErr } = await svc
    .from('events')
    .insert({
      name,
      name_id: `${name} (ID)`,
      event_type: 'adhoc',
      start_date: scheduledAt.slice(0, 10),
      start_time: '18:00:00',
      duration_min: 120,
      location: 'RSVP Test Hall',
      active: true,
      created_by: BASELINE_ADMIN_ID,
    })
    .select('id')
    .single()
  if (evErr || !ev) throw new Error(`insert event: ${evErr?.message}`)
  eventIds.push((ev as { id: string }).id)

  const { data: inst, error: instErr } = await svc
    .from('event_instances')
    .insert({
      event_id: (ev as { id: string }).id,
      scheduled_at: scheduledAt,
      event_name_snapshot: name,
      event_name_snapshot_id: `${name} (ID)`,
      status: 'scheduled',
    })
    .select('id')
    .single()
  if (instErr || !inst) throw new Error(`insert instance: ${instErr?.message}`)
  return (inst as { id: string }).id
}

async function createLink(instanceId: string): Promise<{ linkId: string; token: string }> {
  const { data, error } = await svc
    .from('event_rsvp_links')
    .insert({ event_instance_id: instanceId, created_by: BASELINE_ADMIN_ID })
    .select('id, token')
    .single()
  if (error || !data) throw new Error(`insert link: ${error?.message}`)
  const row = data as { id: string; token: string }
  return { linkId: row.id, token: row.token }
}

async function createPerson(phone: string, label: string): Promise<string> {
  const { data, error } = await svc
    .from('people')
    .insert({ phone_e164: phone, full_name: `${ROSTER_PREFIX} ${label}`, nickname: label })
    .select('id')
    .single()
  if (error || !data) throw new Error(`insert person: ${error?.message}`)
  personIds.push((data as { id: string }).id)
  return (data as { id: string }).id
}

async function softDeletePerson(personId: string): Promise<void> {
  const { error } = await svc.from('people').update({ deleted_at: new Date().toISOString() }).eq('id', personId)
  if (error) throw new Error(`soft-delete person: ${error.message}`)
}

async function personSnapshot(personId: string): Promise<Record<string, unknown>> {
  const { data, error } = await svc.from('people').select('*').eq('id', personId).single()
  if (error || !data) throw new Error(`select person: ${error?.message}`)
  return data as Record<string, unknown>
}

type RsvpRow = {
  id: string
  phone_e164: string
  name: string | null
  person_id: string | null
  status: string
  children_count: number
  followup_consent: boolean
  link_id: string
  created_at: string
  updated_at: string
}

async function rsvpRows(instanceId: string): Promise<RsvpRow[]> {
  const { data, error } = await svc
    .from('event_rsvps')
    .select('id, phone_e164, name, person_id, status, children_count, followup_consent, link_id, created_at, updated_at')
    .eq('event_instance_id', instanceId)
    .order('created_at')
  if (error) throw new Error(`select rsvps: ${error.message}`)
  return data as RsvpRow[]
}

async function onlyRow(instanceId: string): Promise<RsvpRow> {
  const rows = await rsvpRows(instanceId)
  expect(rows).toHaveLength(1)
  return rows[0]!
}

async function peopleWithPhone(phone: string): Promise<number> {
  const { count, error } = await svc
    .from('people')
    .select('id', { count: 'exact', head: true })
    .eq('phone_e164', phone)
  if (error || count === null) throw new Error(`count people: ${error?.message}`)
  return count
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  return fd
}

async function submit(token: string, fields: Record<string, string>): Promise<RsvpFormState> {
  const state = await impl_submitRsvp(token, form(fields), createAnonServerClient(), NO_ABUSE_DEPS)
  expect(state.kind).toBe('success')
  return state
}

// Distinct transactions already get distinct now(); the pause keeps the
// updated_at comparison from depending on clock resolution.
const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

beforeAll(async () => {
  svc = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })

  // Leftover from a crashed run: the fixed AU roster person and its RSVPs.
  const { data: stale, error: staleErr } = await svc
    .from('people')
    .select('id, full_name')
    .eq('phone_e164', AU_PHONE)
  if (staleErr) throw new Error(`stale AU lookup: ${staleErr.message}`)
  for (const p of (stale ?? []) as Array<{ id: string; full_name: string }>) {
    if (!p.full_name.startsWith(ROSTER_PREFIX)) throw new Error(`${AU_PHONE} is held by a non-R2 person — refusing`)
    await svc.from('event_rsvps').delete().eq('person_id', p.id)
    await svc.from('people').delete().eq('id', p.id)
  }

  const email = `r2-admin-${randomUUID()}@example.com`
  const pass = `R2-admin-${Date.now()}!`
  const { data: authData, error: authErr } = await svc.auth.admin.createUser({
    email, password: pass, email_confirm: true,
  })
  if (authErr || !authData.user) throw new Error(`createUser: ${authErr?.message}`)
  authUserIds.push(authData.user.id)
  const { error: appErr } = await svc
    .from('app_users')
    .insert({ id: authData.user.id, email, full_name: '[SYNTH] R2 admin', role: 'admin', active: true })
  if (appErr) throw new Error(`insert app_user: ${appErr.message}`)
  adminSession = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { error: signInErr } = await adminSession.auth.signInWithPassword({ email, password: pass })
  if (signInErr) throw new Error(`sign-in: ${signInErr.message}`)
})

beforeEach(() => {
  setEnv('RSVP_PUBLIC_ENABLED', 'true')
  setEnv('RSVP_GATE_SECRET', LOCAL_GATE)
  setEnv('NEXT_PUBLIC_APP_URL', APP_URL)
  setEnv('RSVP_TURNSTILE_ENABLED', undefined)
  setEnv('RSVP_TURNSTILE_SITE_KEY', undefined)
  setEnv('RSVP_TURNSTILE_SECRET_KEY', undefined)
})

afterEach(() => {
  ENV_KEYS.forEach((k, i) => setEnv(k, ORIGINAL_ENV[i]))
})

afterAll(async () => {
  if (!svc) return
  // events → event_instances (CASCADE) → event_rsvp_links + event_rsvps (CASCADE);
  // RSVPs are gone before people (event_rsvps.person_id is NO ACTION).
  if (eventIds.length > 0) await svc.from('events').delete().in('id', eventIds)
  if (personIds.length > 0) await svc.from('people').delete().in('id', personIds)
  if (authUserIds.length > 0) {
    await svc.from('audit_log').delete().in('actor_user_id', authUserIds)
    await svc.from('app_users').delete().in('id', authUserIds)
    for (const id of authUserIds) await svc.auth.admin.deleteUser(id)
  }
}, 60_000)

// ---------------------------------------------------------------------------
// G1 newcomer -> roster -> resubmit
// ---------------------------------------------------------------------------

describe('G1 newcomer later added to the roster', () => {
  it('resubmit links the same row to the new person and drops the typed name', async () => {
    const instanceId = await createInstance()
    const { token } = await createLink(instanceId)
    const phone = nextPhone()

    await submit(token, { status: 'maybe', phone: localFormat(phone), name: '[SYNTH] Newcomer Nia' })
    const before = await onlyRow(instanceId)
    expect(before).toMatchObject({ person_id: null, name: '[SYNTH] Newcomer Nia', status: 'maybe' })
    expect(await peopleWithPhone(phone)).toBe(0)

    const personId = await createPerson(phone, 'G1')
    await submit(token, { status: 'coming', phone: localFormat(phone), name: '[SYNTH] Newcomer Nia' })

    const after = await onlyRow(instanceId)
    expect(after.id).toBe(before.id)
    expect(after).toMatchObject({ person_id: personId, name: null, status: 'coming' })
    expect(await peopleWithPhone(phone)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// G2 member -> soft-deleted -> resubmit (D1: pinned current behaviour)
// ---------------------------------------------------------------------------

describe('G2 member soft-deleted after RSVP, then resubmits', () => {
  it('pinned: typed name -> person_id NULL, name = typed name (same row)', async () => {
    const instanceId = await createInstance()
    const { token } = await createLink(instanceId)
    const phone = nextPhone()
    const personId = await createPerson(phone, 'G2a')

    await submit(token, { status: 'coming', phone: localFormat(phone), name: '[SYNTH] First Typed' })
    const before = await onlyRow(instanceId)
    expect(before).toMatchObject({ person_id: personId, name: null })

    await softDeletePerson(personId)
    await submit(token, { status: 'maybe', phone: localFormat(phone), name: '[SYNTH] Second Typed' })

    const after = await onlyRow(instanceId)
    expect(after.id).toBe(before.id)
    expect(after).toMatchObject({ person_id: null, name: '[SYNTH] Second Typed', status: 'maybe' })
  })

  it('pinned: blank name -> person_id NULL, name NULL (same row)', async () => {
    const instanceId = await createInstance()
    const { token } = await createLink(instanceId)
    const phone = nextPhone()
    const personId = await createPerson(phone, 'G2b')

    await submit(token, { status: 'coming', phone: localFormat(phone), name: '[SYNTH] First Typed' })
    const before = await onlyRow(instanceId)
    expect(before).toMatchObject({ person_id: personId, name: null })

    await softDeletePerson(personId)
    await submit(token, { status: 'not_coming', phone: localFormat(phone), name: '   ' })

    const after = await onlyRow(instanceId)
    expect(after.id).toBe(before.id)
    expect(after).toMatchObject({ person_id: null, name: null, status: 'not_coming' })
  })
})

// ---------------------------------------------------------------------------
// G3 people never updated
// ---------------------------------------------------------------------------

describe('G3 the public path never updates people', () => {
  it('member people row deep-equals its snapshot after submit and resubmit (consent on)', async () => {
    const instanceId = await createInstance()
    const { token } = await createLink(instanceId)
    const phone = nextPhone()
    const personId = await createPerson(phone, 'G3')
    const snapshot = await personSnapshot(personId)

    await submit(token, {
      status: 'coming',
      phone: localFormat(phone),
      name: '[SYNTH] Not The Roster Name',
      bringing_children: 'yes',
      children_count: '2',
      followup_consent: 'on',
    })
    expect(await personSnapshot(personId)).toEqual(snapshot)

    await tick()
    await submit(token, { status: 'maybe', phone, name: '[SYNTH] Another Name', followup_consent: 'on' })
    expect(await personSnapshot(personId)).toEqual(snapshot)

    expect(await onlyRow(instanceId)).toMatchObject({ person_id: personId, name: null, followup_consent: true })
    expect(await peopleWithPhone(phone)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// G4 resubmit row identity + link rotation
// ---------------------------------------------------------------------------

describe('G4 resubmit row identity', () => {
  it('same id, created_at unchanged, updated_at advanced; fields updated', async () => {
    const instanceId = await createInstance()
    const { token } = await createLink(instanceId)
    const phone = nextPhone()

    await submit(token, {
      status: 'coming',
      phone: localFormat(phone),
      name: '[SYNTH] Repeat Rudi',
      bringing_children: 'yes',
      children_count: '3',
      followup_consent: 'on',
    })
    const first = await onlyRow(instanceId)
    expect(first.created_at).toBe(first.updated_at)

    await tick()
    await submit(token, { status: 'not_coming', phone: localFormat(phone) })
    const second = await onlyRow(instanceId)

    expect(second.id).toBe(first.id)
    expect(second.created_at).toBe(first.created_at)
    expect(Date.parse(second.updated_at)).toBeGreaterThan(Date.parse(first.updated_at))
    expect(second).toMatchObject({
      name: '[SYNTH] Repeat Rudi',
      status: 'not_coming',
      children_count: 0,
      followup_consent: false,
    })
  })

  it('after an R3 link rotation, resubmit via the new link re-points link_id on the same row', async () => {
    const instanceId = await createInstance()
    const created = await impl_getOrCreateRsvpLink(instanceId, adminSession)
    if (created.status !== 'ok') throw new Error(`getOrCreate: ${created.status}`)
    const oldLinkId = created.linkId
    const oldToken = new URL(created.url).pathname.split('/').pop()!
    const phone = nextPhone()

    await submit(oldToken, { status: 'coming', phone: localFormat(phone), name: '[SYNTH] Rotator' })
    const first = await onlyRow(instanceId)
    expect(first.link_id).toBe(oldLinkId)

    expect(await impl_deactivateRsvpLink(instanceId, adminSession)).toEqual({ status: 'ok', linkId: oldLinkId })
    const rotated = await impl_getOrCreateRsvpLink(instanceId, adminSession)
    if (rotated.status !== 'ok') throw new Error(`rotate: ${rotated.status}`)
    expect(rotated.created).toBe(true)
    expect(rotated.linkId).not.toBe(oldLinkId)
    const newToken = new URL(rotated.url).pathname.split('/').pop()!

    // The old token is closed; nothing changes on the row.
    const closed = await impl_submitRsvp(
      oldToken,
      form({ status: 'maybe', phone: localFormat(phone) }),
      createAnonServerClient(),
      NO_ABUSE_DEPS,
    )
    expect(closed.kind).toBe('closed')
    expect(await onlyRow(instanceId)).toEqual(first)

    await tick()
    await submit(newToken, { status: 'maybe', phone: localFormat(phone) })
    const second = await onlyRow(instanceId)
    expect(second.id).toBe(first.id)
    expect(second.created_at).toBe(first.created_at)
    expect(second).toMatchObject({ link_id: rotated.linkId, status: 'maybe', name: '[SYNTH] Rotator' })
  })
})

// ---------------------------------------------------------------------------
// G5 input variants
// ---------------------------------------------------------------------------

describe('G5 phone input variants', () => {
  it('0812…, +62 812…, 62812…, 812…, 0812-…-… all land on one row', async () => {
    const instanceId = await createInstance()
    const { token } = await createLink(instanceId)
    const phone = nextPhone()               // +62998RRRRSSSS
    const national = phone.slice(3)         // 998RRRRSSSS
    const variants = [
      `0${national}`,
      `+62 ${national.slice(0, 3)} ${national.slice(3, 7)} ${national.slice(7)}`,
      `62${national}`,
      national,
      `0${national.slice(0, 3)}-${national.slice(3, 7)}-${national.slice(7)}`,
    ]
    const statuses = ['coming', 'maybe', 'not_coming', 'maybe', 'coming'] as const

    for (const [i, variant] of variants.entries()) {
      await submit(token, { status: statuses[i]!, phone: variant, name: '[SYNTH] Variant Vera' })
      const row = await onlyRow(instanceId)
      expect(row).toMatchObject({ phone_e164: phone, status: statuses[i] })
    }
  })
})

// ---------------------------------------------------------------------------
// G6 overseas
// ---------------------------------------------------------------------------

describe('G6 overseas number', () => {
  it('+61 input stays international and matches the roster person holding it', async () => {
    const instanceId = await createInstance()
    const { token } = await createLink(instanceId)
    const personId = await createPerson(AU_PHONE, 'G6')

    await submit(token, { status: 'coming', phone: '+61 491 570 156', name: '[SYNTH] Aussie Typed' })
    expect(await onlyRow(instanceId)).toMatchObject({ phone_e164: AU_PHONE, person_id: personId, name: null })

    await submit(token, { status: 'maybe', phone: AU_PHONE })
    expect(await onlyRow(instanceId)).toMatchObject({ phone_e164: AU_PHONE, person_id: personId, status: 'maybe' })
  })
})

// ---------------------------------------------------------------------------
// G7 admin derivation
// ---------------------------------------------------------------------------

describe('G7 admin panel display name', () => {
  it('matched -> roster full_name; newcomer -> typed name; removed_member -> null', async () => {
    const instanceId = await createInstance()
    const { token } = await createLink(instanceId)
    const memberPhone = nextPhone()
    const newcomerPhone = nextPhone()
    const removedPhone = nextPhone()
    await createPerson(memberPhone, 'G7 Member')
    const removedId = await createPerson(removedPhone, 'G7 Removed')

    await submit(token, { status: 'coming', phone: localFormat(memberPhone), name: '[SYNTH] Member Typed' })
    await submit(token, { status: 'maybe', phone: localFormat(newcomerPhone), name: '[SYNTH] Newcomer Typed' })
    await submit(token, { status: 'coming', phone: localFormat(removedPhone), name: '[SYNTH] Removed Typed' })
    await softDeletePerson(removedId)

    const idByPhone = new Map((await rsvpRows(instanceId)).map((r) => [r.phone_e164, r.id]))
    const res = await impl_getInstanceRsvpPanel(instanceId, adminSession)
    if (res.status !== 'ok') throw new Error(`panel: ${res.status}`)
    const byId = new Map(res.panel.rows.map((r) => [r.rsvp_id, r]))
    expect(byId.size).toBe(3)

    expect(byId.get(idByPhone.get(memberPhone)!)).toMatchObject({
      display_kind: 'member',
      display_name: `${ROSTER_PREFIX} G7 Member`,
    })
    expect(byId.get(idByPhone.get(newcomerPhone)!)).toMatchObject({
      display_kind: 'newcomer',
      display_name: '[SYNTH] Newcomer Typed',
    })
    expect(byId.get(idByPhone.get(removedPhone)!)).toMatchObject({
      display_kind: 'removed_member',
      display_name: null,
    })
    expect(JSON.stringify(res.panel.rows)).not.toContain('Member Typed')
    expect(JSON.stringify(res.panel.rows)).not.toContain('Removed Typed')
  })
})
