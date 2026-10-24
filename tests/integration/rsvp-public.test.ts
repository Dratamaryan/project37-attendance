// Integration tests for the S9-R1 public RSVP impl (lib/rsvp/public.impl.ts)
// end-to-end against the real anon RPCs: impl_getRsvpPageData and
// impl_submitRsvp through createAnonServerClient(), the same client the page
// and server action use.
// Runs against local Docker Supabase only (configured in .env.test.local).
// Prerequisite: supabase db reset (R0 migration + seed.sql's local rsvp_gate
// vault secret, whose literal this suite sets as RSVP_GATE_SECRET).
// Run: npm test -- rsvp-public
//
// Synthetic phones only: +62999 + 8 digits (13 digits after '+') — the
// unassigned +62999 range, and short enough that libphonenumber still accepts
// it (14+ digits is invalid for ID), since this suite submits through
// normalizePhone in local '0999…' form.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { randomUUID } from 'crypto'

vi.mock('server-only', () => ({}))

import { createAnonServerClient } from '@/lib/supabase/anon'
import { impl_getRsvpPageData, impl_submitRsvp } from '@/lib/rsvp/public.impl'
import type { RsvpFormState } from '@/lib/rsvp/public.types'

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
    `[rsvp-public.test.ts] NEXT_PUBLIC_SUPABASE_URL (${hostname}) is not local Docker. This suite ` +
      `uses the seed.sql gate literal and bulk-inserts 300 RSVP rows — local Docker only.`,
  )
}

// Same literal as supabase/seed.sql — local-only placeholder, not a secret.
const LOCAL_GATE = 'local-dev-only-rsvp-gate-not-a-secret'
// Seeded baseline admin (supabase/seed.sql) — app_users FK target for created_by.
const BASELINE_ADMIN_ID = '00000000-0000-0000-0000-000000000001'
const ROSTER_NAME = '[SYNTH] Rosterina Member'

let serviceAdmin: SupabaseClient
let anon: SupabaseClient

const ts = Date.now()
let phoneSeq = 0
// +62999 + 4 run digits + 4 sequence digits.
const nextPhone = () => {
  if (phoneSeq > 9999) throw new Error('nextPhone: sequence exhausted (4 digits)')
  return `+62999${(ts % 10_000).toString().padStart(4, '0')}${String(phoneSeq++).padStart(4, '0')}`
}
// What a visitor types: local format with a leading 0.
const localFormat = (e164: string) => `0${e164.slice(3)}`

const eventIds: string[] = []
const personIds: string[] = []

const ORIGINAL_FLAG = process.env.RSVP_PUBLIC_ENABLED
const ORIGINAL_GATE = process.env.RSVP_GATE_SECRET

function setEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

type InstanceOpts = {
  scheduledAt?: string
  status?: 'scheduled' | 'cancelled' | 'completed'
  nameId?: string | null
  imageUrl?: string | null
}

async function createInstance(opts: InstanceOpts = {}): Promise<{ instanceId: string; name: string }> {
  // 11:00Z = 18:00 WIB; 5 days out keeps the RSVP window open.
  const scheduledAt =
    opts.scheduledAt ?? `${new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10)}T11:00:00Z`
  const name = `RSVP Public Test ${randomUUID().slice(0, 8)}`
  const nameId = opts.nameId === undefined ? `${name} (ID)` : opts.nameId
  const { data: ev, error: evErr } = await serviceAdmin
    .from('events')
    .insert({
      name,
      name_id: nameId,
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

  const { data: inst, error: instErr } = await serviceAdmin
    .from('event_instances')
    .insert({
      event_id: (ev as { id: string }).id,
      scheduled_at: scheduledAt,
      event_name_snapshot: name,
      event_name_snapshot_id: nameId,
      status: opts.status ?? 'scheduled',
      image_url: opts.imageUrl === undefined ? 'https://example.invalid/rsvp-public.png' : opts.imageUrl,
    })
    .select('id')
    .single()
  if (instErr || !inst) throw new Error(`insert instance: ${instErr?.message}`)
  return { instanceId: (inst as { id: string }).id, name }
}

async function createLink(
  instanceId: string,
  opts: { isActive?: boolean; expiresAt?: string | null } = {},
): Promise<{ linkId: string; token: string }> {
  const { data, error } = await serviceAdmin
    .from('event_rsvp_links')
    .insert({
      event_instance_id: instanceId,
      is_active: opts.isActive ?? true,
      expires_at: opts.expiresAt ?? null,
      created_by: BASELINE_ADMIN_ID,
    })
    .select('id, token')
    .single()
  if (error || !data) throw new Error(`insert link: ${error?.message}`)
  const row = data as { id: string; token: string }
  return { linkId: row.id, token: row.token }
}

async function createPerson(phone: string): Promise<string> {
  const { data, error } = await serviceAdmin
    .from('people')
    .insert({ phone_e164: phone, full_name: ROSTER_NAME, nickname: 'Rosterina' })
    .select('id')
    .single()
  if (error || !data) throw new Error(`insert person: ${error?.message}`)
  personIds.push((data as { id: string }).id)
  return (data as { id: string }).id
}

async function rsvpRows(instanceId: string) {
  const { data, error } = await serviceAdmin
    .from('event_rsvps')
    .select('phone_e164, name, person_id, status, children_count, followup_consent')
    .eq('event_instance_id', instanceId)
    .order('created_at')
  if (error) throw new Error(`select rsvps: ${error.message}`)
  return data as {
    phone_e164: string
    name: string | null
    person_id: string | null
    status: string
    children_count: number
    followup_consent: boolean
  }[]
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  return fd
}

function submit(token: string, fields: Record<string, string>): Promise<RsvpFormState> {
  return impl_submitRsvp(token, form(fields), createAnonServerClient())
}

/** No full phone, no local-format phone, no roster name anywhere in a state. */
function expectNoLeak(state: unknown, phone: string) {
  const json = JSON.stringify(state)
  expect(json).not.toContain(phone)
  expect(json).not.toContain(phone.slice(1))
  expect(json).not.toContain(localFormat(phone))
  expect(json).not.toContain(ROSTER_NAME)
  expect(json).not.toContain('Rosterina')
}

beforeAll(() => {
  serviceAdmin = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
})

beforeEach(() => {
  setEnv('RSVP_PUBLIC_ENABLED', 'true')
  setEnv('RSVP_GATE_SECRET', LOCAL_GATE)
})

afterEach(() => {
  setEnv('RSVP_PUBLIC_ENABLED', ORIGINAL_FLAG)
  setEnv('RSVP_GATE_SECRET', ORIGINAL_GATE)
  vi.restoreAllMocks()
})

afterAll(async () => {
  // events → event_instances (CASCADE) → event_rsvp_links + event_rsvps (CASCADE)
  if (eventIds.length > 0) await serviceAdmin.from('events').delete().in('id', eventIds)
  if (personIds.length > 0) await serviceAdmin.from('people').delete().in('id', personIds)
}, 60_000)

describe('synthetic phone generator', () => {
  it('local format normalizes back to the same E.164', async () => {
    const { normalizePhone } = await import('@/lib/utils/phone')
    const phone = nextPhone()
    expect(phone).toMatch(/^\+62999\d{8}$/)
    expect(normalizePhone(localFormat(phone), 'ID')).toEqual({ ok: true, e164: phone })
  })
})

describe('impl_getRsvpPageData (live anon RPC)', () => {
  it('open link -> formatted event view per locale', async () => {
    const { instanceId, name } = await createInstance()
    const { token } = await createLink(instanceId)

    const id = await impl_getRsvpPageData(token, 'id', anon)
    expect(id).toMatchObject({
      kind: 'open',
      event: {
        name: `${name} (ID)`,
        timeLabel: '18.00–20.00 WIB',
        location: 'RSVP Test Hall',
        imageUrl: 'https://example.invalid/rsvp-public.png',
      },
    })
    const en = await impl_getRsvpPageData(token, 'en', anon)
    expect(en).toMatchObject({ kind: 'open', event: { name, timeLabel: '6:00 PM–8:00 PM WIB' } })
  })

  it('no image / no Indonesian name -> imageUrl null, id falls back to event_name', async () => {
    const { instanceId, name } = await createInstance({ imageUrl: null, nameId: null })
    const { token } = await createLink(instanceId)
    expect(await impl_getRsvpPageData(token, 'id', anon)).toMatchObject({
      kind: 'open',
      event: { name, imageUrl: null },
    })
  })

  it('unknown / inactive / expired / cancelled / malformed -> the same closed', async () => {
    const live = await createInstance()
    const inactive = await createLink(live.instanceId, { isActive: false })
    const expired = await createLink((await createInstance()).instanceId, {
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    })
    const cancelled = await createLink((await createInstance({ status: 'cancelled' })).instanceId)

    for (const token of ['bogus-' + randomUUID(), inactive.token, expired.token, cancelled.token, 'not a token!']) {
      expect(await impl_getRsvpPageData(token, 'id', anon)).toEqual({ kind: 'closed' })
    }
  })

  it('flag off -> disabled even for an open link', async () => {
    const { instanceId } = await createInstance()
    const { token } = await createLink(instanceId)
    setEnv('RSVP_PUBLIC_ENABLED', 'false')
    expect(await impl_getRsvpPageData(token, 'id', anon)).toEqual({ kind: 'disabled' })
  })
})

describe('impl_submitRsvp (live anon RPC)', () => {
  it('member vs newcomer: deep-equal states; member row matched, newcomer keeps typed name', async () => {
    const { instanceId } = await createInstance()
    const { token } = await createLink(instanceId)
    const memberPhone = nextPhone()
    const newcomerPhone = nextPhone()
    const memberId = await createPerson(memberPhone)

    const answers = {
      status: 'coming',
      name: 'Typed Name',
      bringing_children: 'yes',
      children_count: '2',
      followup_consent: 'on',
    }
    const memberState = await submit(token, { ...answers, phone: localFormat(memberPhone) })
    const newcomerState = await submit(token, { ...answers, phone: localFormat(newcomerPhone) })

    expect(memberState).toEqual({ kind: 'success', status: 'coming', children: 2 })
    expect(newcomerState).toEqual(memberState)
    expectNoLeak(memberState, memberPhone)
    expectNoLeak(newcomerState, newcomerPhone)

    const rows = await rsvpRows(instanceId)
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.phone_e164 === memberPhone)).toMatchObject({
      person_id: memberId,
      name: null,
      status: 'coming',
      children_count: 2,
      followup_consent: true,
    })
    expect(rows.find((r) => r.phone_e164 === newcomerPhone)).toMatchObject({
      person_id: null,
      name: 'Typed Name',
      status: 'coming',
      children_count: 2,
      followup_consent: true,
    })
  })

  it('resubmit (same phone, other format) updates the one row', async () => {
    const { instanceId } = await createInstance()
    const { token } = await createLink(instanceId)
    const phone = nextPhone()

    await submit(token, {
      status: 'coming',
      phone: localFormat(phone),
      name: 'First Name',
      bringing_children: 'yes',
      children_count: '3',
      followup_consent: 'on',
    })
    const second = await submit(token, { status: 'not_coming', phone: phone.replace('+62', '+62 ') })
    expect(second).toEqual({ kind: 'success', status: 'not_coming', children: 0 })
    expectNoLeak(second, phone)

    const rows = await rsvpRows(instanceId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      phone_e164: phone,
      name: 'First Name', // blank resubmit keeps the earlier newcomer name
      status: 'not_coming',
      children_count: 0,
      followup_consent: false,
    })
  })

  it('closed token (inactive link) -> closed, no row', async () => {
    const { instanceId } = await createInstance()
    const { token } = await createLink(instanceId, { isActive: false })
    expect(await submit(token, { status: 'coming', phone: localFormat(nextPhone()) })).toEqual({ kind: 'closed' })
    expect(await rsvpRows(instanceId)).toHaveLength(0)
  })

  it('unknown token -> closed', async () => {
    expect(await submit('bogus-' + randomUUID(), { status: 'coming', phone: localFormat(nextPhone()) })).toEqual({
      kind: 'closed',
    })
  })

  it('flag off -> closed, no row', async () => {
    const { instanceId } = await createInstance()
    const { token } = await createLink(instanceId)
    setEnv('RSVP_PUBLIC_ENABLED', 'false')
    expect(await submit(token, { status: 'coming', phone: localFormat(nextPhone()) })).toEqual({ kind: 'closed' })
    expect(await rsvpRows(instanceId)).toHaveLength(0)
  })

  it('missing gate env -> unavailable, no row', async () => {
    const { instanceId } = await createInstance()
    const { token } = await createLink(instanceId)
    setEnv('RSVP_GATE_SECRET', undefined)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await submit(token, { status: 'coming', phone: localFormat(nextPhone()) })).toEqual({
      kind: 'unavailable',
    })
    expect(await rsvpRows(instanceId)).toHaveLength(0)
  })

  it('wrong gate env -> unavailable, no row, gate value not logged', async () => {
    const { instanceId } = await createInstance()
    const { token } = await createLink(instanceId)
    setEnv('RSVP_GATE_SECRET', 'wrong-gate-value')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await submit(token, { status: 'coming', phone: localFormat(nextPhone()) })).toEqual({
      kind: 'unavailable',
    })
    expect(await rsvpRows(instanceId)).toHaveLength(0)
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('wrong-gate-value')
  })

  it('invalid input -> field errors, no row', async () => {
    const { instanceId } = await createInstance()
    const { token } = await createLink(instanceId)
    expect(await submit(token, { status: 'coming', phone: '0812' })).toEqual({
      kind: 'invalid',
      fieldErrors: { phone: 'too_short' },
    })
    expect(await rsvpRows(instanceId)).toHaveLength(0)
  })

  it('300 distinct phones -> limit for a new phone; existing phone still updatable', async () => {
    const { instanceId } = await createInstance()
    const { linkId, token } = await createLink(instanceId)
    const fill = Array.from({ length: 300 }, () => ({
      event_instance_id: instanceId,
      link_id: linkId,
      phone_e164: nextPhone(),
      status: 'coming',
    }))
    const { error } = await serviceAdmin.from('event_rsvps').insert(fill)
    if (error) throw new Error(`bulk insert: ${error.message}`)

    const newcomer = nextPhone()
    const limited = await submit(token, { status: 'coming', phone: localFormat(newcomer) })
    expect(limited).toEqual({ kind: 'limit' })
    expectNoLeak(limited, newcomer)
    expect(await rsvpRows(instanceId)).toHaveLength(300)

    expect(await submit(token, { status: 'maybe', phone: localFormat(fill[0].phone_e164) })).toEqual({
      kind: 'success',
      status: 'maybe',
      children: 0,
    })
  })
})
