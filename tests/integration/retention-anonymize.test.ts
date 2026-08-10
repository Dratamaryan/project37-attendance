// Integration tests for Sprint 6 Task 4 — retention anonymize-in-place.
// Runs against local Docker Supabase (configured in .env.test.local).
// Prerequisite: S6-T4 migration applied (supabase db reset).
// Run: npm test -- retention-anonymize
//
// Covers both call paths sharing the anonymize_person() SQL primitive:
// admin "anonymize now" (impl_anonymizePerson, requireActiveAdmin-gated) and
// the scheduled pass (run_retention_pass(), called directly via RPC — the
// whole batch-orchestration loop lives in SQL, there is no TS wrapper for it,
// same as the cron route itself only calls the RPC).

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'crypto'
import { subDays, subYears } from 'date-fns'
import { impl_anonymizePerson } from '@/lib/actions/people.impl'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !anonKey || !serviceRoleKey) {
  throw new Error(
    'Missing env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY',
  )
}

const PROD_PROJECT_REF = 'bftifxgdcmisasgvobuf'
if (url.includes(PROD_PROJECT_REF)) {
  throw new Error(
    `[retention-anonymize.test.ts] NEXT_PUBLIC_SUPABASE_URL resolves to the PRODUCTION project ` +
      `(${PROD_PROJECT_REF}). This suite anonymizes real rows — must run against local Docker only.`,
  )
}

let serviceAdmin: SupabaseClient
const ts = Date.now()

const personIds = new Set<string>()
const userIds = new Set<string>()

let eventId: string
let instanceId: string

let adminId: string
let adminSession: SupabaseClient
let organizerSession: SupabaseClient
let inactiveAdminSession: SupabaseClient

let originalRetentionYears: number | null

async function createAppUserFixture(
  label: string,
  role: 'admin' | 'organizer',
  active = true,
): Promise<{ id: string; session: SupabaseClient }> {
  const email = `s6t4-${label}-${randomUUID()}@test.invalid`
  const pass = `S6T4Pass-${label}-${ts}!`
  const { data: authData, error: authErr } = await serviceAdmin.auth.admin.createUser({
    email,
    password: pass,
    email_confirm: true,
  })
  if (authErr || !authData.user) throw new Error(`createUser (${label}): ${authErr?.message}`)
  userIds.add(authData.user.id)

  const { error: appErr } = await serviceAdmin
    .from('app_users')
    .insert({ id: authData.user.id, email, full_name: `S6T4 Test ${label}`, role, active })
  if (appErr) throw new Error(`insert app_user (${label}): ${appErr.message}`)

  const session = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { error: signInErr } = await session.auth.signInWithPassword({ email, password: pass })
  if (signInErr) throw new Error(`sign-in (${label}): ${signInErr.message}`)
  return { id: authData.user.id, session }
}

function fixturePhone(): string {
  return `+62${ts}${Math.floor(Math.random() * 1_000_000)}`
}

type PersonFixtureOverrides = {
  deleted_at?: string | null
  photo_url?: string | null
  anonymized_at?: string | null
}

async function createPersonFixture(overrides: PersonFixtureOverrides = {}): Promise<string> {
  const suffix = randomUUID().slice(0, 8)
  const { data, error } = await serviceAdmin
    .from('people')
    .insert({
      phone_e164: fixturePhone(),
      full_name: `S6T4 Person ${suffix}`,
      nickname: `T4-${suffix}`,
      email: `s6t4-person-${suffix}@test.invalid`,
      birth_place: 'Testville',
      birth_date: '1990-01-01',
      current_city: 'Testopolis',
      notes: 'fixture notes — must not survive scrub',
      photo_publish_consent: true,
      photo_consent_state: 'granted',
      photo_consent_at: new Date().toISOString(),
      birthday_email_opt_in: true,
      birthday_email_opt_in_at: new Date().toISOString(),
      ...overrides,
    })
    .select('id')
    .single()
  if (error || !data) throw new Error(`fixture person insert: ${error?.message}`)
  personIds.add(data.id as string)
  return data.id as string
}

async function auditRowsFor(personId: string) {
  const { data } = await serviceAdmin
    .from('audit_log')
    .select('id, actor_user_id, action, entity_type, entity_id, details_json, created_at')
    .eq('action', 'people.anonymize')
    .eq('entity_id', personId)
    .order('created_at', { ascending: true })
  return data ?? []
}

async function getPerson(personId: string) {
  const { data, error } = await serviceAdmin.from('people').select('*').eq('id', personId).single()
  if (error) throw new Error(`getPerson ${personId}: ${error.message}`)
  return data as Record<string, unknown>
}

async function setRetentionYears(years: number | null) {
  const { error } = await serviceAdmin
    .from('app_settings')
    .update({ retention_archive_years: years })
    .eq('id', 1)
  if (error) throw new Error(`setRetentionYears(${years}): ${error.message}`)
}

beforeAll(async () => {
  serviceAdmin = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { data: settingsRow, error: settingsErr } = await serviceAdmin
    .from('app_settings')
    .select('retention_archive_years')
    .eq('id', 1)
    .single()
  if (settingsErr) throw new Error(`read app_settings: ${settingsErr.message}`)
  originalRetentionYears = (settingsRow as { retention_archive_years: number | null })
    .retention_archive_years

  const admin = await createAppUserFixture('admin', 'admin')
  adminId = admin.id
  adminSession = admin.session

  const organizer = await createAppUserFixture('organizer', 'organizer')
  organizerSession = organizer.session

  const inactiveAdmin = await createAppUserFixture('inactive-admin', 'admin', false)
  inactiveAdminSession = inactiveAdmin.session

  const { data: ev, error: evErr } = await serviceAdmin
    .from('events')
    .insert({
      name: 'S6T4 Retention Test Event',
      event_type: 'adhoc',
      start_date: '2026-08-01',
      start_time: '18:00:00',
      active: true,
      created_by: adminId,
    })
    .select('id')
    .single()
  if (evErr || !ev) throw new Error(`insert event: ${evErr?.message}`)
  eventId = (ev as { id: string }).id

  const { data: inst, error: instErr } = await serviceAdmin
    .from('event_instances')
    .insert({
      event_id: eventId,
      scheduled_at: new Date().toISOString(),
      event_name_snapshot: 'S6T4 Retention Test Event',
      event_name_snapshot_id: null,
      status: 'scheduled',
    })
    .select('id')
    .single()
  if (instErr || !inst) throw new Error(`insert instance: ${instErr?.message}`)
  instanceId = (inst as { id: string }).id
}, 30_000)

afterAll(async () => {
  if (originalRetentionYears !== undefined) {
    await setRetentionYears(originalRetentionYears)
  }

  if (instanceId) {
    await serviceAdmin.from('attendance').delete().eq('event_instance_id', instanceId)
    await serviceAdmin.from('event_invitations').delete().eq('event_instance_id', instanceId)
    await serviceAdmin.from('event_instances').delete().eq('id', instanceId)
  }
  if (eventId) {
    await serviceAdmin.from('events').delete().eq('id', eventId)
  }

  const pIds = Array.from(personIds)
  if (pIds.length) {
    await serviceAdmin.from('audit_log').delete().eq('entity_type', 'people').in('entity_id', pIds)
    await serviceAdmin.from('people').delete().in('id', pIds)
  }

  const uIds = Array.from(userIds)
  if (uIds.length) {
    await serviceAdmin.from('audit_log').delete().in('actor_user_id', uIds)
    await serviceAdmin.from('app_users').delete().in('id', uIds)
    for (const id of uIds) {
      await serviceAdmin.auth.admin.deleteUser(id)
    }
  }
}, 30_000)

// ── 1/2: single scrub via admin path — every tombstone, anonymized_at/updated_at, J invariant ──

describe('anonymize_person via admin path (impl_anonymizePerson)', () => {
  it('scrubs every D4 + T3/gap column, stamps anonymized_at/updated_at, sets deleted_at (J), leaves attendance/event_invitations untouched', async () => {
    const personId = await createPersonFixture({
      photo_url: `${randomUUID()}/${randomUUID()}.jpg`, // Storage-shaped path
    })

    const { data: attRow, error: attErr } = await serviceAdmin
      .from('attendance')
      .insert({
        event_instance_id: instanceId,
        person_id: personId,
        checked_in_by: adminId,
        source: 'volunteer_checkin',
      })
      .select('*')
      .single()
    if (attErr || !attRow) throw new Error(`fixture attendance insert: ${attErr?.message}`)

    const { data: inviteRow, error: inviteErr } = await serviceAdmin
      .from('event_invitations')
      .insert({
        event_instance_id: instanceId,
        person_id: personId,
        invited_by: adminId,
        status: 'pending',
      })
      .select('*')
      .single()
    if (inviteErr || !inviteRow) throw new Error(`fixture invitation insert: ${inviteErr?.message}`)

    const before = new Date()
    const result = await impl_anonymizePerson({
      supabase: adminSession,
      adminSupabase: serviceAdmin,
      input: { personId },
    })
    expect(result.status).toBe('anonymized')

    const after = await getPerson(personId)

    expect(after.full_name).toBe('[anonymized]')
    expect(after.nickname).toBe('[anonymized]')
    expect(after.email).toBeNull()
    expect(after.birth_place).toBeNull()
    expect(after.birth_date).toBeNull()
    expect(after.photo_url).toBeNull()
    expect(after.notes).toBeNull()
    expect(after.current_city).toBeNull()
    expect(after.phone_e164).toMatch(
      /^anon:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(after.photo_consent_state).toBe('unknown')
    expect(after.photo_publish_consent).toBe(false)
    expect(after.photo_consent_at).toBeNull()
    expect(after.photo_consent_version).toBe('v1') // [C] explicitly left untouched
    expect(after.birthday_email_opt_in).toBe(false)
    expect(after.birthday_email_opt_in_at).toBeNull()

    // demographic columns NOT in the D4 scrub list — preserved
    expect(after.id).toBe(personId)

    const anonymizedAt = new Date(after.anonymized_at as string)
    const updatedAt = new Date(after.updated_at as string)
    const deletedAt = new Date(after.deleted_at as string)
    expect(anonymizedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000)
    expect(updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000)
    // [J] was NULL before anonymize -> stamped to (approximately) now
    expect(deletedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000)

    const { data: attAfter } = await serviceAdmin
      .from('attendance')
      .select('*')
      .eq('id', (attRow as { id: string }).id)
      .single()
    expect(attAfter).toEqual(attRow)

    const { data: inviteAfter } = await serviceAdmin
      .from('event_invitations')
      .select('*')
      .eq('id', (inviteRow as { id: string }).id)
      .single()
    expect(inviteAfter).toEqual(inviteRow)

    const audit = await auditRowsFor(personId)
    expect(audit.length).toBe(1)
    expect(audit[0].actor_user_id).toBe(adminId)
    expect(audit[0].entity_type).toBe('people')
    expect(audit[0].details_json).toMatchObject({ trigger: 'admin', photo_disposition: 'storage' })
  })

  it('[J] preserves an existing deleted_at instead of overwriting it', async () => {
    const originalDeletedAt = subDays(new Date(), 30).toISOString()
    const personId = await createPersonFixture({ deleted_at: originalDeletedAt })

    const result = await impl_anonymizePerson({
      supabase: adminSession,
      adminSupabase: serviceAdmin,
      input: { personId },
    })
    expect(result.status).toBe('anonymized')

    const after = await getPerson(personId)
    expect(new Date(after.deleted_at as string).getTime()).toBe(new Date(originalDeletedAt).getTime())
  })

  // ── 3: idempotency ─────────────────────────────────────────────────────────

  it('re-run on an already-anonymized person is a no-op: false, no column change, no 2nd audit row, no phone-unique error', async () => {
    const personId = await createPersonFixture()

    const first = await impl_anonymizePerson({
      supabase: adminSession,
      adminSupabase: serviceAdmin,
      input: { personId },
    })
    expect(first.status).toBe('anonymized')
    const afterFirst = await getPerson(personId)

    const second = await impl_anonymizePerson({
      supabase: adminSession,
      adminSupabase: serviceAdmin,
      input: { personId },
    })
    expect(second.status).toBe('already_anonymized')

    const afterSecond = await getPerson(personId)
    expect(afterSecond).toEqual(afterFirst)

    const audit = await auditRowsFor(personId)
    expect(audit.length).toBe(1)
  })

  // ── 8: E capture — photo_disposition computed at capture time, external URLs never persisted ──

  it('[E] Storage-path person -> disposition storage, reapable_photo_path = the path', async () => {
    const storagePath = `${randomUUID()}/${randomUUID()}.jpg`
    const personId = await createPersonFixture({ photo_url: storagePath })

    await impl_anonymizePerson({
      supabase: adminSession,
      adminSupabase: serviceAdmin,
      input: { personId },
    })

    const audit = await auditRowsFor(personId)
    expect(audit[0].details_json).toMatchObject({
      photo_disposition: 'storage',
      reapable_photo_path: storagePath,
    })
    expect((await getPerson(personId)).photo_url).toBeNull()
  })

  it('[E] Drive-URL person -> disposition external; raw URL is captured NOWHERE in details_json', async () => {
    const driveUrl = 'https://drive.google.com/uc?id=fake-legacy-id'
    const personId = await createPersonFixture({ photo_url: driveUrl })

    await impl_anonymizePerson({
      supabase: adminSession,
      adminSupabase: serviceAdmin,
      input: { personId },
    })

    const audit = await auditRowsFor(personId)
    expect(audit[0].details_json).toMatchObject({
      photo_disposition: 'external',
      reapable_photo_path: null,
    })
    // Negative assertion: the raw identifying URL must not survive anywhere
    // in the audit row, under any key — not just the expected one.
    expect(JSON.stringify(audit[0].details_json)).not.toContain(driveUrl)
    expect((await getPerson(personId)).photo_url).toBeNull()
  })

  it('[E] unrecognized https:// host person -> disposition external too (never falls through to storage)', async () => {
    const unknownHostUrl = 'https://example-cdn.example.com/photo123.jpg'
    const personId = await createPersonFixture({ photo_url: unknownHostUrl })

    await impl_anonymizePerson({
      supabase: adminSession,
      adminSupabase: serviceAdmin,
      input: { personId },
    })

    const audit = await auditRowsFor(personId)
    expect(audit[0].details_json).toMatchObject({
      photo_disposition: 'external',
      reapable_photo_path: null,
    })
    expect(JSON.stringify(audit[0].details_json)).not.toContain(unknownHostUrl)
  })

  it('[E] no-photo person -> disposition none, no path', async () => {
    const personId = await createPersonFixture({ photo_url: null })

    await impl_anonymizePerson({
      supabase: adminSession,
      adminSupabase: serviceAdmin,
      input: { personId },
    })

    const audit = await auditRowsFor(personId)
    expect(audit[0].details_json).toMatchObject({
      photo_disposition: 'none',
      reapable_photo_path: null,
    })
  })

  // ── 7: requireActiveAdmin denial ────────────────────────────────────────────

  it('organizer caller -> not_authorized, target row untouched', async () => {
    const personId = await createPersonFixture()

    const result = await impl_anonymizePerson({
      supabase: organizerSession,
      adminSupabase: serviceAdmin,
      input: { personId },
    })
    expect(result.status).toBe('not_authorized')

    const after = await getPerson(personId)
    expect(after.anonymized_at).toBeNull()
    expect(after.full_name).not.toBe('[anonymized]')

    const audit = await auditRowsFor(personId)
    expect(audit.length).toBe(0)
  })

  it('inactive-admin caller -> not_authorized, target row untouched', async () => {
    const personId = await createPersonFixture()

    const result = await impl_anonymizePerson({
      supabase: inactiveAdminSession,
      adminSupabase: serviceAdmin,
      input: { personId },
    })
    expect(result.status).toBe('not_authorized')

    const after = await getPerson(personId)
    expect(after.anonymized_at).toBeNull()

    const audit = await auditRowsFor(personId)
    expect(audit.length).toBe(0)
  })

  it('non-existent id -> not_found', async () => {
    const result = await impl_anonymizePerson({
      supabase: adminSession,
      adminSupabase: serviceAdmin,
      input: { personId: randomUUID() },
    })
    expect(result.status).toBe('not_found')
  })
})

// ── 4/5/6: run_retention_pass — batch eligibility, F guard, scheduled-path audit actor ──

describe('run_retention_pass (scheduled path)', () => {
  it('anonymizes only eligible rows (soft-deleted past horizon, not already anonymized); N distinct anon:{uuid} phones; ineligible rows untouched', async () => {
    await setRetentionYears(2)

    const eligible = await Promise.all([
      createPersonFixture({ deleted_at: subYears(new Date(), 5).toISOString() }),
      createPersonFixture({ deleted_at: subYears(new Date(), 3).toISOString() }),
      createPersonFixture({ deleted_at: subYears(new Date(), 10).toISOString() }),
    ])
    const activePerson = await createPersonFixture({ deleted_at: null })
    const withinHorizonPerson = await createPersonFixture({
      deleted_at: subDays(new Date(), 10).toISOString(),
    })

    const alreadyAnonPerson = await createPersonFixture({
      deleted_at: subYears(new Date(), 5).toISOString(),
    })
    await impl_anonymizePerson({
      supabase: adminSession,
      adminSupabase: serviceAdmin,
      input: { personId: alreadyAnonPerson },
    })

    const { data: count, error } = await serviceAdmin.rpc('run_retention_pass', {
      p_actor_user_id: null,
    })
    expect(error).toBeNull()
    expect(count as number).toBeGreaterThanOrEqual(eligible.length)

    const afterEligible = await Promise.all(eligible.map(getPerson))
    for (const p of afterEligible) {
      expect(p.anonymized_at).not.toBeNull()
      expect(p.full_name).toBe('[anonymized]')
    }
    const phones = afterEligible.map((p) => p.phone_e164 as string)
    expect(new Set(phones).size).toBe(phones.length) // all distinct
    for (const phone of phones) {
      expect(phone).toMatch(/^anon:[0-9a-f-]{36}$/)
    }

    const afterActive = await getPerson(activePerson)
    expect(afterActive.anonymized_at).toBeNull()

    const afterWithinHorizon = await getPerson(withinHorizonPerson)
    expect(afterWithinHorizon.anonymized_at).toBeNull()

    // already-anonymized: unchanged, still exactly 1 audit row (no re-scrub, no 2nd audit)
    const alreadyAnonAudit = await auditRowsFor(alreadyAnonPerson)
    expect(alreadyAnonAudit.length).toBe(1)

    // scheduled-path audit rows: actor NULL, correct trigger
    for (const personId of eligible) {
      const audit = await auditRowsFor(personId)
      expect(audit.length).toBe(1)
      expect(audit[0].actor_user_id).toBeNull()
      expect(audit[0].details_json).toMatchObject({ trigger: 'scheduled_retention_pass' })
    }
  }, 30_000)

  it('[F] retention_archive_years IS NULL -> returns 0, nobody touched', async () => {
    await setRetentionYears(null)

    const eligibleShapedPerson = await createPersonFixture({
      deleted_at: subYears(new Date(), 20).toISOString(),
    })

    const { data: count, error } = await serviceAdmin.rpc('run_retention_pass', {
      p_actor_user_id: null,
    })
    expect(error).toBeNull()
    expect(count).toBe(0)

    const after = await getPerson(eligibleShapedPerson)
    expect(after.anonymized_at).toBeNull()
  })

  it('[F] retention_archive_years <= 0 -> returns 0, nobody touched (not "anonymize on soft-delete")', async () => {
    await setRetentionYears(0)

    const justSoftDeletedPerson = await createPersonFixture({
      deleted_at: new Date().toISOString(),
    })

    const { data: count, error } = await serviceAdmin.rpc('run_retention_pass', {
      p_actor_user_id: null,
    })
    expect(error).toBeNull()
    expect(count).toBe(0)

    const after = await getPerson(justSoftDeletedPerson)
    expect(after.anonymized_at).toBeNull()

    await setRetentionYears(-1)
    const { data: count2, error: error2 } = await serviceAdmin.rpc('run_retention_pass', {
      p_actor_user_id: null,
    })
    expect(error2).toBeNull()
    expect(count2).toBe(0)
  })
})
