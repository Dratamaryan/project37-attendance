// Integration tests for Sprint 4 Task 5 / Sprint 5 Task 5 — birthday digest cron impl.
// Runs against local Docker Supabase (configured in .env.test.local). Vitest owns
// the DB round-trip + idempotency/failure branches (E/1, E/2); the real Telegram
// send is stubbed here — only the live verify report may claim delivery. Fixture
// phone space: +62999009105xxx (T5).
//
// Sprint 5 T5: idempotency rewritten to claim-first against system_health's typed
// source/ict_date columns (see lib/cron/idempotent-claim.ts, whose own integration
// test covers the claim/reclaim state machine in isolation — this file exercises
// it end-to-end through runBirthdayDigest).
// Run: npm test -- birthday-digest

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { runBirthdayDigest, BIRTHDAY_DIGEST_SOURCE } from '@/lib/events/birthday-digest.impl';
import { DEFAULT_STALE_MS } from '@/lib/cron/idempotent-claim';
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

async function readClaimRow(): Promise<{ id: string; status: string } | null> {
  const { data } = await admin
    .from('system_health')
    .select('id, status')
    .eq('source', BIRTHDAY_DIGEST_SOURCE)
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

// Wraps a real Supabase client so that the Nth call to `.from('system_health')`
// returns a fake `.update().eq()` chain resolving to an error — every other call
// (including earlier system_health calls, and every call to any other table)
// passes through untouched. Used to deterministically simulate resolveCronClaim's
// write failing AFTER a real send succeeded, without mocking the whole client —
// pins the one accepted residual named in the plan (see idempotent-claim.ts's
// top-of-file comment and docs/sprint-5-task-5-verify.md).
function wrapWithFailingResolve(real: SupabaseClient, failOnNthSystemHealthCall: number): SupabaseClient {
  let systemHealthCallCount = 0;
  return {
    from(table: string) {
      if (table === 'system_health') {
        systemHealthCallCount += 1;
        if (systemHealthCallCount === failOnNthSystemHealthCall) {
          return {
            update: () => ({
              eq: () => Promise.resolve({ error: { message: 'simulated resolve failure' } }),
            }),
          };
        }
      }
      return real.from(table);
    },
  } as unknown as SupabaseClient;
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

    const row = await readClaimRow();
    expect(row?.status).toBe('ok');
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

    const row = await readClaimRow();
    expect(row?.status).toBe('ok');
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
      source: BIRTHDAY_DIGEST_SOURCE,
      ict_date: TODAY_ICT,
      checked_at: NOW.toISOString(),
      table_row_counts: { source: BIRTHDAY_DIGEST_SOURCE, ict_date: TODAY_ICT, count: 1 },
      status: 'ok',
    });

    const sendMessage = stubOk(99);
    const result = await runBirthdayDigest({ supabase: admin, now: NOW, sendMessage });

    expect(result).toEqual({ status: 'skipped_already_sent', ict_date: TODAY_ICT });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('concurrent double-invoke: a fresh pending claim from another invocation → this one skips, no send', async () => {
    await insertHealthRow({
      source: BIRTHDAY_DIGEST_SOURCE,
      ict_date: TODAY_ICT,
      checked_at: new Date(NOW.getTime() - 60_000).toISOString(), // 1 min old — fresh
      status: 'pending',
    });

    const sendMessage = stubOk(1);
    const result = await runBirthdayDigest({ supabase: admin, now: NOW, sendMessage });

    expect(result).toEqual({ status: 'skipped_concurrent', ict_date: TODAY_ICT });
    expect(sendMessage).not.toHaveBeenCalled();

    const row = await readClaimRow();
    expect(row?.status).toBe('pending'); // untouched — the other invocation still owns it
  });

  it('stale pending (crash mid-flight, no terminal write) → reattempted', async () => {
    await insertPerson({
      phone_e164: '+62999009105005',
      full_name: 'T5 Stale Reclaim',
      nickname: 'Stale',
      birth_date: '1991-11-19',
      photo_publish_consent: true,
    });
    await insertHealthRow({
      source: BIRTHDAY_DIGEST_SOURCE,
      ict_date: TODAY_ICT,
      checked_at: new Date(NOW.getTime() - DEFAULT_STALE_MS - 1000).toISOString(), // past staleness
      status: 'pending',
    });

    const sendMessage = stubOk(77);
    const result = await runBirthdayDigest({
      supabase: admin,
      now: NOW,
      sendMessage,
      getToken: () => 'test-token',
    });

    expect(result).toEqual({ status: 'sent', ict_date: TODAY_ICT, count: 1, message_id: 77 });
    expect(sendMessage).toHaveBeenCalledOnce();

    const row = await readClaimRow();
    expect(row?.status).toBe('ok');
  });

  it('send failure: logs and skips — writes a degraded row, does not throw; the degraded claim reattempts immediately (no staleness gate)', async () => {
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

    const degradedRow = await readClaimRow();
    expect(degradedRow?.status).toBe('degraded');

    // A failed send must not satisfy idempotency — a same-day retry reclaims
    // immediately (degraded needs no staleness wait, unlike a bare crash).
    const retryResult = await runBirthdayDigest({
      supabase: admin,
      now: NOW,
      sendMessage: stubOk(100),
      getToken: () => 'test-token',
    });
    expect(retryResult.status).toBe('sent');

    const retriedRow = await readClaimRow();
    expect(retriedRow?.status).toBe('ok');
  });

  it('accepted residual, pinned: send succeeds but the resolveCronClaim write fails → row stays pending → a later past-staleness run reclaims and re-sends', async () => {
    await insertPerson({
      phone_e164: '+62999009105006',
      full_name: 'T5 Residual Pin',
      nickname: 'Residual',
      birth_date: '1993-11-19',
      photo_publish_consent: true,
    });

    const firstSend = stubOk(55);
    const failingClient = wrapWithFailingResolve(admin, 2); // 1st system_health call = real claim INSERT; 2nd = the resolve UPDATE we fail

    const result = await runBirthdayDigest({
      supabase: failingClient,
      now: NOW,
      sendMessage: firstSend,
      getToken: () => 'test-token',
    });

    // The send genuinely happened — caller-visible outcome is 'sent', matching
    // "a missed digest is worse than a duplicate": we don't retroactively report
    // failure just because the bookkeeping write didn't land.
    expect(result).toEqual({ status: 'sent', ict_date: TODAY_ICT, count: 1, message_id: 55 });
    expect(firstSend).toHaveBeenCalledOnce();

    const row = await readClaimRow();
    expect(row?.status).toBe('pending'); // resolve write never landed — this is the residual

    const laterNow = new Date(NOW.getTime() + DEFAULT_STALE_MS + 60_000); // past staleness, same ICT day
    const retrySend = stubOk(56);
    const retryResult = await runBirthdayDigest({
      supabase: admin,
      now: laterNow,
      sendMessage: retrySend,
      getToken: () => 'test-token',
    });

    // Duplicate send — the accepted tradeoff, not a bug.
    expect(retryResult).toEqual({ status: 'sent', ict_date: TODAY_ICT, count: 1, message_id: 56 });
    expect(retrySend).toHaveBeenCalledOnce();

    const finalRow = await readClaimRow();
    expect(finalRow?.status).toBe('ok');
  });
});
