// Integration tests for Sprint 5 Task 8 — Settings "Run now" triggers for the
// birthday digest and attendance summary. Runs against local Docker Supabase.
// Proves three things end to end, against real Postgres (not mocks):
//   1. requireActiveAdmin gates BEFORE any send — non-admin and deactivated-
//      admin callers get zero calls to the injected sendMessage stub.
//   2. The manual trigger shares the SAME (source, ict_date) claim slot as
//      the T5 scheduled cron — a second "run now" for the same day hits
//      skipped_already_sent, sendMessage called zero additional times. This
//      is the idempotency-surfacing proof the task exists to demonstrate; the
//      claim state machine itself is T5's (tests/integration/cron-idempotent-
//      claim.test.ts, birthday-digest.test.ts, attendance-summary.test.ts) —
//      not re-proven here.
//   3. Every outcome (including skips) writes exactly one audit_log row via
//      the new AUDIT_ACTIONS entries.
//
// Fixture phone space: +62999009108xxx (T8 — distinct from T5's 105xxx/106xxx
// and T6's 102xxx, see export-actions.test.ts's space registry comment).
// Fixed clock dates (2026-12-03 / 2026-12-04) are distinct from T5's own
// 2026-11-19 fixture date to avoid a (source, ict_date) UNIQUE collision if
// vitest runs this file in parallel with T5's cron impl test files against
// the same shared local DB.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { randomUUID } from 'crypto'
import { impl_runBirthdayDigestNow, impl_runAttendanceSummaryNow } from '@/lib/actions/digest-triggers.impl'
import { BIRTHDAY_DIGEST_SOURCE } from '@/lib/events/birthday-digest.impl'
import { ATTENDANCE_SUMMARY_SOURCE } from '@/lib/events/attendance-summary.impl'
import type { SendTelegramMessageResult } from '@/lib/telegram/client'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !anonKey || !serviceRoleKey) {
  throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY')
}

const PROD_PROJECT_REF = 'bftifxgdcmisasgvobuf'
if (url.includes(PROD_PROJECT_REF)) {
  throw new Error(
    `[digest-triggers.test.ts] NEXT_PUBLIC_SUPABASE_URL resolves to the PRODUCTION project ` +
      `(${PROD_PROJECT_REF}). This suite creates/deletes real auth users and sends fake Telegram ` +
      `sends via a stub — must run against local Docker only.`,
  )
}

const DIGEST_NOW = new Date('2026-12-03T00:30:00.000Z') // 2026-12-03 07:30 ICT
const DIGEST_TODAY_ICT = '2026-12-03'

const SUMMARY_NOW = new Date('2026-12-04T16:30:00.000Z') // 23:30 ICT, reports 2026-12-04
const SUMMARY_TODAY_ICT = '2026-12-04'

let serviceAdmin: SupabaseClient
let originalChatId: string | null
let eventId: string
const ts = Date.now()

const authUserIds: Set<string> = new Set()
const personIds: Set<string> = new Set()
const instanceIds: Set<string> = new Set()
const attendanceIds: Set<string> = new Set()
const healthIds: Set<string> = new Set()

async function createAppUserFixture(
  label: string,
  role: 'admin' | 'organizer',
  active = true,
): Promise<{ id: string; session: SupabaseClient }> {
  const email = `s8-digest-${label}-${randomUUID()}@test.invalid`
  const pass = `S8DigestPass-${label}-${ts}!`
  const { data: authData, error: authErr } = await serviceAdmin.auth.admin.createUser({
    email,
    password: pass,
    email_confirm: true,
  })
  if (authErr || !authData.user) throw new Error(`createUser (${label}): ${authErr?.message}`)
  authUserIds.add(authData.user.id)

  const { error: appErr } = await serviceAdmin
    .from('app_users')
    .insert({ id: authData.user.id, email, full_name: `S8 Digest Test ${label}`, role, active })
  if (appErr) throw new Error(`insert app_user (${label}): ${appErr.message}`)

  const session = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { error: signInErr } = await session.auth.signInWithPassword({ email, password: pass })
  if (signInErr) throw new Error(`sign-in (${label}): ${signInErr.message}`)
  return { id: authData.user.id, session }
}

async function insertPerson(attrs: Record<string, unknown>): Promise<string> {
  const { data, error } = await serviceAdmin.from('people').insert(attrs).select('id').single()
  if (error || !data) throw new Error(`insert person: ${error?.message}`)
  personIds.add(data.id as string)
  return data.id as string
}

async function insertInstance(attrs: Record<string, unknown>): Promise<string> {
  const { data, error } = await serviceAdmin
    .from('event_instances')
    .insert({ event_id: eventId, event_name_snapshot: 'S8 Test Event', event_name_snapshot_id: null, ...attrs })
    .select('id')
    .single()
  if (error || !data) throw new Error(`insert event_instance: ${error?.message}`)
  instanceIds.add(data.id as string)
  return data.id as string
}

async function insertAttendance(instanceId: string, personId: string, checkedInAt: string, actorId: string) {
  const { data, error } = await serviceAdmin
    .from('attendance')
    .insert({ event_instance_id: instanceId, person_id: personId, checked_in_at: checkedInAt, checked_in_by: actorId })
    .select('id')
    .single()
  if (error || !data) throw new Error(`insert attendance: ${error?.message}`)
  attendanceIds.add(data.id as string)
}

async function readAuditRows(action: string, ictDate: string) {
  const { data, error } = await serviceAdmin
    .from('audit_log')
    .select('actor_user_id, entity_type, entity_id, details_json')
    .eq('action', action)
    .eq('entity_type', 'system_health')
    .ilike('entity_id', `%:${ictDate}`)
  if (error) throw new Error(`audit_log select failed: ${error.message}`)
  return data ?? []
}

type SendMessageFn = (params: { token: string; chatId: string; text: string }) => Promise<SendTelegramMessageResult>

function stubOk(messageId: number) {
  return vi.fn<SendMessageFn>().mockResolvedValue({ ok: true, messageId })
}

let adminId: string
let adminSession: SupabaseClient
let organizerSession: SupabaseClient

// The claim rows this file's happy-path tests write via the real impl (not
// via insertHealthRow, so they're never in `healthIds`) MUST be deleted, not
// just the fixture rows above — their fixed future checked_at (2026-12-03/04)
// otherwise sorts as the globally "latest" system_health row by any other
// test file's `order('checked_at', { ascending: false }).limit(1)` query
// (e.g. events-materialize.test.ts MAT-08), breaking it on a later run.
// Called in both beforeAll (idempotent safety if a prior run crashed before
// its own afterAll) and afterAll.
async function cleanupClaimRows() {
  await serviceAdmin
    .from('system_health')
    .delete()
    .eq('source', BIRTHDAY_DIGEST_SOURCE)
    .eq('ict_date', DIGEST_TODAY_ICT)
  await serviceAdmin
    .from('system_health')
    .delete()
    .eq('source', ATTENDANCE_SUMMARY_SOURCE)
    .eq('ict_date', SUMMARY_TODAY_ICT)
}

beforeAll(async () => {
  serviceAdmin = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })
  await cleanupClaimRows()

  const admin = await createAppUserFixture('admin', 'admin')
  adminId = admin.id
  adminSession = admin.session

  const organizer = await createAppUserFixture('organizer', 'organizer')
  organizerSession = organizer.session

  const { data: settings } = await serviceAdmin
    .from('app_settings')
    .select('telegram_admin_chat_id')
    .limit(1)
    .maybeSingle()
  originalChatId = (settings as { telegram_admin_chat_id: string | null } | null)?.telegram_admin_chat_id ?? null
  await serviceAdmin.from('app_settings').update({ telegram_admin_chat_id: '111111111' }).eq('id', 1)

  const { data: ev, error: evErr } = await serviceAdmin
    .from('events')
    .insert({
      name: 'S8 Test Event',
      event_type: 'adhoc',
      start_date: '2026-12-04',
      start_time: '18:00:00',
      active: true,
      created_by: adminId,
    })
    .select('id')
    .single()
  if (evErr || !ev) throw new Error(`insert event: ${evErr?.message}`)
  eventId = (ev as { id: string }).id
}, 30_000)

afterAll(async () => {
  await cleanupClaimRows()
  await serviceAdmin.from('app_settings').update({ telegram_admin_chat_id: originalChatId }).eq('id', 1)
  if (eventId) {
    await serviceAdmin.from('event_instances').delete().eq('event_id', eventId)
    await serviceAdmin.from('events').delete().eq('id', eventId)
  }
  const userIds = Array.from(authUserIds)
  if (userIds.length > 0) {
    await serviceAdmin.from('audit_log').delete().in('actor_user_id', userIds)
    await serviceAdmin.from('app_users').delete().in('id', userIds)
    for (const id of userIds) {
      await serviceAdmin.auth.admin.deleteUser(id)
    }
  }
}, 30_000)

afterEach(async () => {
  if (attendanceIds.size > 0) {
    await serviceAdmin.from('attendance').delete().in('id', Array.from(attendanceIds))
    attendanceIds.clear()
  }
  if (personIds.size > 0) {
    await serviceAdmin.from('people').delete().in('id', Array.from(personIds))
    personIds.clear()
  }
  if (instanceIds.size > 0) {
    await serviceAdmin.from('event_instances').delete().in('id', Array.from(instanceIds))
    instanceIds.clear()
  }
  if (healthIds.size > 0) {
    await serviceAdmin.from('system_health').delete().in('id', Array.from(healthIds))
    healthIds.clear()
  }
})

// ── privilege gate — before any send ─────────────────────────────────────────

describe('privilege gate: non-admin and inactive-admin denied, zero sends', () => {
  it('runBirthdayDigestNow: organizer caller -> not_authorized, sendMessage never called', async () => {
    const sendMessage = stubOk(1)
    const result = await impl_runBirthdayDigestNow({
      supabase: organizerSession,
      adminSupabase: serviceAdmin,
      now: DIGEST_NOW,
      sendMessage,
    })
    expect(result).toEqual({ status: 'not_authorized' })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('runBirthdayDigestNow: deactivated admin caller -> not_authorized, sendMessage never called', async () => {
    const deactivated = await createAppUserFixture('deactivated-digest', 'admin', false)
    const sendMessage = stubOk(1)
    const result = await impl_runBirthdayDigestNow({
      supabase: deactivated.session,
      adminSupabase: serviceAdmin,
      now: DIGEST_NOW,
      sendMessage,
    })
    expect(result).toEqual({ status: 'not_authorized' })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('runAttendanceSummaryNow: organizer caller -> not_authorized, sendMessage never called', async () => {
    const sendMessage = stubOk(1)
    const result = await impl_runAttendanceSummaryNow({
      supabase: organizerSession,
      adminSupabase: serviceAdmin,
      now: SUMMARY_NOW,
      sendMessage,
    })
    expect(result).toEqual({ status: 'not_authorized' })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('runAttendanceSummaryNow: deactivated admin caller -> not_authorized, sendMessage never called', async () => {
    const deactivated = await createAppUserFixture('deactivated-summary', 'admin', false)
    const sendMessage = stubOk(1)
    const result = await impl_runAttendanceSummaryNow({
      supabase: deactivated.session,
      adminSupabase: serviceAdmin,
      now: SUMMARY_NOW,
      sendMessage,
    })
    expect(result).toEqual({ status: 'not_authorized' })
    expect(sendMessage).not.toHaveBeenCalled()
  })
})

// ── birthday digest: happy path + idempotency + audit ────────────────────────

describe('impl_runBirthdayDigestNow — happy path, second click is a no-op, audited both times', () => {
  it('first click sends and audits; second click for the same day skips, zero additional sends, still audits', async () => {
    await insertPerson({
      phone_e164: '+62999009108001',
      full_name: 'S8 Birthday Person',
      nickname: 'S8B',
      birth_date: '1990-12-03',
      photo_publish_consent: true,
    })

    const firstSend = stubOk(501)
    const first = await impl_runBirthdayDigestNow({
      supabase: adminSession,
      adminSupabase: serviceAdmin,
      now: DIGEST_NOW,
      sendMessage: firstSend,
      getToken: () => 'test-token',
    })
    expect(first).toEqual({ status: 'sent', ict_date: DIGEST_TODAY_ICT, count: 1, message_id: 501 })
    expect(firstSend).toHaveBeenCalledOnce()

    const secondSend = stubOk(502)
    const second = await impl_runBirthdayDigestNow({
      supabase: adminSession,
      adminSupabase: serviceAdmin,
      now: DIGEST_NOW,
      sendMessage: secondSend,
      getToken: () => 'test-token',
    })
    expect(second).toEqual({ status: 'skipped_already_sent', ict_date: DIGEST_TODAY_ICT })
    expect(secondSend).not.toHaveBeenCalled() // the idempotency-surfacing proof

    const auditRows = await readAuditRows('birthday_digest.manual_trigger', DIGEST_TODAY_ICT)
    expect(auditRows).toHaveLength(2) // audited on every outcome, including the skip
    expect(auditRows.every((r) => r.actor_user_id === adminId)).toBe(true)
    expect(auditRows.map((r) => (r.details_json as { status: string }).status).sort()).toEqual(
      ['sent', 'skipped_already_sent'].sort(),
    )
  })
})

// ── attendance summary: happy path + idempotency + flip + audit ──────────────

describe('impl_runAttendanceSummaryNow — happy path, second click is a no-op, flip note, audited both times', () => {
  it('first click sends (and flips the past instance); second click for the same day skips, zero additional sends', async () => {
    const instanceId = await insertInstance({ scheduled_at: '2026-12-04T11:00:00.000Z', status: 'scheduled' })
    const personId = await insertPerson({ phone_e164: '+62999009108002', full_name: 'S8 Attendee', nickname: 'S8A' })
    await insertAttendance(instanceId, personId, '2026-12-03T18:00:00.000Z', adminId)

    const firstSend = stubOk(601)
    const first = await impl_runAttendanceSummaryNow({
      supabase: adminSession,
      adminSupabase: serviceAdmin,
      now: SUMMARY_NOW,
      sendMessage: firstSend,
      getToken: () => 'test-token',
    })
    expect(first).toEqual({
      status: 'sent',
      ict_date: SUMMARY_TODAY_ICT,
      count: 1,
      message_id: 601,
      flipped_count: 1,
    })
    expect(firstSend).toHaveBeenCalledOnce()

    const { data: instRow } = await serviceAdmin.from('event_instances').select('status').eq('id', instanceId).single()
    expect(instRow?.status).toBe('completed')

    const secondSend = stubOk(602)
    const second = await impl_runAttendanceSummaryNow({
      supabase: adminSession,
      adminSupabase: serviceAdmin,
      now: SUMMARY_NOW,
      sendMessage: secondSend,
      getToken: () => 'test-token',
    })
    // flipped_count is 0 on the second click — the instance is already 'completed',
    // so it no longer matches flipCompletedInstances' status='scheduled' predicate.
    expect(second).toEqual({ status: 'skipped_already_sent', ict_date: SUMMARY_TODAY_ICT, flipped_count: 0 })
    expect(secondSend).not.toHaveBeenCalled() // the idempotency-surfacing proof

    const auditRows = await readAuditRows('attendance_summary.manual_trigger', SUMMARY_TODAY_ICT)
    expect(auditRows).toHaveLength(2)
    expect(auditRows.every((r) => r.actor_user_id === adminId)).toBe(true)
    expect(auditRows.map((r) => (r.details_json as { status: string }).status).sort()).toEqual(
      ['sent', 'skipped_already_sent'].sort(),
    )
  })
})
