// Integration tests for Sprint 4 Task 6 / Sprint 5 Task 5 — attendance summary
// cron impl. Runs against local Docker Supabase (configured in .env.test.local).
// Vitest owns the DB round-trip + idempotency/failure/boundary branches (E/1,
// E/2); the real Telegram send is stubbed here — only the live verify report
// may claim delivery. Fixture phone space: +62999009106xxx (T6, distinct from
// T5's 105xxx and other sprint fixture spaces — see export-actions.test.ts's
// space registry comment).
//
// Sprint 5 T5: idempotency rewritten to claim-first against system_health's typed
// source/ict_date columns (see lib/cron/idempotent-claim.ts, whose own integration
// test covers the claim/reclaim state machine in isolation). Also adds the
// scheduled→completed flip (flipCompletedInstances), run unconditionally before
// the claim/send path — its own describe block below tests the predicate
// directly; the flip also runs as a side effect of every runAttendanceSummary
// call in the tests below, since fixture instances are always scheduled before
// NOW (matches production: the cron fires after the events it reports on).
// Run: npm test -- attendance-summary

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import {
  runAttendanceSummary,
  flipCompletedInstances,
  ATTENDANCE_SUMMARY_SOURCE,
} from '@/lib/events/attendance-summary.impl';
import { DEFAULT_STALE_MS } from '@/lib/cron/idempotent-claim';
import type { SendTelegramMessageResult } from '@/lib/telegram/client';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !serviceRoleKey) {
  throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
}

const FAKE_ADMIN_ID = '00000000-0000-0000-0000-000000000103';

let admin: SupabaseClient;
let originalChatId: string | null;
let eventId: string;

// Fixed `now`, distinct from any date real crons would ever touch — 23:30 ICT
// on 2026-11-19 (test suite chooses `now` as input, proving D/3 compliance).
const NOW = new Date('2026-11-19T16:30:00.000Z');
const TODAY_ICT = '2026-11-19';
const DAY_START_UTC = '2026-11-18T17:00:00.000Z'; // inclusive
const DAY_END_UTC = '2026-11-19T17:00:00.000Z'; // exclusive

const createdInstanceIds: string[] = [];
const createdAttendanceIds: string[] = [];
const createdPersonIds: string[] = [];
const createdHealthIds: string[] = [];

async function insertInstance(attrs: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin
    .from('event_instances')
    .insert({ event_id: eventId, event_name_snapshot: 'T6 Test Event', event_name_snapshot_id: null, ...attrs })
    .select('id')
    .single();
  if (error || !data) throw new Error(`insert event_instance: ${error?.message}`);
  createdInstanceIds.push(data.id as string);
  return data.id as string;
}

async function insertPerson(attrs: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin
    .from('people')
    .insert({ nickname: (attrs.full_name as string).split(' ')[0], ...attrs })
    .select('id')
    .single();
  if (error || !data) throw new Error(`insert person: ${error?.message}`);
  createdPersonIds.push(data.id as string);
  return data.id as string;
}

async function insertAttendance(
  instanceId: string,
  personId: string,
  checkedInAt: string,
): Promise<string> {
  const { data, error } = await admin
    .from('attendance')
    .insert({
      event_instance_id: instanceId,
      person_id: personId,
      checked_in_at: checkedInAt,
      checked_in_by: FAKE_ADMIN_ID,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`insert attendance: ${error?.message}`);
  createdAttendanceIds.push(data.id as string);
  return data.id as string;
}

async function insertHealthRow(attrs: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin.from('system_health').insert(attrs).select('id').single();
  if (error || !data) throw new Error(`insert system_health: ${error?.message}`);
  createdHealthIds.push(data.id as string);
  return data.id as string;
}

async function readClaimRow(): Promise<{ id: string; status: string } | null> {
  const { data } = await admin
    .from('system_health')
    .select('id, status')
    .eq('source', ATTENDANCE_SUMMARY_SOURCE)
    .eq('ict_date', TODAY_ICT)
    .maybeSingle();
  if (data) createdHealthIds.push((data as { id: string }).id);
  return data as { id: string; status: string } | null;
}

type SendMessageFn = (params: {
  token: string;
  chatId: string;
  text: string;
}) => Promise<SendTelegramMessageResult>;

function stubOk(messageId: number) {
  return vi.fn<SendMessageFn>().mockResolvedValue({ ok: true, messageId });
}

function stubFailed() {
  return vi.fn<SendMessageFn>().mockResolvedValue({
    ok: false,
    reason: 'network_error',
    message: 'stubbed network failure',
  });
}

beforeAll(async () => {
  admin = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  await admin.from('app_users').upsert(
    {
      id: FAKE_ADMIN_ID,
      email: 't6-fake-admin@test.invalid',
      full_name: 'T6 Test Fake Admin',
      role: 'admin',
      active: true,
    },
    { onConflict: 'id' },
  );

  const { data: settings } = await admin
    .from('app_settings')
    .select('telegram_admin_chat_id')
    .limit(1)
    .maybeSingle();
  originalChatId =
    (settings as { telegram_admin_chat_id: string | null } | null)?.telegram_admin_chat_id ?? null;
  await admin.from('app_settings').update({ telegram_admin_chat_id: '111111111' }).eq('id', 1);

  const { data: ev, error: evErr } = await admin
    .from('events')
    .insert({
      name: 'T6 Test Event',
      event_type: 'adhoc',
      start_date: '2026-11-19',
      start_time: '18:00:00',
      active: true,
      created_by: FAKE_ADMIN_ID,
    })
    .select('id')
    .single();
  if (evErr || !ev) throw new Error(`insert event: ${evErr?.message}`);
  eventId = (ev as { id: string }).id;
}, 30_000);

afterAll(async () => {
  await admin.from('app_settings').update({ telegram_admin_chat_id: originalChatId }).eq('id', 1);
  if (eventId) {
    await admin.from('event_instances').delete().eq('event_id', eventId);
    await admin.from('events').delete().eq('id', eventId);
  }
}, 30_000);

afterEach(async () => {
  if (createdAttendanceIds.length > 0) {
    await admin.from('attendance').delete().in('id', createdAttendanceIds);
    createdAttendanceIds.length = 0;
  }
  if (createdPersonIds.length > 0) {
    await admin.from('people').delete().in('id', createdPersonIds);
    createdPersonIds.length = 0;
  }
  if (createdInstanceIds.length > 0) {
    await admin.from('event_instances').delete().in('id', createdInstanceIds);
    createdInstanceIds.length = 0;
  }
  if (createdHealthIds.length > 0) {
    await admin.from('system_health').delete().in('id', createdHealthIds);
    createdHealthIds.length = 0;
  }
});

describe('flipCompletedInstances', () => {
  it('flips scheduled_at < now scheduled instances to completed; leaves cancelled and future untouched; strict-less-than at the boundary; idempotent re-run', async () => {
    const pastInstance = await insertInstance({ scheduled_at: '2026-11-19T10:00:00.000Z', status: 'scheduled' });
    const exactNowInstance = await insertInstance({ scheduled_at: NOW.toISOString(), status: 'scheduled' });
    const futureInstance = await insertInstance({ scheduled_at: '2026-11-20T10:00:00.000Z', status: 'scheduled' });
    const cancelledPastInstance = await insertInstance({
      scheduled_at: '2026-11-17T10:00:00.000Z',
      status: 'cancelled',
    });

    const flipped = await flipCompletedInstances(admin, NOW);
    expect(flipped).toBe(1); // only pastInstance — exactNowInstance is NOT < now

    const { data: rows } = await admin
      .from('event_instances')
      .select('id, status')
      .in('id', [pastInstance, exactNowInstance, futureInstance, cancelledPastInstance]);
    const byId = new Map((rows ?? []).map((r) => [r.id as string, r.status as string]));
    expect(byId.get(pastInstance)).toBe('completed');
    expect(byId.get(exactNowInstance)).toBe('scheduled'); // boundary: not yet occurred
    expect(byId.get(futureInstance)).toBe('scheduled');
    expect(byId.get(cancelledPastInstance)).toBe('cancelled'); // never touched, regardless of date

    const secondFlip = await flipCompletedInstances(admin, NOW);
    expect(secondFlip).toBe(0); // idempotent — pastInstance already 'completed', no longer matches
  });
});

describe('runAttendanceSummary', () => {
  it('T4-04 analogue: no check-ins today → empty result, no send, system_health row written with count 0, flipped_count reflects any occurred instances', async () => {
    const sendMessage = stubOk(1);

    const result = await runAttendanceSummary({ supabase: admin, now: NOW, sendMessage });

    expect(result).toEqual({ status: 'empty', ict_date: TODAY_ICT, flipped_count: 0 });
    expect(sendMessage).not.toHaveBeenCalled();

    const row = await readClaimRow();
    expect(row?.status).toBe('ok');
  });

  it('two check-ins on one instance → both appear, grouped correctly, system_health written with count 2, the instance itself gets flipped to completed as a side effect', async () => {
    const instanceId = await insertInstance({ scheduled_at: '2026-11-19T11:00:00.000Z', status: 'scheduled' });
    const p1 = await insertPerson({ phone_e164: '+62999009106001', full_name: 'T6 Attendee One' });
    const p2 = await insertPerson({ phone_e164: '+62999009106002', full_name: 'T6 Attendee Two' });
    await insertAttendance(instanceId, p1, '2026-11-18T18:00:00.000Z');
    await insertAttendance(instanceId, p2, '2026-11-18T19:00:00.000Z');

    const sendMessage = stubOk(42);
    const result = await runAttendanceSummary({
      supabase: admin,
      now: NOW,
      sendMessage,
      getToken: () => 'test-token',
    });

    expect(result).toEqual({
      status: 'sent',
      ict_date: TODAY_ICT,
      count: 2,
      message_id: 42,
      flipped_count: 1,
    });
    expect(sendMessage).toHaveBeenCalledOnce();
    const call = sendMessage.mock.calls[0][0] as { token: string; chatId: string; text: string };
    expect(call.token).toBe('test-token');
    expect(call.chatId).toBe('111111111');
    expect(call.text).toContain('T6 Attendee One');
    expect(call.text).toContain('T6 Attendee Two');
    expect(call.text).toContain('(2)');

    const { data: instRow } = await admin.from('event_instances').select('status').eq('id', instanceId).single();
    expect(instRow?.status).toBe('completed');

    const row = await readClaimRow();
    expect(row?.status).toBe('ok');
  });

  it('ICT-window boundary, proven against the real DB query: a check-in exactly at the start instant is included, exactly at the end instant is excluded', async () => {
    const instanceId = await insertInstance({ scheduled_at: '2026-11-19T02:00:00.000Z', status: 'scheduled' });
    const pIn = await insertPerson({ phone_e164: '+62999009106003', full_name: 'T6 Boundary In' });
    const pOut = await insertPerson({ phone_e164: '+62999009106004', full_name: 'T6 Boundary Out' });
    await insertAttendance(instanceId, pIn, DAY_START_UTC); // inclusive bottom — must appear
    await insertAttendance(instanceId, pOut, DAY_END_UTC); // exclusive top — must NOT appear

    const sendMessage = stubOk(7);
    const result = await runAttendanceSummary({
      supabase: admin,
      now: NOW,
      sendMessage,
      getToken: () => 'test-token',
    });

    expect(result).toMatchObject({ status: 'sent', ict_date: TODAY_ICT, count: 1 });
    const call = sendMessage.mock.calls[0][0] as { text: string };
    expect(call.text).toContain('T6 Boundary In');
    expect(call.text).not.toContain('T6 Boundary Out');

    await readClaimRow();
  });

  it('cancelled instance check-ins still appear, annotated in the label; the instance stays cancelled (flip never touches it)', async () => {
    const instanceId = await insertInstance({ scheduled_at: '2026-11-19T11:00:00.000Z', status: 'cancelled' });
    const p1 = await insertPerson({ phone_e164: '+62999009106005', full_name: 'T6 Cancelled Attendee' });
    await insertAttendance(instanceId, p1, '2026-11-18T18:00:00.000Z');

    const sendMessage = stubOk(8);
    const result = await runAttendanceSummary({
      supabase: admin,
      now: NOW,
      sendMessage,
      getToken: () => 'test-token',
    });

    expect(result).toMatchObject({ status: 'sent', count: 1 });
    const call = sendMessage.mock.calls[0][0] as { text: string };
    expect(call.text).toContain('T6 Cancelled Attendee');
    expect(call.text).toContain('dibatalkan');

    const { data: instRow } = await admin.from('event_instances').select('status').eq('id', instanceId).single();
    expect(instRow?.status).toBe('cancelled');

    await readClaimRow();
  });

  it('idempotency: a prior success row for today → skips the send entirely', async () => {
    const instanceId = await insertInstance({ scheduled_at: '2026-11-19T11:00:00.000Z', status: 'scheduled' });
    const p1 = await insertPerson({ phone_e164: '+62999009106006', full_name: 'T6 Should Not Send' });
    await insertAttendance(instanceId, p1, '2026-11-18T18:00:00.000Z');
    await insertHealthRow({
      source: ATTENDANCE_SUMMARY_SOURCE,
      ict_date: TODAY_ICT,
      checked_at: NOW.toISOString(),
      table_row_counts: { source: ATTENDANCE_SUMMARY_SOURCE, ict_date: TODAY_ICT, count: 1 },
      status: 'ok',
    });

    const sendMessage = stubOk(99);
    const result = await runAttendanceSummary({ supabase: admin, now: NOW, sendMessage });

    expect(result).toEqual({ status: 'skipped_already_sent', ict_date: TODAY_ICT, flipped_count: 1 });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('concurrent double-invoke: a fresh pending claim from another invocation → this one skips, no send (flip still runs — decoupled from the claim)', async () => {
    const instanceId = await insertInstance({ scheduled_at: '2026-11-19T11:00:00.000Z', status: 'scheduled' });
    await insertHealthRow({
      source: ATTENDANCE_SUMMARY_SOURCE,
      ict_date: TODAY_ICT,
      checked_at: new Date(NOW.getTime() - 60_000).toISOString(), // 1 min old — fresh
      status: 'pending',
    });

    const sendMessage = stubOk(1);
    const result = await runAttendanceSummary({ supabase: admin, now: NOW, sendMessage });

    expect(result).toEqual({ status: 'skipped_concurrent', ict_date: TODAY_ICT, flipped_count: 1 });
    expect(sendMessage).not.toHaveBeenCalled();

    const row = await readClaimRow();
    expect(row?.status).toBe('pending'); // untouched — the other invocation still owns it

    const { data: instRow } = await admin.from('event_instances').select('status').eq('id', instanceId).single();
    expect(instRow?.status).toBe('completed'); // flip is unconditional, ran regardless of the skip
  });

  it('stale pending (crash mid-flight, no terminal write) → reattempted', async () => {
    const instanceId = await insertInstance({ scheduled_at: '2026-11-19T11:00:00.000Z', status: 'scheduled' });
    const p1 = await insertPerson({ phone_e164: '+62999009106008', full_name: 'T6 Stale Reclaim' });
    await insertAttendance(instanceId, p1, '2026-11-18T18:00:00.000Z');
    await insertHealthRow({
      source: ATTENDANCE_SUMMARY_SOURCE,
      ict_date: TODAY_ICT,
      checked_at: new Date(NOW.getTime() - DEFAULT_STALE_MS - 1000).toISOString(), // past staleness
      status: 'pending',
    });

    const sendMessage = stubOk(77);
    const result = await runAttendanceSummary({
      supabase: admin,
      now: NOW,
      sendMessage,
      getToken: () => 'test-token',
    });

    expect(result).toEqual({ status: 'sent', ict_date: TODAY_ICT, count: 1, message_id: 77, flipped_count: 1 });
    expect(sendMessage).toHaveBeenCalledOnce();

    const row = await readClaimRow();
    expect(row?.status).toBe('ok');
  });

  it('send failure: logs and skips — writes a degraded row, does not throw, does not block a same-day retry (degraded reclaims immediately)', async () => {
    const instanceId = await insertInstance({ scheduled_at: '2026-11-19T11:00:00.000Z', status: 'scheduled' });
    const p1 = await insertPerson({ phone_e164: '+62999009106007', full_name: 'T6 Send Fails' });
    await insertAttendance(instanceId, p1, '2026-11-18T18:00:00.000Z');

    const sendMessage = stubFailed();
    const result = await runAttendanceSummary({
      supabase: admin,
      now: NOW,
      sendMessage,
      getToken: () => 'test-token',
    });

    expect(result).toEqual({
      status: 'send_failed',
      ict_date: TODAY_ICT,
      count: 1,
      reason: 'stubbed network failure',
      flipped_count: 1,
    });

    const degradedRow = await readClaimRow();
    expect(degradedRow?.status).toBe('degraded');

    const retryResult = await runAttendanceSummary({
      supabase: admin,
      now: NOW,
      sendMessage: stubOk(100),
      getToken: () => 'test-token',
    });
    expect(retryResult.status).toBe('sent');

    const retriedRow = await readClaimRow();
    expect(retriedRow?.status).toBe('ok');
  });
});
