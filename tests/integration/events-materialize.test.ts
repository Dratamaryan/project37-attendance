// Integration tests for Sprint 2 Task 4 — materialization cron impl.
// Runs against local Docker Supabase (configured in .env.test.local).
// Prerequisite: sprint2 migration applied (supabase db reset).
// The test is self-contained: it finds-or-creates the 2 seed events and
// cleans up only what it created.
// Run: npm test -- materialize

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { materializeEvents } from '@/lib/events/materialize.impl';
import { formatJakarta } from '@/lib/events/timezone';

// Fixed now for determinism across all materialization tests
const NOW = new Date('2026-07-01T00:00:00.000Z');

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !serviceRoleKey) {
  throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
}

// Distinct from sprint2-rls fake admin (099) to avoid cross-test teardown conflict
const FAKE_ADMIN_ID = '00000000-0000-0000-0000-000000000098';

let admin: SupabaseClient;
let projectDayId: string;
let tribeConnectId: string;
let createdProjectDay = false;
let createdTribeConnect = false;
let invalidRuleEventId: string | null = null;

beforeAll(async () => {
  admin = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Ensure a service-account app_users row exists.
  // app_users.id has no FK to auth.users, so any UUID works here.
  await admin.from('app_users').upsert(
    {
      id: FAKE_ADMIN_ID,
      email: 'fake-admin@mat-test.invalid',
      full_name: 'Materialize Test Admin',
      role: 'admin',
      active: true,
    },
    { onConflict: 'id' },
  );

  // Find or create "Project Day" event
  const { data: existingPd } = await admin
    .from('events')
    .select('id')
    .eq('name', 'Project Day')
    .limit(1)
    .maybeSingle();

  if (existingPd) {
    projectDayId = (existingPd as { id: string }).id;
  } else {
    const { data: pd, error: pdErr } = await admin
      .from('events')
      .insert({
        name: 'Project Day',
        name_id: 'Project Day',
        event_type: 'friday_biweekly',
        start_date: '2026-07-10',
        start_time: '18:00:00',
        duration_min: 120,
        location: 'Hotel Neo Puri Indah',
        recurrence_rule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=FR',
        active: true,
        created_by: FAKE_ADMIN_ID,
      })
      .select('id')
      .single();
    if (pdErr || !pd) throw new Error(`Failed to insert Project Day: ${pdErr?.message}`);
    projectDayId = (pd as { id: string }).id;
    createdProjectDay = true;
  }

  // Find or create "Tribe Connect" event
  const { data: existingTc } = await admin
    .from('events')
    .select('id')
    .eq('name', 'Tribe Connect')
    .limit(1)
    .maybeSingle();

  if (existingTc) {
    tribeConnectId = (existingTc as { id: string }).id;
  } else {
    const { data: tc, error: tcErr } = await admin
      .from('events')
      .insert({
        name: 'Tribe Connect',
        name_id: 'Obor Doa',
        event_type: 'sunday_monthly',
        start_date: '2026-07-05',
        start_time: '15:00:00',
        duration_min: 120,
        location: 'Sutera Onyx XI no 10-12',
        recurrence_rule: 'FREQ=MONTHLY;BYDAY=1SU',
        active: true,
        created_by: FAKE_ADMIN_ID,
      })
      .select('id')
      .single();
    if (tcErr || !tc) throw new Error(`Failed to insert Tribe Connect: ${tcErr?.message}`);
    tribeConnectId = (tc as { id: string }).id;
    createdTribeConnect = true;
  }
}, 30_000);

afterAll(async () => {
  // Cleanup in FK-safe order: instances first (cascade), then events, then admin user
  await admin.from('event_instances').delete().not('id', 'is', null);
  if (invalidRuleEventId) {
    await admin.from('events').delete().eq('id', invalidRuleEventId);
  }
  if (createdProjectDay) await admin.from('events').delete().eq('id', projectDayId);
  if (createdTribeConnect) await admin.from('events').delete().eq('id', tribeConnectId);
  await admin.from('app_users').delete().eq('id', FAKE_ADMIN_ID);
}, 30_000);

afterEach(async () => {
  // Truncate all event_instances and restore mutable state after each test
  await admin.from('event_instances').delete().not('id', 'is', null);
  await admin.from('app_settings').update({ materialization_horizon_mo: 12 }).eq('id', 1);
  await admin.from('events').update({ active: true }).eq('id', projectDayId);
  if (invalidRuleEventId) {
    await admin.from('events').delete().eq('id', invalidRuleEventId);
    invalidRuleEventId = null;
  }
}, 20_000);

describe('materializeEvents integration', () => {
  it('MAT-01: first run on empty event_instances → 38 inserted, 0 pruned, 0 errors', async () => {
    const result = await materializeEvents({ supabase: admin, now: NOW });
    expect(result.events_processed).toBe(2);
    expect(result.instances_inserted).toBe(38);
    expect(result.instances_pruned).toBe(0);
    expect(result.events_with_errors).toEqual([]);

    const { count } = await admin
      .from('event_instances')
      .select('*', { count: 'exact', head: true });
    expect(count).toBe(38);
  });

  it('MAT-02: idempotency — second run inserts 0, total count stays 38', async () => {
    await materializeEvents({ supabase: admin, now: NOW });
    const result = await materializeEvents({ supabase: admin, now: NOW });
    expect(result.instances_inserted).toBe(0);
    expect(result.instances_pruned).toBe(0);

    const { count } = await admin
      .from('event_instances')
      .select('*', { count: 'exact', head: true });
    expect(count).toBe(38);
  });

  it('MAT-03: inactive Project Day — only Tribe Connect materialises (12 rows, events_processed=1)', async () => {
    await admin.from('events').update({ active: false }).eq('id', projectDayId);
    const result = await materializeEvents({ supabase: admin, now: NOW });
    expect(result.events_processed).toBe(1);
    expect(result.instances_inserted).toBe(12);
    expect(result.events_with_errors).toEqual([]);

    const { count } = await admin
      .from('event_instances')
      .select('*', { count: 'exact', head: true });
    expect(count).toBe(12);
  });

  it('MAT-04: snapshot integrity + Jakarta timezone round-trip', async () => {
    await materializeEvents({ supabase: admin, now: NOW });

    // Project Day: first instance is 2026-07-10T11:00:00Z → Jakarta 2026-07-10 18:00
    const { data: pdRows } = await admin
      .from('event_instances')
      .select('event_name_snapshot, event_name_snapshot_id, scheduled_at')
      .eq('event_id', projectDayId)
      .order('scheduled_at', { ascending: true })
      .limit(1);
    const pdFirst = (
      pdRows as {
        event_name_snapshot: string;
        event_name_snapshot_id: string | null;
        scheduled_at: string;
      }[]
    )?.[0];
    expect(pdFirst).toBeDefined();
    expect(pdFirst.event_name_snapshot).toBe('Project Day');
    expect(pdFirst.event_name_snapshot_id).toBe('Project Day');
    expect(formatJakarta(new Date(pdFirst.scheduled_at), 'yyyy-MM-dd HH:mm')).toBe(
      '2026-07-10 18:00',
    );

    // Tribe Connect: first instance is 2026-07-05T08:00:00Z → Jakarta 2026-07-05 15:00
    const { data: tcRows } = await admin
      .from('event_instances')
      .select('event_name_snapshot, event_name_snapshot_id, scheduled_at')
      .eq('event_id', tribeConnectId)
      .order('scheduled_at', { ascending: true })
      .limit(1);
    const tcFirst = (
      tcRows as {
        event_name_snapshot: string;
        event_name_snapshot_id: string | null;
        scheduled_at: string;
      }[]
    )?.[0];
    expect(tcFirst).toBeDefined();
    expect(tcFirst.event_name_snapshot).toBe('Tribe Connect');
    expect(tcFirst.event_name_snapshot_id).toBe('Obor Doa');
    expect(formatJakarta(new Date(tcFirst.scheduled_at), 'yyyy-MM-dd HH:mm')).toBe(
      '2026-07-05 15:00',
    );
  });

  it('MAT-05: horizon shrink prunes future scheduled rows; cancelled/completed survive', async () => {
    // Establish 38-row baseline
    await materializeEvents({ supabase: admin, now: NOW });

    // Pre-seed one cancelled + one completed instance beyond the 6-month horizon.
    // Timestamps deliberately NOT matching any RRULE occurrence to avoid unique constraint:
    //   2027-02-15T11:00:00Z is a Monday — NOT a biweekly Friday (Project Day)
    //   2027-02-10T08:00:00Z is a Wednesday — NOT the 1st Sunday (Tribe Connect)
    const { data: extraRows, error: extraErr } = await admin
      .from('event_instances')
      .insert([
        {
          event_id: projectDayId,
          scheduled_at: '2027-02-15T11:00:00Z',
          event_name_snapshot: 'Project Day',
          event_name_snapshot_id: 'Project Day',
          status: 'cancelled',
        },
        {
          event_id: tribeConnectId,
          scheduled_at: '2027-02-10T08:00:00Z',
          event_name_snapshot: 'Tribe Connect',
          event_name_snapshot_id: 'Obor Doa',
          status: 'completed',
        },
      ])
      .select('id');
    if (extraErr) throw new Error(`Failed to insert special-status rows: ${extraErr.message}`);
    const specialIds = (extraRows as { id: string }[]).map((r) => r.id);

    // Shrink horizon to 6 months
    await admin.from('app_settings').update({ materialization_horizon_mo: 6 }).eq('id', 1);

    const result = await materializeEvents({ supabase: admin, now: NOW });
    expect(result.instances_pruned).toBeGreaterThan(0);

    // Scheduled rows remaining: 13 (Project Day 6mo) + 6 (Tribe Connect 6mo) = 19
    const { count: scheduledCount } = await admin
      .from('event_instances')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'scheduled');
    expect(scheduledCount).toBe(19);

    // Cancelled and completed rows survived the prune
    const { data: survived } = await admin
      .from('event_instances')
      .select('id')
      .in('id', specialIds);
    expect((survived as { id: string }[]).length).toBe(2);
  });

  it('MAT-06: invalid RRULE on one event — two valid events still materialise, error collected', async () => {
    const { data: badEvent, error: badErr } = await admin
      .from('events')
      .insert({
        name: 'Bad RRULE Event',
        event_type: 'other_recurring',
        start_date: '2026-07-10',
        start_time: '10:00:00',
        recurrence_rule: 'GARBAGE_RULE',
        active: true,
        created_by: FAKE_ADMIN_ID,
      })
      .select('id')
      .single();
    if (badErr || !badEvent) throw new Error(`Failed to insert bad event: ${badErr?.message}`);
    invalidRuleEventId = (badEvent as { id: string }).id;

    const result = await materializeEvents({ supabase: admin, now: NOW });
    expect(result.events_processed).toBe(3);
    expect(result.instances_inserted).toBe(38);
    expect(result.events_with_errors).toHaveLength(1);
    expect(result.events_with_errors[0].reason).toBe('invalid_rrule');
  });

  it('MAT-08: system_health row written per run with source field and metrics', async () => {
    const { count: before } = await admin
      .from('system_health')
      .select('*', { count: 'exact', head: true });

    const result = await materializeEvents({ supabase: admin, now: NOW });

    const { count: after } = await admin
      .from('system_health')
      .select('*', { count: 'exact', head: true });
    expect(after).toBe((before ?? 0) + 1);

    const { data: latest } = await admin
      .from('system_health')
      .select('table_row_counts, status')
      .order('checked_at', { ascending: false })
      .limit(1)
      .single();
    const payload = (latest as { table_row_counts: Record<string, unknown>; status: string })
      .table_row_counts;
    expect(payload.source).toBe('materialize-events');
    expect(payload.instances_inserted).toBe(result.instances_inserted);
    expect(payload.events_processed).toBe(result.events_processed);
  });

  it('MAT-07: determinism — two runs with identical now produce identical row sets', async () => {
    await materializeEvents({ supabase: admin, now: NOW });

    const { data: rows1 } = await admin
      .from('event_instances')
      .select('event_id, scheduled_at')
      .order('scheduled_at', { ascending: true });

    // Second run: all conflict (0 inserts), nothing pruned
    await materializeEvents({ supabase: admin, now: NOW });

    const { data: rows2 } = await admin
      .from('event_instances')
      .select('event_id, scheduled_at')
      .order('scheduled_at', { ascending: true });

    const toKeys = (rows: { event_id: string; scheduled_at: string }[]) =>
      rows.map((r) => `${r.event_id}|${r.scheduled_at}`);

    expect(
      toKeys(rows1 as { event_id: string; scheduled_at: string }[]),
    ).toEqual(
      toKeys(rows2 as { event_id: string; scheduled_at: string }[]),
    );
  });
});
