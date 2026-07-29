// Integration tests for Sprint 4 Task 5 — birthday digest cron impl.
// Runs against local Docker Supabase (configured in .env.test.local).
// Vitest owns the DB round-trip + idempotency/failure branches (E/1, E/2); the
// real Telegram send is stubbed here — only the live verify report may claim
// delivery. Fixture phone space: +62999009105xxx (T5).
// Run: npm test -- birthday-digest

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { runBirthdayDigest, BIRTHDAY_DIGEST_SOURCE } from '@/lib/events/birthday-digest.impl';
import type { SendTelegramMessageResult } from '@/lib/telegram/client';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !serviceRoleKey) {
  throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
}

let admin: SupabaseClient;
let originalChatId: string | null;

// Fixed `now`, distinct from any date real crons would ever touch (test suite,
// not the handler, chooses `now` — proves the impl takes it as an input, per D/3).
const NOW = new Date('2026-11-19T00:30:00.000Z'); // 2026-11-19 07:30 ICT
const TODAY_ICT = '2026-11-19';

const createdPersonIds: string[] = [];
const createdHealthIds: string[] = [];

async function insertPerson(attrs: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin.from('people').insert(attrs).select('id').single();
  if (error || !data) throw new Error(`insert person: ${error?.message}`);
  createdPersonIds.push(data.id as string);
  return data.id as string;
}

async function insertHealthRow(attrs: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin.from('system_health').insert(attrs).select('id').single();
  if (error || !data) throw new Error(`insert system_health: ${error?.message}`);
  createdHealthIds.push(data.id as string);
  return data.id as string;
}

type SendMessageFn = (params: {
  token: string;
  chatId: string;
  text: string;
}) => Promise<SendTelegramMessageResult>;

function stubOk(messageId: number) {
  return vi.fn<SendMessageFn>().mockResolvedValue({
    ok: true,
    messageId,
  });
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

  const { data: settings } = await admin
    .from('app_settings')
    .select('telegram_admin_chat_id')
    .limit(1)
    .maybeSingle();
  originalChatId = (settings as { telegram_admin_chat_id: string | null } | null)
    ?.telegram_admin_chat_id ?? null;

  await admin.from('app_settings').update({ telegram_admin_chat_id: '111111111' }).eq('id', 1);
}, 30_000);

afterAll(async () => {
  await admin.from('app_settings').update({ telegram_admin_chat_id: originalChatId }).eq('id', 1);
}, 30_000);

afterEach(async () => {
  if (createdPersonIds.length > 0) {
    await admin.from('people').delete().in('id', createdPersonIds);
    createdPersonIds.length = 0;
  }
  if (createdHealthIds.length > 0) {
    await admin.from('system_health').delete().in('id', createdHealthIds);
    createdHealthIds.length = 0;
  }
});

describe('runBirthdayDigest', () => {
  it('T4-04: no birthdays today → empty result, no send, system_health row written with count 0', async () => {
    const sendMessage = stubOk(1);

    const result = await runBirthdayDigest({ supabase: admin, now: NOW, sendMessage });

    expect(result).toEqual({ status: 'empty', ict_date: TODAY_ICT });
    expect(sendMessage).not.toHaveBeenCalled();

    const { data: rows } = await admin
      .from('system_health')
      .select('id, status, table_row_counts')
      .eq('status', 'ok')
      .gte('checked_at', '2026-11-18T17:00:00.000Z')
      .lt('checked_at', '2026-11-19T17:00:00.000Z');
    createdHealthIds.push(...(rows ?? []).map((r) => r.id as string));
    const written = (rows ?? []).find(
      (r) => (r.table_row_counts as { source?: string })?.source === BIRTHDAY_DIGEST_SOURCE,
    );
    expect(written?.table_row_counts).toMatchObject({
      source: BIRTHDAY_DIGEST_SOURCE,
      ict_date: TODAY_ICT,
      count: 0,
    });
  });

  it('T4-02/T4-03: two birthdays today, mixed consent → both appear, annotated not filtered', async () => {
    await insertPerson({
      phone_e164: '+62999009105001',
      full_name: 'T5 Publishable',
      nickname: 'Pub',
      birth_date: '1992-11-19',
      photo_publish_consent: true,
    });
    await insertPerson({
      phone_e164: '+62999009105002',
      full_name: 'T5 Private',
      nickname: 'Priv',
      birth_date: '1985-11-19',
      photo_publish_consent: false,
    });

    const sendMessage = stubOk(42);
    const result = await runBirthdayDigest({
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
    });
    expect(sendMessage).toHaveBeenCalledOnce();
    const call = sendMessage.mock.calls[0][0] as { token: string; chatId: string; text: string };
    expect(call.token).toBe('test-token');
    expect(call.chatId).toBe('111111111');
    expect(call.text).toContain('T5 Publishable');
    expect(call.text).toContain('✅');
    expect(call.text).toContain('T5 Private');
    expect(call.text).toContain('🔒');

    const { data: rows } = await admin
      .from('system_health')
      .select('id, status, table_row_counts')
      .eq('status', 'ok')
      .gte('checked_at', '2026-11-18T17:00:00.000Z')
      .lt('checked_at', '2026-11-19T17:00:00.000Z');
    createdHealthIds.push(...(rows ?? []).map((r) => r.id as string));
    const written = (rows ?? []).find(
      (r) => (r.table_row_counts as { source?: string })?.source === BIRTHDAY_DIGEST_SOURCE,
    );
    expect(written?.table_row_counts).toMatchObject({
      source: BIRTHDAY_DIGEST_SOURCE,
      ict_date: TODAY_ICT,
      count: 2,
      message_id: 42,
    });
  });

  it('idempotency: a prior success row for today → skips the send entirely', async () => {
    await insertPerson({
      phone_e164: '+62999009105003',
      full_name: 'T5 Should Not Send',
      nickname: 'NoSend',
      birth_date: '1990-11-19',
      photo_publish_consent: false,
    });
    await insertHealthRow({
      checked_at: '2026-11-18T18:00:00.000Z', // inside the ICT-day window
      table_row_counts: { source: BIRTHDAY_DIGEST_SOURCE, ict_date: TODAY_ICT, count: 1 },
      status: 'ok',
    });

    const sendMessage = stubOk(99);
    const result = await runBirthdayDigest({ supabase: admin, now: NOW, sendMessage });

    expect(result).toEqual({ status: 'skipped_already_sent', ict_date: TODAY_ICT });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('send failure: logs and skips — writes a degraded row, does not throw', async () => {
    await insertPerson({
      phone_e164: '+62999009105004',
      full_name: 'T5 Send Fails',
      nickname: 'Fail',
      birth_date: '1988-11-19',
      photo_publish_consent: true,
    });

    const sendMessage = stubFailed();
    const result = await runBirthdayDigest({
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
    });

    const { data: rows } = await admin
      .from('system_health')
      .select('id, status, table_row_counts, notes')
      .eq('status', 'degraded')
      .gte('checked_at', '2026-11-18T17:00:00.000Z')
      .lt('checked_at', '2026-11-19T17:00:00.000Z');
    createdHealthIds.push(...(rows ?? []).map((r) => r.id as string));
    expect(rows).toHaveLength(1);
    expect(rows![0].table_row_counts).toMatchObject({
      source: BIRTHDAY_DIGEST_SOURCE,
      ict_date: TODAY_ICT,
      count: 1,
    });
    expect(rows![0].notes).toContain('stubbed network failure');

    // A failed send must not satisfy idempotency — a second run today would retry.
    const retryResult = await runBirthdayDigest({
      supabase: admin,
      now: NOW,
      sendMessage: stubOk(100),
      getToken: () => 'test-token',
    });
    expect(retryResult.status).toBe('sent');

    const { data: retryRows } = await admin
      .from('system_health')
      .select('id')
      .eq('status', 'ok')
      .gte('checked_at', '2026-11-18T17:00:00.000Z')
      .lt('checked_at', '2026-11-19T17:00:00.000Z');
    createdHealthIds.push(...(retryRows ?? []).map((r) => r.id as string));
  });
});
