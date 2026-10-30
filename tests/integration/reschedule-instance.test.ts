// Integration tests for S9.5-T4 — public.reschedule_instance() (design R2):
// cancel one future occurrence of a recurring event + insert a one-off on the
// same event, in one transaction, admin-only, with one audit row. Covers the
// happy path, every guard (refuses and writes nothing), organizer/anon refusal,
// atomicity (forced failure after the cancel), the action layer against the
// real RPC, the materializer after a reschedule, and the downstream paths
// (check-in picker, RSVP mint, invitations, completion flip).
//
// Runs against local Docker Supabase (.env.test.local); needs migration
// 20261030120000_s9_5_t4_reschedule_instance.sql applied. The SQL guards use
// the DB's real now(), so fixtures are placed relative to the real clock.
// Run: npm test -- reschedule-instance

import { execFileSync } from 'node:child_process'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { addDays, addMonths } from 'date-fns'
import { materializeEvents } from '@/lib/events/materialize.impl'
import { flipCompletedInstances } from '@/lib/events/attendance-summary.impl'
import { formatJakarta } from '@/lib/events/timezone'
import { impl_rescheduleInstance, impl_listNearestInstances } from '@/lib/actions/events.impl'
import { impl_getOrCreateRsvpLink } from '@/lib/rsvp/admin.impl'
import { impl_sendInvites } from '@/lib/actions/invites.impl'
import type { EmailTransport, EmailMessage, SendEmailResult } from '@/lib/email/transport'

vi.mock('server-only', () => ({}))

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !anonKey || !serviceRoleKey) {
  throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY')
}

const PROD_PROJECT_REF = 'bftifxgdcmisasgvobuf'
if (url.includes(PROD_PROJECT_REF)) {
  throw new Error(
    `[reschedule-instance.test.ts] NEXT_PUBLIC_SUPABASE_URL resolves to the PRODUCTION project ` +
      `(${PROD_PROJECT_REF}). This file adds a temporary trigger and runs the global ` +
      `materializer + completion flip — local Docker only.`,
  )
}

const DB_CONTAINER = 'supabase_db_project37-rewrite'
const FN = 'public.reschedule_instance(uuid,timestamptz,text)'
const TRIGGER_FN = 'public.s95t4_test_fail_insert'

function psql(sql: string): string {
  return execFileSync(
    'docker',
    ['exec', DB_CONTAINER, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atc', sql],
    { encoding: 'utf8' },
  ).trim()
}

const ts = Date.now()
const TRIBE = `S95T4-${ts}`
const EMAIL_IDENTITY = { organizerEmail: 'organizer@test.invalid', fromName: 'Test', replyTo: 'reply@test.invalid' }
const REASON = 'Venue unavailable'

let svc: SupabaseClient
let adminSession: SupabaseClient
let organizerSession: SupabaseClient
let anonClient: SupabaseClient
const userIds: string[] = []
const eventIds: string[] = []
let adminId: string
let personId: string

let recurringEventId: string
let adhocEventId: string
let inactiveEventId: string

type InstanceRow = {
  id: string
  event_id: string
  scheduled_at: string
  event_name_snapshot: string
  event_name_snapshot_id: string | null
  status: string
  notes: string | null
}

async function instancesOf(eventId: string): Promise<InstanceRow[]> {
  const { data, error } = await svc
    .from('event_instances')
    .select('id, event_id, scheduled_at, event_name_snapshot, event_name_snapshot_id, status, notes')
    .eq('event_id', eventId)
    .order('scheduled_at', { ascending: true })
  if (error) throw new Error(`read instances: ${error.message}`)
  return (data ?? []) as InstanceRow[]
}

/** Untouched materialized rule slots, more than an hour ahead (guard fixtures excluded). */
async function freshSlots(): Promise<InstanceRow[]> {
  const cutoff = Date.now() + 3_600_000
  return (await instancesOf(recurringEventId)).filter(r =>
    r.status === 'scheduled' && r.notes === null &&
    r.event_name_snapshot.startsWith('[SYNTH]') && Date.parse(r.scheduled_at) > cutoff)
}

async function instanceById(id: string): Promise<InstanceRow> {
  const { data, error } = await svc
    .from('event_instances')
    .select('id, event_id, scheduled_at, event_name_snapshot, event_name_snapshot_id, status, notes')
    .eq('id', id)
    .single()
  if (error || !data) throw new Error(`read instance ${id}: ${error?.message}`)
  return data as InstanceRow
}

async function rescheduleAuditCount(): Promise<number> {
  const { count, error } = await svc
    .from('audit_log')
    .select('*', { count: 'exact', head: true })
    .eq('action', 'event_instance.reschedule')
  if (error) throw new Error(`count audit: ${error.message}`)
  return count ?? 0
}

/** Everything a refusal must leave untouched. */
async function snapshot(): Promise<string> {
  const [rec, adhoc, inactive, audits] = await Promise.all([
    instancesOf(recurringEventId),
    instancesOf(adhocEventId),
    instancesOf(inactiveEventId),
    rescheduleAuditCount(),
  ])
  return JSON.stringify({ rec, adhoc, inactive, audits })
}

async function insertInstance(eventId: string, scheduledAt: Date, status: 'scheduled' | 'cancelled' | 'completed'): Promise<string> {
  const { data, error } = await svc
    .from('event_instances')
    .insert({ event_id: eventId, scheduled_at: scheduledAt.toISOString(), event_name_snapshot: `S95T4 ${ts}`, status })
    .select('id')
    .single()
  if (error || !data) throw new Error(`insert instance: ${error?.message}`)
  return (data as { id: string }).id
}

async function insertEvent(label: string, fields: Record<string, unknown>): Promise<string> {
  const { data, error } = await svc
    .from('events')
    .insert({
      name: `[SYNTH] S95T4 ${label} ${ts}`,
      name_id: `[SYNTH] S95T4 ${label} ID ${ts}`,
      start_time: '15:00:00',
      duration_min: 180,
      location: 'Test Hall',
      created_by: adminId,
      ...fields,
    })
    .select('id')
    .single()
  if (error || !data) throw new Error(`insert event ${label}: ${error?.message}`)
  eventIds.push((data as { id: string }).id)
  return (data as { id: string }).id
}

async function makeUser(role: 'admin' | 'organizer'): Promise<{ id: string; session: SupabaseClient }> {
  const email = `s95t4-${role}-${ts}@test.invalid`
  const password = `S95T4Pass-${ts}!`
  const { data, error } = await svc.auth.admin.createUser({ email, password, email_confirm: true })
  if (error || !data.user) throw new Error(`createUser ${role}: ${error?.message}`)
  userIds.push(data.user.id)
  const { error: appErr } = await svc
    .from('app_users')
    .insert({ id: data.user.id, email, full_name: `S95T4 ${role}`, role, active: true })
  if (appErr) throw new Error(`insert app_user ${role}: ${appErr.message}`)
  const session = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { error: signInErr } = await session.auth.signInWithPassword({ email, password })
  if (signInErr) throw new Error(`sign-in ${role}: ${signInErr.message}`)
  return { id: data.user.id, session }
}

async function rpc(client: SupabaseClient, instanceId: string | null, newAt: Date | null, reason: string | null) {
  return client.rpc('reschedule_instance', {
    p_instance_id: instanceId,
    p_new_at: newAt ? newAt.toISOString() : null,
    p_reason: reason,
  })
}

function wibNote(prefix: 'to' | 'from', at: string | Date, reason: string): string {
  const d = typeof at === 'string' ? new Date(at) : at
  return `Rescheduled ${prefix} ${formatJakarta(d, 'yyyy-MM-dd HH:mm')} WIB: ${reason}`
}

function makeCountingTransport(): { transport: EmailTransport; calls: () => number } {
  let n = 0
  return {
    transport: {
      async send(msg: EmailMessage): Promise<SendEmailResult> {
        n++
        return { ok: true, messageId: `stub-${msg.to}`, response: '250 OK (stub)' }
      },
    },
    calls: () => n,
  }
}

const ORIGINAL_FLAG = process.env.RSVP_PUBLIC_ENABLED
const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL
function setEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

beforeAll(async () => {
  svc = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })
  anonClient = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })

  const admin = await makeUser('admin')
  adminId = admin.id
  adminSession = admin.session
  organizerSession = (await makeUser('organizer')).session

  // 2nd-Saturday series starting next month, like the S9.5-T2 Saturday Project Day.
  const firstOfNextMonth = formatJakarta(addMonths(new Date(), 1), 'yyyy-MM-01')
  recurringEventId = await insertEvent('Saturday', {
    event_type: 'saturday_monthly',
    start_date: firstOfNextMonth,
    recurrence_rule: 'FREQ=MONTHLY;BYDAY=2SA',
    active: true,
  })
  adhocEventId = await insertEvent('Adhoc', { event_type: 'adhoc', start_date: firstOfNextMonth, active: true })
  inactiveEventId = await insertEvent('Inactive', {
    event_type: 'saturday_monthly',
    start_date: firstOfNextMonth,
    recurrence_rule: 'FREQ=MONTHLY;BYDAY=2SA',
    active: false,
  })

  // Warm-up run: brings every active event (fixtures + local seed) up to date
  // so later runs can assert instances_inserted === 0.
  await materializeEvents({ supabase: svc, now: new Date() })
  const rule = await instancesOf(recurringEventId)
  if (rule.length < 6) throw new Error(`expected a materialized series, got ${rule.length}`)

  const { data: person, error: personErr } = await svc
    .from('people')
    .insert({
      phone_e164: `+62999${ts.toString().slice(-8)}`,
      full_name: '[SYNTH] S95T4 Person',
      nickname: 's',
      tribe: TRIBE,
      email: `s95t4-person-${ts}@test.invalid`,
    })
    .select('id')
    .single()
  if (personErr || !person) throw new Error(`insert person: ${personErr?.message}`)
  personId = (person as { id: string }).id

  setEnv('RSVP_PUBLIC_ENABLED', 'true')
  setEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000')
}, 60_000)

afterAll(async () => {
  setEnv('RSVP_PUBLIC_ENABLED', ORIGINAL_FLAG)
  setEnv('NEXT_PUBLIC_APP_URL', ORIGINAL_APP_URL)
  psql(`DROP TRIGGER IF EXISTS s95t4_test_fail_insert ON public.event_instances; DROP FUNCTION IF EXISTS ${TRIGGER_FN}();`)
  // Events cascade to instances → invitations, RSVP links, RSVPs.
  if (eventIds.length) await svc.from('events').delete().in('id', eventIds)
  if (personId) await svc.from('people').delete().eq('id', personId)
  if (userIds.length) {
    await svc.from('audit_log').delete().in('actor_user_id', userIds)
    await svc.from('app_users').delete().in('id', userIds)
    for (const id of userIds) await svc.auth.admin.deleteUser(id)
  }
}, 60_000)

// ── SQL: happy path ──────────────────────────────────────────────────────────

describe('reschedule_instance — happy path', () => {
  let originalId: string
  let newId: string
  let newAt: Date
  let originalAt: string

  it('RS-01: admin reschedules a future rule slot → original cancelled, one-off inserted, one audit row', async () => {
    const original = (await freshSlots())[1]
    originalId = original.id
    originalAt = original.scheduled_at
    newAt = addDays(new Date(original.scheduled_at), 7) // 3rd Saturday, same 15:00 WIB — not a rule slot
    const auditsBefore = await rescheduleAuditCount()

    const { data, error } = await rpc(adminSession, originalId, newAt, `  ${REASON}  `)
    expect(error).toBeNull()
    expect(typeof data).toBe('string')
    newId = data as string
    expect(newId).not.toBe(originalId)

    const orig = await instanceById(originalId)
    expect(orig.status).toBe('cancelled')
    expect(orig.scheduled_at).toBe(original.scheduled_at) // keeps its slot
    expect(orig.notes).toBe(wibNote('to', newAt, REASON))

    const { data: ev } = await svc.from('events').select('name, name_id').eq('id', recurringEventId).single()
    const created = await instanceById(newId)
    expect(created).toMatchObject({
      event_id: recurringEventId,
      event_name_snapshot: (ev as { name: string }).name,
      event_name_snapshot_id: (ev as { name_id: string }).name_id,
      status: 'scheduled',
      notes: wibNote('from', originalAt, REASON),
    })
    expect(new Date(created.scheduled_at).getTime()).toBe(newAt.getTime())
    expect(formatJakarta(new Date(created.scheduled_at), 'i HH:mm')).toBe('6 15:00')

    expect(await rescheduleAuditCount()).toBe(auditsBefore + 1)
  })

  it('RS-02: audit row shape — real admin actor, entity = original, details {from/to ids, from/to at, reason}', async () => {
    const { data, error } = await svc
      .from('audit_log')
      .select('actor_user_id, action, entity_type, entity_id, details_json')
      .eq('action', 'event_instance.reschedule')
      .eq('entity_id', originalId)
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    const row = data![0] as {
      actor_user_id: string; action: string; entity_type: string; entity_id: string
      details_json: Record<string, unknown>
    }
    expect(row.actor_user_id).toBe(adminId)
    expect(row.entity_type).toBe('event_instance')
    expect(Object.keys(row.details_json).sort()).toEqual(['from_at', 'from_instance_id', 'reason', 'to_at', 'to_instance_id'])
    expect(row.details_json.from_instance_id).toBe(originalId)
    expect(row.details_json.to_instance_id).toBe(newId)
    expect(new Date(row.details_json.from_at as string).getTime()).toBe(new Date(originalAt).getTime())
    expect(new Date(row.details_json.to_at as string).getTime()).toBe(newAt.getTime())
    expect(row.details_json.reason).toBe(REASON)
  })

  it('RS-03: the one-off itself can be rescheduled again (it is a scheduled future occurrence of a recurring event)', async () => {
    const again = addDays(newAt, 1)
    const { data, error } = await rpc(adminSession, newId, again, 'Second move')
    expect(error).toBeNull()
    expect((await instanceById(newId)).status).toBe('cancelled')
    expect((await instanceById(data as string)).status).toBe('scheduled')
  })

  // ── Materializer after reschedule ──────────────────────────────────────────

  it('MAT-RS-01: materializer after reschedule → inserted 0, cancelled slot not recreated, one-off not pruned; second run still 0', async () => {
    const before = await instancesOf(recurringEventId)

    const first = await materializeEvents({ supabase: svc, now: new Date() })
    expect(first.events_with_errors).toEqual([])
    expect(first.instances_inserted).toBe(0)
    const afterFirst = await instancesOf(recurringEventId)
    expect(afterFirst).toEqual(before)
    // The cancelled original still owns its slot — exactly one row there.
    expect(afterFirst.filter(r => r.scheduled_at === originalAt)).toHaveLength(1)
    expect(afterFirst.find(r => r.id === originalId)?.status).toBe('cancelled')

    const second = await materializeEvents({ supabase: svc, now: new Date() })
    expect(second.instances_inserted).toBe(0)
    expect(await instancesOf(recurringEventId)).toEqual(before)
  })
})

// ── SQL: guards — each refuses and writes nothing ────────────────────────────

describe('reschedule_instance — guards (typed refusal, nothing written)', () => {
  async function expectRefusal(client: SupabaseClient, instanceId: string | null, newAt: Date | null, reason: string | null, code: string) {
    const before = await snapshot()
    const { data, error } = await rpc(client, instanceId, newAt, reason)
    expect(data).toBeNull()
    expect(error?.message).toBe(`reschedule:${code}`)
    expect(error?.code).toBe('P0001')
    expect(await snapshot()).toBe(before)
  }

  async function futureRuleSlot(index: number): Promise<InstanceRow> {
    return (await freshSlots())[index]
  }

  it('G-01: organizer → not_admin', async () => {
    const slot = await futureRuleSlot(2)
    await expectRefusal(organizerSession, slot.id, addDays(new Date(slot.scheduled_at), 1), REASON, 'not_admin')
  })

  it('G-02: anon has no EXECUTE → permission denied, nothing written', async () => {
    const slot = await futureRuleSlot(2)
    const before = await snapshot()
    const { error } = await rpc(anonClient, slot.id, addDays(new Date(slot.scheduled_at), 1), REASON)
    expect(error?.code).toBe('42501')
    expect(await snapshot()).toBe(before)
  })

  it('G-03: unknown instance → not_found', async () => {
    await expectRefusal(adminSession, '00000000-0000-4000-8000-000000000000', addDays(new Date(), 3), REASON, 'not_found')
  })

  it('G-04: cancelled original → not_scheduled', async () => {
    const id = await insertInstance(recurringEventId, addDays(new Date(), 40), 'cancelled')
    await expectRefusal(adminSession, id, addDays(new Date(), 41), REASON, 'not_scheduled')
  })

  it('G-05: completed original → not_scheduled', async () => {
    const id = await insertInstance(recurringEventId, addDays(new Date(), 42), 'completed')
    await expectRefusal(adminSession, id, addDays(new Date(), 43), REASON, 'not_scheduled')
  })

  it('G-06: original already started (scheduled_at <= now) → original_in_past', async () => {
    const id = await insertInstance(recurringEventId, new Date(Date.now() - 3_600_000), 'scheduled')
    await expectRefusal(adminSession, id, addDays(new Date(), 2), REASON, 'original_in_past')
  })

  it('G-07: inactive event → event_inactive', async () => {
    const id = await insertInstance(inactiveEventId, addDays(new Date(), 20), 'scheduled')
    await expectRefusal(adminSession, id, addDays(new Date(), 21), REASON, 'event_inactive')
  })

  it('G-08: adhoc event → not_recurring', async () => {
    const id = await insertInstance(adhocEventId, addDays(new Date(), 20), 'scheduled')
    await expectRefusal(adminSession, id, addDays(new Date(), 21), REASON, 'not_recurring')
  })

  it('G-09: new time in the past → new_in_past', async () => {
    const slot = await futureRuleSlot(2)
    await expectRefusal(adminSession, slot.id, new Date(Date.now() - 60_000), REASON, 'new_in_past')
  })

  it('G-10: new time beyond now + horizon months → beyond_horizon', async () => {
    const slot = await futureRuleSlot(2)
    const { data: s } = await svc.from('app_settings').select('materialization_horizon_mo').limit(1).single()
    const horizon = (s as { materialization_horizon_mo: number | null }).materialization_horizon_mo ?? 12
    await expectRefusal(adminSession, slot.id, addDays(addMonths(new Date(), horizon), 1), REASON, 'beyond_horizon')
  })

  it('G-11: new time equal to the original → same_time', async () => {
    const slot = await futureRuleSlot(2)
    await expectRefusal(adminSession, slot.id, new Date(slot.scheduled_at), REASON, 'same_time')
  })

  it('G-12: another instance of the same event already at the new time → slot_taken', async () => {
    const slot = await futureRuleSlot(2)
    const other = await futureRuleSlot(3)
    await expectRefusal(adminSession, slot.id, new Date(other.scheduled_at), REASON, 'slot_taken')
  })

  it('G-13: blank reason → reason_required; NULL reason → reason_required', async () => {
    const slot = await futureRuleSlot(2)
    await expectRefusal(adminSession, slot.id, addDays(new Date(slot.scheduled_at), 1), '   ', 'reason_required')
    await expectRefusal(adminSession, slot.id, addDays(new Date(slot.scheduled_at), 1), null, 'reason_required')
  })

  it('G-14: 501-character reason → reason_too_long', async () => {
    const slot = await futureRuleSlot(2)
    await expectRefusal(adminSession, slot.id, addDays(new Date(slot.scheduled_at), 1), 'x'.repeat(501), 'reason_too_long')
  })

  it('G-15: NULL instance id or NULL new time → invalid_input', async () => {
    const slot = await futureRuleSlot(2)
    await expectRefusal(adminSession, null, addDays(new Date(), 2), REASON, 'invalid_input')
    await expectRefusal(adminSession, slot.id, null, REASON, 'invalid_input')
  })
})

// ── SQL: atomicity ───────────────────────────────────────────────────────────

describe('reschedule_instance — atomicity', () => {
  function installFailingInsertTrigger(errcode: string) {
    psql(`
      CREATE OR REPLACE FUNCTION ${TRIGGER_FN}() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        IF NEW.event_id = '${recurringEventId}' AND NEW.notes LIKE 'Rescheduled from %' THEN
          RAISE EXCEPTION 's95t4 forced failure' USING ERRCODE = '${errcode}';
        END IF;
        RETURN NEW;
      END $f$;
      DROP TRIGGER IF EXISTS s95t4_test_fail_insert ON public.event_instances;
      CREATE TRIGGER s95t4_test_fail_insert BEFORE INSERT ON public.event_instances
        FOR EACH ROW EXECUTE FUNCTION ${TRIGGER_FN}();`)
  }
  function dropFailingInsertTrigger() {
    psql(`DROP TRIGGER IF EXISTS s95t4_test_fail_insert ON public.event_instances; DROP FUNCTION IF EXISTS ${TRIGGER_FN}();`)
  }

  it('AT-01: insert fails after the cancel → original stays scheduled, notes untouched, no new row, no audit', async () => {
    const slot = (await freshSlots())[4]
    const before = await snapshot()
    installFailingInsertTrigger('P0001')
    try {
      const { data, error } = await rpc(adminSession, slot.id, addDays(new Date(slot.scheduled_at), 2), REASON)
      expect(data).toBeNull()
      expect(error?.message).toBe('s95t4 forced failure')
    } finally {
      dropFailingInsertTrigger()
    }
    expect(await snapshot()).toBe(before)
    const orig = await instanceById(slot.id)
    expect(orig.status).toBe('scheduled')
    expect(orig.notes).toBeNull()
  })

  it('AT-02: unique_violation on the insert (lost race) → typed slot_taken, cancel rolled back', async () => {
    const slot = (await freshSlots())[4]
    const before = await snapshot()
    installFailingInsertTrigger('23505')
    try {
      const { error } = await rpc(adminSession, slot.id, addDays(new Date(slot.scheduled_at), 2), REASON)
      expect(error?.message).toBe('reschedule:slot_taken')
    } finally {
      dropFailingInsertTrigger()
    }
    expect(await snapshot()).toBe(before)
    expect((await instanceById(slot.id)).status).toBe('scheduled')
  })

  it('AT-03: grants and definer mode — authenticated only, SECURITY INVOKER, search_path pinned', () => {
    expect(psql(`SELECT has_function_privilege('anon', '${FN}', 'EXECUTE')`)).toBe('f')
    expect(psql(`SELECT has_function_privilege('service_role', '${FN}', 'EXECUTE')`)).toBe('f')
    expect(psql(`SELECT has_function_privilege('authenticated', '${FN}', 'EXECUTE')`)).toBe('t')
    expect(psql(`SELECT prosecdef FROM pg_proc WHERE oid = '${FN}'::regprocedure`)).toBe('f')
    expect(psql(`SELECT array_to_string(proconfig, ',') FROM pg_proc WHERE oid = '${FN}'::regprocedure`))
      .toBe('search_path=public, pg_temp')
  })
})

// ── Action layer against the real RPC ────────────────────────────────────────

describe('impl_rescheduleInstance — against the real RPC', () => {
  it('ACT-01: admin → ok with the new id + event id; WIB date/time land as the right instant', async () => {
    const slot = (await freshSlots())[5]
    const target = addDays(new Date(slot.scheduled_at), 5) // a Thursday
    const wibDate = formatJakarta(target, 'yyyy-MM-dd')
    const result = await impl_rescheduleInstance({
      supabase: adminSession, instanceId: slot.id, wibDate, wibTime: '19:30', reason: REASON,
    })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.event_id).toBe(recurringEventId)
    const created = await instanceById(result.instance_id)
    expect(formatJakarta(new Date(created.scheduled_at), 'yyyy-MM-dd HH:mm')).toBe(`${wibDate} 19:30`)
  })

  it('ACT-02: organizer → not_admin (DB refusal mapped), nothing written', async () => {
    const slot = (await freshSlots())[5]
    const before = await snapshot()
    const result = await impl_rescheduleInstance({
      supabase: organizerSession,
      instanceId: slot.id,
      wibDate: formatJakarta(addDays(new Date(slot.scheduled_at), 1), 'yyyy-MM-dd'),
      wibTime: '15:00',
      reason: REASON,
    })
    expect(result).toEqual({ status: 'error', code: 'not_admin' })
    expect(await snapshot()).toBe(before)
  })

  it('ACT-03: adhoc → not_recurring mapped', async () => {
    const id = await insertInstance(adhocEventId, addDays(new Date(), 25), 'scheduled')
    const result = await impl_rescheduleInstance({
      supabase: adminSession,
      instanceId: id,
      wibDate: formatJakarta(addDays(new Date(), 26), 'yyyy-MM-dd'),
      wibTime: '15:00',
      reason: REASON,
    })
    expect(result).toEqual({ status: 'error', code: 'not_recurring' })
  })
})

// ── Downstream: picker, RSVP mint, invitations, completion flip ──────────────

describe('downstream on the one-off', () => {
  let originalId: string
  let oneOffId: string
  let oneOffAt: Date

  beforeAll(async () => {
    // A one-off "today": 2 hours from now, minute-aligned.
    const slot = (await freshSlots())[0]
    originalId = slot.id
    oneOffAt = new Date(Math.ceil((Date.now() + 2 * 3_600_000) / 60_000) * 60_000)
    const { data, error } = await rpc(adminSession, originalId, oneOffAt, 'Moved to today')
    if (error || typeof data !== 'string') throw new Error(`reschedule for downstream: ${error?.message}`)
    oneOffId = data
  }, 30_000)

  it('DS-01: check-in picker offers the one-off on its day; never the cancelled original', async () => {
    const result = await impl_listNearestInstances({ supabase: organizerSession, limit: 50 })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    const ids = result.instances.map(i => i.id)
    expect(ids).toContain(oneOffId)
    expect(ids).not.toContain(originalId)
  })

  it('DS-02: an RSVP link can be minted on the one-off; the cancelled original is closed', async () => {
    const minted = await impl_getOrCreateRsvpLink(oneOffId, adminSession)
    expect(minted.status).toBe('ok')
    expect(await impl_getOrCreateRsvpLink(originalId, adminSession)).toEqual({ status: 'closed' })
  })

  it('DS-03: invitations allowed on the one-off; refused on the cancelled original (instance_not_open, 0 sends)', async () => {
    const open = makeCountingTransport()
    const ok = await impl_sendInvites({
      supabase: adminSession,
      transport: open.transport,
      eventInstanceId: oneOffId,
      filter: { tribe: TRIBE },
      emailIdentity: EMAIL_IDENTITY,
      now: () => new Date(),
      sendIntervalMs: 0,
      sleep: async () => {},
    })
    expect(ok.status).toBe('ok')
    expect(open.calls()).toBe(1)

    const closed = makeCountingTransport()
    const refused = await impl_sendInvites({
      supabase: adminSession,
      transport: closed.transport,
      eventInstanceId: originalId,
      filter: { tribe: TRIBE },
      emailIdentity: EMAIL_IDENTITY,
      now: () => new Date(),
      sendIntervalMs: 0,
      sleep: async () => {},
    })
    expect(refused).toEqual({ status: 'instance_not_open' })
    expect(closed.calls()).toBe(0)
    const { count } = await svc
      .from('event_invitations')
      .select('*', { count: 'exact', head: true })
      .eq('event_instance_id', originalId)
    expect(count).toBe(0)
  })

  it('DS-04: completion flip completes the one-off after its WIB end day; the cancelled original stays cancelled', async () => {
    const flipNow = addDays(oneOffAt, 2)
    await flipCompletedInstances(svc, flipNow)
    expect((await instanceById(oneOffId)).status).toBe('completed')
    expect((await instanceById(originalId)).status).toBe('cancelled')
  })
})
