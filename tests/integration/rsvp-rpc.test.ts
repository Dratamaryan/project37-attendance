// Integration tests for Sprint 9 R0 — event_rsvp_links / event_rsvps, the
// rsvp_instance_open() window helper, and the anon RPCs get_rsvp_context /
// submit_rsvp (20261020120000_sprint9_r0_rsvp.sql).
// Runs against local Docker Supabase only (configured in .env.test.local).
// Prerequisite: migration applied + seed.sql's local rsvp_gate vault secret
// (supabase db reset).
// Run: npm test -- rsvp-rpc
//
// Catalog privileges (has_function_privilege), the owner-only helper, and the
// vault secret are not reachable through PostgREST, so those assertions go
// through psql inside the local DB container (docker exec). The "vault secret
// absent" case renames the secret and restores it in a finally block — a
// destructive fixture, which is why this suite hard-refuses any non-local URL.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import { randomUUID } from 'crypto'
import { formatJakarta, instanceEndWibDate, toJakartaInstant } from '@/lib/events/timezone'

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
    `[rsvp-rpc.test.ts] NEXT_PUBLIC_SUPABASE_URL (${hostname}) is not local Docker. This suite ` +
      `renames the vault rsvp_gate secret via docker exec — must run against local Docker only.`,
  )
}

const DB_CONTAINER = 'supabase_db_project37-rewrite'
// Same literal as supabase/seed.sql — local-only placeholder, not a secret.
const LOCAL_GATE = 'local-dev-only-rsvp-gate-not-a-secret'
// Seeded baseline admin (supabase/seed.sql) — app_users FK target for created_by.
const BASELINE_ADMIN_ID = '00000000-0000-0000-0000-000000000001'

const CONTEXT_FN = 'public.get_rsvp_context(text)'
const SUBMIT_FN = 'public.submit_rsvp(text,text,text,text,integer,boolean,text)'
const HELPER_FN = 'public.rsvp_instance_open(uuid)'

function psql(sql: string): string {
  return execFileSync(
    'docker',
    ['exec', DB_CONTAINER, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atc', sql],
    { encoding: 'utf8' },
  ).trim()
}

let serviceAdmin: SupabaseClient
let anon: SupabaseClient

const ts = Date.now()
let phoneSeq = 0
// Synthetic numbers in the unassigned +62999 range: 5 prefix digits + 6 run
// digits + 4 sequence digits = 15 digits after '+', the E.164 maximum.
const E164_RE = /^\+[1-9][0-9]{6,14}$/
const nextPhone = () => {
  if (phoneSeq > 9999) throw new Error('nextPhone: sequence exhausted (4 digits)')
  return `+62999${(ts % 1_000_000).toString().padStart(6, '0')}${String(phoneSeq++).padStart(4, '0')}`
}

const eventIds: string[] = []
const personIds: string[] = []
const appUserIds: string[] = []

type InstanceOpts = {
  scheduledAt?: string
  durationMin?: number
  status?: 'scheduled' | 'cancelled' | 'completed'
}

async function createInstance(opts: InstanceOpts = {}): Promise<{ instanceId: string; scheduledAt: string; durationMin: number }> {
  const scheduledAt = opts.scheduledAt ?? new Date(Date.now() + 5 * 86_400_000).toISOString()
  const durationMin = opts.durationMin ?? 120
  const name = `RSVP Test Event ${randomUUID().slice(0, 8)}`
  const { data: ev, error: evErr } = await serviceAdmin
    .from('events')
    .insert({
      name,
      name_id: `${name} (ID)`,
      event_type: 'adhoc',
      start_date: scheduledAt.slice(0, 10),
      start_time: '18:00:00',
      duration_min: durationMin,
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
      event_name_snapshot_id: `${name} (ID)`,
      status: opts.status ?? 'scheduled',
      image_url: 'https://example.invalid/rsvp-test.png',
    })
    .select('id')
    .single()
  if (instErr || !inst) throw new Error(`insert instance: ${instErr?.message}`)
  return { instanceId: (inst as { id: string }).id, scheduledAt, durationMin }
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

async function createPerson(phone: string, extra: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await serviceAdmin
    .from('people')
    .insert({ phone_e164: phone, full_name: 'RSVP Test Person', nickname: 'RsvpTest', ...extra })
    .select('id')
    .single()
  if (error || !data) throw new Error(`insert person: ${error?.message}`)
  personIds.push((data as { id: string }).id)
  return (data as { id: string }).id
}

// Same shape as event-invitations-rls.test.ts's createAppUser: real auth user
// + app_users row + password sign-in on a fresh anon-key client.
async function createAppUser(
  label: string,
  ts: number,
  role: 'admin' | 'organizer',
): Promise<{ id: string; session: SupabaseClient }> {
  const email = `rsvp-${label}-${ts}@example.com`
  const pass = `RsvpPass-${label}-${ts}!`
  const { data: authData, error: authErr } = await serviceAdmin.auth.admin.createUser({
    email,
    password: pass,
    email_confirm: true,
  })
  if (authErr || !authData.user) throw new Error(`createUser (${label}): ${authErr?.message}`)
  appUserIds.push(authData.user.id)
  const { error: appUserErr } = await serviceAdmin.from('app_users').insert({
    id: authData.user.id,
    email,
    full_name: `[SYNTH] RSVP Test ${label}`,
    role,
    active: true,
  })
  if (appUserErr) throw new Error(`insert app_user (${label}): ${appUserErr.message}`)
  const session = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { error: signInErr } = await session.auth.signInWithPassword({ email, password: pass })
  if (signInErr) throw new Error(`sign-in (${label}): ${signInErr.message}`)
  return { id: authData.user.id, session }
}

type SubmitArgs = {
  p_gate: string | null
  p_token: string | null
  p_phone_e164: string | null
  p_name: string | null
  p_children_count: number | null
  p_followup_consent: boolean | null
  p_status: string | null
}

function submitArgs(token: string, phone: string, overrides: Partial<SubmitArgs> = {}): SubmitArgs {
  return {
    p_gate: LOCAL_GATE,
    p_token: token,
    p_phone_e164: phone,
    p_name: null,
    p_children_count: 0,
    p_followup_consent: false,
    p_status: 'coming',
    ...overrides,
  }
}

async function submit(args: SubmitArgs): Promise<unknown> {
  const { data, error } = await anon.rpc('submit_rsvp', args)
  if (error) throw new Error(`submit_rsvp: ${error.message}`)
  return data
}

// Raw PostgREST call so the response body can be compared byte-for-byte.
async function submitRaw(args: SubmitArgs): Promise<{ status: number; body: string }> {
  const res = await fetch(`${url}/rest/v1/rpc/submit_rsvp`, {
    method: 'POST',
    headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  return { status: res.status, body: await res.text() }
}

async function rsvpRows(instanceId: string) {
  const { data, error } = await serviceAdmin
    .from('event_rsvps')
    .select('id, phone_e164, name, person_id, status, children_count, followup_consent, link_id')
    .eq('event_instance_id', instanceId)
  if (error) throw new Error(`select rsvps: ${error.message}`)
  return data as {
    id: string
    phone_e164: string
    name: string | null
    person_id: string | null
    status: string
    children_count: number
    followup_consent: boolean
    link_id: string
  }[]
}

async function peopleWithPhone(phone: string): Promise<number> {
  const { count, error } = await serviceAdmin
    .from('people')
    .select('id', { count: 'exact', head: true })
    .eq('phone_e164', phone)
  if (error || count === null) throw new Error(`count people: ${error?.message}`)
  return count
}

beforeAll(() => {
  serviceAdmin = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })
  anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
})

afterAll(async () => {
  // events → event_instances (CASCADE) → event_rsvp_links + event_rsvps (CASCADE)
  if (eventIds.length > 0) await serviceAdmin.from('events').delete().in('id', eventIds)
  if (personIds.length > 0) await serviceAdmin.from('people').delete().in('id', personIds)
  for (const userId of appUserIds) {
    await serviceAdmin.from('app_users').delete().eq('id', userId)
    await serviceAdmin.auth.admin.deleteUser(userId)
  }
}, 60_000)

describe('synthetic phone generator', () => {
  it('produces E.164-valid numbers with at most 15 digits after +', () => {
    const sample = nextPhone()
    expect(sample).toMatch(E164_RE)
    expect(sample.length - 1).toBeLessThanOrEqual(15)
  })
})

// ---------------------------------------------------------------------------
// a. anon table access
// ---------------------------------------------------------------------------

describe('anon via PostgREST has no table access', () => {
  for (const table of ['event_rsvp_links', 'event_rsvps'] as const) {
    it(`${table}: SELECT / INSERT / UPDATE / DELETE all denied (42501)`, async () => {
      const sel = await anon.from(table).select('id').limit(1)
      expect(sel.error?.code).toBe('42501')

      const ins = await anon.from(table).insert({ event_instance_id: randomUUID() })
      expect(ins.error?.code).toBe('42501')

      const upd = await anon.from(table).update({ created_at: new Date().toISOString() }).eq('id', randomUUID())
      expect(upd.error?.code).toBe('42501')

      const del = await anon.from(table).delete().eq('id', randomUUID())
      expect(del.error?.code).toBe('42501')
    })
  }
})

// ---------------------------------------------------------------------------
// a2. authenticated RLS — admin-only policy, no organizer access
// ---------------------------------------------------------------------------

describe('authenticated RLS on event_rsvp_links / event_rsvps', () => {
  let organizerSession: SupabaseClient
  let adminSession: SupabaseClient
  let instanceId: string
  let linkId: string
  let rsvpPhone: string

  beforeAll(async () => {
    const organizer = await createAppUser('organizer', ts, 'organizer')
    organizerSession = organizer.session
    const admin = await createAppUser('admin', ts, 'admin')
    adminSession = admin.session

    ;({ instanceId } = await createInstance())
    let token: string
    ;({ linkId, token } = await createLink(instanceId))
    rsvpPhone = nextPhone()
    expect(await submit(submitArgs(token, rsvpPhone, { p_name: 'RLS Rows Present' }))).toEqual({ ok: true })
    expect(await rsvpRows(instanceId)).toHaveLength(1)
  }, 30_000)

  it('organizer: SELECT on both tables returns 0 rows, no error', async () => {
    const links = await organizerSession.from('event_rsvp_links').select('id').eq('event_instance_id', instanceId)
    expect(links.error).toBeNull()
    expect(links.data).toEqual([])

    const rsvps = await organizerSession.from('event_rsvps').select('id').eq('event_instance_id', instanceId)
    expect(rsvps.error).toBeNull()
    expect(rsvps.data).toEqual([])
  })

  it('organizer: INSERT into each table is denied by RLS (42501)', async () => {
    const link = await organizerSession.from('event_rsvp_links').insert({
      event_instance_id: instanceId,
      is_active: false,
      created_by: BASELINE_ADMIN_ID,
    })
    expect(link.error?.code).toBe('42501')

    const rsvp = await organizerSession.from('event_rsvps').insert({
      event_instance_id: instanceId,
      link_id: linkId,
      phone_e164: nextPhone(),
      status: 'coming',
    })
    expect(rsvp.error?.code).toBe('42501')

    expect(await rsvpRows(instanceId)).toHaveLength(1)
  })

  it('admin: SELECT on both tables returns the rows', async () => {
    const links = await adminSession.from('event_rsvp_links').select('id').eq('event_instance_id', instanceId)
    expect(links.error).toBeNull()
    expect(links.data).toEqual([{ id: linkId }])

    const rsvps = await adminSession
      .from('event_rsvps')
      .select('phone_e164, name')
      .eq('event_instance_id', instanceId)
    expect(rsvps.error).toBeNull()
    expect(rsvps.data).toEqual([{ phone_e164: rsvpPhone, name: 'RLS Rows Present' }])
  })
})

// ---------------------------------------------------------------------------
// b. function privilege matrix
// ---------------------------------------------------------------------------

describe('function EXECUTE privilege matrix', () => {
  const expected: Record<string, Record<string, boolean>> = {
    [CONTEXT_FN]: { anon: true, authenticated: false, service_role: false, public: false },
    [SUBMIT_FN]: { anon: true, authenticated: false, service_role: false, public: false },
    [HELPER_FN]: { anon: false, authenticated: false, service_role: false, public: false },
  }

  for (const [fn, roles] of Object.entries(expected)) {
    for (const [role, allowed] of Object.entries(roles)) {
      it(`${role} on ${fn} → ${allowed}`, () => {
        const out = psql(`SELECT has_function_privilege('${role}', '${fn}', 'EXECUTE')`)
        expect(out).toBe(allowed ? 't' : 'f')
      })
    }
  }

  it('helper is not SECURITY DEFINER; both RPCs are', () => {
    const out = psql(
      `SELECT proname || '=' || prosecdef FROM pg_proc ` +
        `WHERE proname IN ('get_rsvp_context','submit_rsvp','rsvp_instance_open') ORDER BY proname`,
    )
    expect(out.split('\n')).toEqual([
      'get_rsvp_context=true',
      'rsvp_instance_open=false',
      'submit_rsvp=true',
    ])
  })
})

// ---------------------------------------------------------------------------
// c. gate
// ---------------------------------------------------------------------------

describe('submit_rsvp gate', () => {
  let token: string
  let instanceId: string

  beforeAll(async () => {
    ;({ instanceId } = await createInstance())
    ;({ token } = await createLink(instanceId))
  })

  it('missing p_gate → unavailable, no row', async () => {
    const phone = nextPhone()
    expect(await submit(submitArgs(token, phone, { p_gate: null }))).toEqual({ ok: false, code: 'unavailable' })
    expect((await rsvpRows(instanceId)).some((r) => r.phone_e164 === phone)).toBe(false)
  })

  it('wrong p_gate → unavailable, no row', async () => {
    const phone = nextPhone()
    expect(await submit(submitArgs(token, phone, { p_gate: `${LOCAL_GATE}-wrong` }))).toEqual({
      ok: false,
      code: 'unavailable',
    })
    expect((await rsvpRows(instanceId)).some((r) => r.phone_e164 === phone)).toBe(false)
  })

  it('vault secret absent → unavailable even with the right gate', async () => {
    const phone = nextPhone()
    psql(`SELECT vault.update_secret((SELECT id FROM vault.secrets WHERE name = 'rsvp_gate'), NULL, 'rsvp_gate_parked')`)
    try {
      expect(psql(`SELECT count(*) FROM vault.secrets WHERE name = 'rsvp_gate'`)).toBe('0')
      expect(await submit(submitArgs(token, phone))).toEqual({ ok: false, code: 'unavailable' })
    } finally {
      psql(`SELECT vault.update_secret((SELECT id FROM vault.secrets WHERE name = 'rsvp_gate_parked'), NULL, 'rsvp_gate')`)
    }
    expect(psql(`SELECT count(*) FROM vault.secrets WHERE name = 'rsvp_gate'`)).toBe('1')
    expect((await rsvpRows(instanceId)).some((r) => r.phone_e164 === phone)).toBe(false)
  })

  it('wrong p_gate + unknown token → unavailable (gate checked before token lookup)', async () => {
    expect(
      await submit(submitArgs(`unknown-${randomUUID()}`, nextPhone(), { p_gate: `${LOCAL_GATE}-wrong` })),
    ).toEqual({ ok: false, code: 'unavailable' })
  })

  it('right gate → ok and a row is written', async () => {
    const phone = nextPhone()
    expect(await submit(submitArgs(token, phone))).toEqual({ ok: true })
    expect((await rsvpRows(instanceId)).filter((r) => r.phone_e164 === phone)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// d / e / f. member vs newcomer, resubmit, soft-deleted / anonymized
// ---------------------------------------------------------------------------

describe('member vs newcomer', () => {
  let instanceId: string
  let token: string
  let linkId: string

  beforeAll(async () => {
    ;({ instanceId } = await createInstance())
    ;({ token, linkId } = await createLink(instanceId))
  })

  it('d. response bodies byte-identical; member row person_id + NULL name; newcomer row keeps name, no people row', async () => {
    const memberPhone = nextPhone()
    const newcomerPhone = nextPhone()
    const memberId = await createPerson(memberPhone)

    const memberRes = await submitRaw(submitArgs(token, memberPhone, { p_name: 'Member Typed Name' }))
    const newcomerRes = await submitRaw(
      submitArgs(token, newcomerPhone, { p_name: '  Newcomer Nadia  ', p_children_count: 2, p_followup_consent: true }),
    )

    expect(memberRes.status).toBe(200)
    expect(newcomerRes.status).toBe(memberRes.status)
    expect(newcomerRes.body).toBe(memberRes.body)
    expect(JSON.parse(memberRes.body)).toEqual({ ok: true })
    expect(await peopleWithPhone(newcomerPhone)).toBe(0)

    const rows = await rsvpRows(instanceId)
    const member = rows.find((r) => r.phone_e164 === memberPhone)
    const newcomer = rows.find((r) => r.phone_e164 === newcomerPhone)
    expect(member).toMatchObject({ person_id: memberId, name: null, status: 'coming', link_id: linkId })
    expect(newcomer).toMatchObject({
      person_id: null,
      name: 'Newcomer Nadia',
      children_count: 2,
      followup_consent: true,
    })
  })

  it('e. resubmit updates the one row; newcomer resubmit without name keeps the name', async () => {
    const phone = nextPhone()
    expect(await submit(submitArgs(token, phone, { p_name: 'Repeat Rina' }))).toEqual({ ok: true })
    expect(
      await submit(
        submitArgs(token, phone, { p_name: '   ', p_status: 'maybe', p_children_count: 3, p_followup_consent: null }),
      ),
    ).toEqual({ ok: true })

    const rows = (await rsvpRows(instanceId)).filter((r) => r.phone_e164 === phone)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      name: 'Repeat Rina',
      status: 'maybe',
      children_count: 3,
      followup_consent: false,
      person_id: null,
    })
  })

  it('e. member resubmit stays one row with NULL name', async () => {
    const phone = nextPhone()
    const memberId = await createPerson(phone)
    await submit(submitArgs(token, phone, { p_name: 'First' }))
    await submit(submitArgs(token, phone, { p_name: 'Second', p_status: 'not_coming' }))
    const rows = (await rsvpRows(instanceId)).filter((r) => r.phone_e164 === phone)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ person_id: memberId, name: null, status: 'not_coming' })
  })

  it('f. soft-deleted and anonymized people are never matched', async () => {
    const deletedPhone = nextPhone()
    const anonymizedPhone = nextPhone()
    await createPerson(deletedPhone, { deleted_at: new Date().toISOString() })
    await createPerson(anonymizedPhone, { anonymized_at: new Date().toISOString() })

    expect(await submit(submitArgs(token, deletedPhone, { p_name: 'Deleted Dewi' }))).toEqual({ ok: true })
    expect(await submit(submitArgs(token, anonymizedPhone, { p_name: 'Anon Agus' }))).toEqual({ ok: true })

    const rows = await rsvpRows(instanceId)
    expect(rows.find((r) => r.phone_e164 === deletedPhone)).toMatchObject({ person_id: null, name: 'Deleted Dewi' })
    expect(rows.find((r) => r.phone_e164 === anonymizedPhone)).toMatchObject({ person_id: null, name: 'Anon Agus' })
  })
})

// ---------------------------------------------------------------------------
// g. caps + validation
// ---------------------------------------------------------------------------

describe('caps and validation', () => {
  let instanceId: string
  let token: string
  let linkId: string

  beforeAll(async () => {
    ;({ instanceId } = await createInstance())
    ;({ token, linkId } = await createLink(instanceId))
  })

  it('children_count 21 → invalid; 20 → ok', async () => {
    expect(await submit(submitArgs(token, nextPhone(), { p_children_count: 21 }))).toEqual({ ok: false, code: 'invalid' })
    expect(await submit(submitArgs(token, nextPhone(), { p_children_count: 20 }))).toEqual({ ok: true })
  })

  it('bad phone / bad status / NULL children → invalid', async () => {
    expect(await submit(submitArgs(token, '0812345678'))).toEqual({ ok: false, code: 'invalid' })
    expect(await submit(submitArgs(token, nextPhone(), { p_status: 'yes' }))).toEqual({ ok: false, code: 'invalid' })
    expect(await submit(submitArgs(token, nextPhone(), { p_children_count: null }))).toEqual({ ok: false, code: 'invalid' })
  })

  it('301st distinct phone → limit; an existing phone is still updatable at the cap', async () => {
    const existing = await rsvpRows(instanceId)
    const fill = Array.from({ length: 300 - existing.length }, () => ({
      event_instance_id: instanceId,
      link_id: linkId,
      phone_e164: nextPhone(),
      status: 'coming',
    }))
    const { error } = await serviceAdmin.from('event_rsvps').insert(fill)
    if (error) throw new Error(`bulk insert: ${error.message}`)
    expect(await rsvpRows(instanceId)).toHaveLength(300)

    expect(await submit(submitArgs(token, nextPhone()))).toEqual({ ok: false, code: 'limit' })
    expect(await rsvpRows(instanceId)).toHaveLength(300)

    const atCap = fill[0].phone_e164
    expect(await submit(submitArgs(token, atCap, { p_status: 'not_coming' }))).toEqual({ ok: true })
    const rows = await rsvpRows(instanceId)
    expect(rows).toHaveLength(300)
    expect(rows.find((r) => r.phone_e164 === atCap)?.status).toBe('not_coming')
  })
})

// ---------------------------------------------------------------------------
// h. closed states
// ---------------------------------------------------------------------------

describe('closed states', () => {
  const yesterdayWib = formatJakarta(new Date(Date.now() - 86_400_000), 'yyyy-MM-dd')

  const cases: { label: string; setup: () => Promise<string> }[] = [
    { label: 'unknown token', setup: async () => `unknown-${randomUUID()}` },
    { label: 'over-long token', setup: async () => 'x'.repeat(65) },
    {
      label: 'inactive link',
      setup: async () => (await createLink((await createInstance()).instanceId, { isActive: false })).token,
    },
    {
      label: 'past expires_at',
      setup: async () =>
        (await createLink((await createInstance()).instanceId, { expiresAt: new Date(Date.now() - 60_000).toISOString() }))
          .token,
    },
    {
      label: 'cancelled instance',
      setup: async () => (await createLink((await createInstance({ status: 'cancelled' })).instanceId)).token,
    },
    {
      label: 'completed instance',
      setup: async () => (await createLink((await createInstance({ status: 'completed' })).instanceId)).token,
    },
    {
      label: 'past WIB end day (ended yesterday 23:59 WIB)',
      setup: async () =>
        (
          await createLink(
            (
              await createInstance({
                scheduledAt: toJakartaInstant(yesterdayWib, '21:59').toISOString(),
                durationMin: 120,
              })
            ).instanceId,
          )
        ).token,
    },
  ]

  for (const c of cases) {
    it(`${c.label}: context is exactly {"open":false}; submit → closed`, async () => {
      const token = await c.setup()
      const { data, error } = await anon.rpc('get_rsvp_context', { p_token: token })
      expect(error).toBeNull()
      expect(JSON.stringify(data)).toBe('{"open":false}')
      expect(await submit(submitArgs(token, nextPhone()))).toEqual({ ok: false, code: 'closed' })
    })
  }

  it('NULL token: context {"open":false}; submit → closed', async () => {
    const { data } = await anon.rpc('get_rsvp_context', { p_token: null })
    expect(JSON.stringify(data)).toBe('{"open":false}')
    expect(await submit(submitArgs('', nextPhone(), { p_token: null }))).toEqual({ ok: false, code: 'closed' })
  })

  it('open link returns exactly the documented keys', async () => {
    const { instanceId, scheduledAt } = await createInstance()
    const { token } = await createLink(instanceId, { expiresAt: new Date(Date.now() + 86_400_000).toISOString() })
    const { data, error } = await anon.rpc('get_rsvp_context', { p_token: token })
    expect(error).toBeNull()
    const ctx = data as Record<string, unknown>
    expect(Object.keys(ctx).sort()).toEqual(
      ['duration_min', 'event_name', 'event_name_id', 'image_url', 'location', 'open', 'scheduled_at'].sort(),
    )
    expect(ctx.open).toBe(true)
    expect(ctx.duration_min).toBe(120)
    expect(ctx.location).toBe('RSVP Test Hall')
    expect(ctx.image_url).toBe('https://example.invalid/rsvp-test.png')
    expect(Date.parse(ctx.scheduled_at as string)).toBe(Date.parse(scheduledAt))
  })

  it('deleting an instance cascades through links + rsvps (link_id FK is NO ACTION, not RESTRICT)', async () => {
    const { instanceId } = await createInstance()
    const { token } = await createLink(instanceId)
    expect(await submit(submitArgs(token, nextPhone()))).toEqual({ ok: true })
    const { error } = await serviceAdmin.from('event_instances').delete().eq('id', instanceId)
    expect(error).toBeNull()
    expect(await rsvpRows(instanceId)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// i. TS <-> SQL window parity
// ---------------------------------------------------------------------------

describe('instanceEndWibDate ↔ rsvp_instance_open parity', () => {
  // Fixture dates are relative to "today" in WIB. A run that straddles WIB
  // midnight between computing todayWib and the SQL call could flake; WIB has
  // no DST, so day arithmetic in ms is exact.
  const now = Date.now()
  const wibDay = (offset: number) => formatJakarta(new Date(now + offset * 86_400_000), 'yyyy-MM-dd')
  const todayWib = wibDay(0)

  const fixtures: { label: string; day: number; time: string; durationMin: number; open: boolean }[] = [
    { label: 'ends today 23:59 WIB', day: 0, time: '21:59', durationMin: 120, open: true },
    { label: 'ended yesterday 23:59 WIB', day: -1, time: '21:59', durationMin: 120, open: false },
    { label: 'crosses WIB midnight into today (yesterday 23:00 + 2h)', day: -1, time: '23:00', durationMin: 120, open: true },
    { label: 'crosses WIB midnight into yesterday (D-2 23:00 + 2h)', day: -2, time: '23:00', durationMin: 120, open: false },
    { label: 'ends exactly 00:00 today WIB', day: -1, time: '22:00', durationMin: 120, open: true },
    { label: 'ends 23:59 tomorrow WIB', day: 1, time: '23:00', durationMin: 59, open: true },
  ]

  for (const f of fixtures) {
    it(`${f.label} → ${f.open ? 'open' : 'closed'} in both TS and SQL`, async () => {
      const scheduledAt = toJakartaInstant(wibDay(f.day), f.time).toISOString()
      const { instanceId } = await createInstance({ scheduledAt, durationMin: f.durationMin })

      const tsOpen = todayWib <= instanceEndWibDate(scheduledAt, f.durationMin)
      const sqlOpen = psql(`SELECT public.rsvp_instance_open('${instanceId}')`) === 't'

      expect(tsOpen).toBe(f.open)
      expect(sqlOpen).toBe(tsOpen)
    })
  }

  it('unknown instance id → false', () => {
    expect(psql(`SELECT public.rsvp_instance_open('${randomUUID()}')`)).toBe('f')
  })
})
