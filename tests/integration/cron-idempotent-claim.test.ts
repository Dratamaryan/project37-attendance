// Integration tests for Sprint 5 Task 5 — lib/cron/idempotent-claim.ts.
// Runs against local Docker Supabase (configured in .env.test.local). Proves the
// real 23505/unique-index and optimistic-lock reclaim behavior directly — this
// can't be demonstrated with a mocked client (T3 lesson: ON CONFLICT semantics
// must be proven against real Postgres). runBirthdayDigest/runAttendanceSummary's
// own integration tests exercise this module end-to-end through the crons; this
// file isolates the claim/reclaim state machine itself.
// Run: npm test -- cron-idempotent-claim

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { claimCronSlot, resolveCronClaim, DEFAULT_STALE_MS } from '@/lib/cron/idempotent-claim';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !serviceRoleKey) {
  throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
}

let admin: SupabaseClient;

const SOURCE = 'test-t5-idempotent-claim';
const ICT_DATE = '2026-11-20';
const NOW = new Date('2026-11-20T16:30:00.000Z');

const createdHealthIds: string[] = [];

async function insertHealthRow(attrs: Record<string, unknown>): Promise<number> {
  const { data, error } = await admin
    .from('system_health')
    .insert({ source: SOURCE, ict_date: ICT_DATE, ...attrs })
    .select('id')
    .single();
  if (error || !data) throw new Error(`insert system_health: ${error?.message}`);
  createdHealthIds.push(data.id as string);
  return data.id as number;
}

async function readRow(): Promise<{ id: number; status: string; checked_at: string } | null> {
  const { data } = await admin
    .from('system_health')
    .select('id, status, checked_at')
    .eq('source', SOURCE)
    .eq('ict_date', ICT_DATE)
    .maybeSingle();
  return data as { id: number; status: string; checked_at: string } | null;
}

beforeAll(async () => {
  admin = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}, 30_000);

afterEach(async () => {
  if (createdHealthIds.length > 0) {
    await admin.from('system_health').delete().in('id', createdHealthIds);
    createdHealthIds.length = 0;
  }
});

describe('claimCronSlot', () => {
  it('no existing row → claims via a fresh INSERT', async () => {
    const outcome = await claimCronSlot({ supabase: admin, source: SOURCE, ictDate: ICT_DATE, now: NOW });
    expect(outcome.outcome).toBe('claimed');
    if (outcome.outcome === 'claimed') {
      createdHealthIds.push(String(outcome.claimId));
      const row = await readRow();
      expect(row).toMatchObject({ id: outcome.claimId, status: 'pending' });
    }
  });

  it('23505 proof: two sequential claims for the same (source, ict_date) — the second sees the real unique-index conflict, not a mock', async () => {
    const first = await claimCronSlot({ supabase: admin, source: SOURCE, ictDate: ICT_DATE, now: NOW });
    expect(first.outcome).toBe('claimed');
    if (first.outcome === 'claimed') createdHealthIds.push(String(first.claimId));

    const second = await claimCronSlot({ supabase: admin, source: SOURCE, ictDate: ICT_DATE, now: NOW });
    expect(second.outcome).toBe('concurrent'); // fresh 'pending' from the first claim
  });

  it("existing status='ok' → already_done, regardless of age", async () => {
    const oldCheckedAt = new Date(NOW.getTime() - DEFAULT_STALE_MS * 5).toISOString();
    await insertHealthRow({ status: 'ok', checked_at: oldCheckedAt, table_row_counts: { count: 0 } });

    const outcome = await claimCronSlot({ supabase: admin, source: SOURCE, ictDate: ICT_DATE, now: NOW });
    expect(outcome).toEqual({ outcome: 'already_done' });
  });

  it("existing status='pending', fresh (age < staleMs) → concurrent, row untouched", async () => {
    const freshCheckedAt = new Date(NOW.getTime() - 60_000).toISOString(); // 1 min old
    const claimId = await insertHealthRow({ status: 'pending', checked_at: freshCheckedAt });

    const outcome = await claimCronSlot({ supabase: admin, source: SOURCE, ictDate: ICT_DATE, now: NOW });
    expect(outcome).toEqual({ outcome: 'concurrent' });

    const row = await readRow();
    expect(row).toMatchObject({ id: claimId, status: 'pending' });
    expect(new Date(row!.checked_at).getTime()).toBe(new Date(freshCheckedAt).getTime());
  });

  it("existing status='pending', stale (age >= staleMs) → reclaimed, checked_at bumped", async () => {
    const staleCheckedAt = new Date(NOW.getTime() - DEFAULT_STALE_MS - 1000).toISOString();
    const claimId = await insertHealthRow({ status: 'pending', checked_at: staleCheckedAt });

    const outcome = await claimCronSlot({ supabase: admin, source: SOURCE, ictDate: ICT_DATE, now: NOW });
    expect(outcome).toEqual({ outcome: 'claimed', claimId });

    const row = await readRow();
    expect(row).toMatchObject({ id: claimId, status: 'pending' });
    expect(new Date(row!.checked_at).getTime()).toBe(NOW.getTime());
  });

  it("existing status='degraded' → reclaimed immediately, no staleness gate", async () => {
    const recentCheckedAt = new Date(NOW.getTime() - 5000).toISOString(); // 5s old — well within staleMs
    const claimId = await insertHealthRow({
      status: 'degraded',
      checked_at: recentCheckedAt,
      notes: 'prior send failed',
    });

    const outcome = await claimCronSlot({ supabase: admin, source: SOURCE, ictDate: ICT_DATE, now: NOW });
    expect(outcome).toEqual({ outcome: 'claimed', claimId });
  });

  it('reclaim race: two concurrent claims against the same stale pending row → exactly one wins', async () => {
    const staleCheckedAt = new Date(NOW.getTime() - DEFAULT_STALE_MS - 1000).toISOString();
    const claimId = await insertHealthRow({ status: 'pending', checked_at: staleCheckedAt });

    const [a, b] = await Promise.all([
      claimCronSlot({ supabase: admin, source: SOURCE, ictDate: ICT_DATE, now: NOW }),
      claimCronSlot({ supabase: admin, source: SOURCE, ictDate: ICT_DATE, now: NOW }),
    ]);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(['claimed', 'concurrent']);
    const winner = a.outcome === 'claimed' ? a : b;
    if (winner.outcome === 'claimed') {
      expect(winner.claimId).toBe(claimId);
    }
  });
});

describe('resolveCronClaim', () => {
  it("writes status/checked_at/table_row_counts/notes, preserves source/ict_date", async () => {
    const claim = await claimCronSlot({ supabase: admin, source: SOURCE, ictDate: ICT_DATE, now: NOW });
    expect(claim.outcome).toBe('claimed');
    if (claim.outcome !== 'claimed') return;
    createdHealthIds.push(String(claim.claimId));

    const resolvedAt = new Date(NOW.getTime() + 2000);
    await resolveCronClaim({
      supabase: admin,
      claimId: claim.claimId,
      status: 'ok',
      now: resolvedAt,
      payload: { source: SOURCE, ict_date: ICT_DATE, count: 3, message_id: 7 },
    });

    const { data: row } = await admin
      .from('system_health')
      .select('id, source, ict_date, status, table_row_counts, checked_at')
      .eq('id', claim.claimId)
      .single();

    expect(row).toMatchObject({
      source: SOURCE,
      ict_date: ICT_DATE,
      status: 'ok',
      table_row_counts: { source: SOURCE, ict_date: ICT_DATE, count: 3, message_id: 7 },
    });
    expect(new Date(row!.checked_at as string).getTime()).toBe(resolvedAt.getTime());
  });

  it("writes notes when provided (degraded path)", async () => {
    const claim = await claimCronSlot({ supabase: admin, source: SOURCE, ictDate: ICT_DATE, now: NOW });
    expect(claim.outcome).toBe('claimed');
    if (claim.outcome !== 'claimed') return;
    createdHealthIds.push(String(claim.claimId));

    await resolveCronClaim({
      supabase: admin,
      claimId: claim.claimId,
      status: 'degraded',
      now: NOW,
      payload: { source: SOURCE, ict_date: ICT_DATE, count: 0 },
      notes: 'stubbed failure',
    });

    const { data: row } = await admin
      .from('system_health')
      .select('status, notes')
      .eq('id', claim.claimId)
      .single();
    expect(row).toMatchObject({ status: 'degraded', notes: 'stubbed failure' });
  });
});
