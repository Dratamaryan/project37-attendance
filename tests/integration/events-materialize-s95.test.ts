// Integration tests for S9.5-T2 — Fri→Sat via a new 2nd-Saturday series.
// A retired series (event inactive + its Nov+ instances cancelled) must not be
// re-materialized; the new saturday_monthly series materializes exactly 12
// Saturdays once and is idempotent.
// Runs against local Docker Supabase (.env.test.local); needs migration
// 20261027180000_s9_5_t2_saturday_monthly_enum.sql applied.
// Run: npm test -- events-materialize-s95

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { materializeEvents } from '@/lib/events/materialize.impl';
import { formatJakarta } from '@/lib/events/timezone';

const NOW = new Date('2026-11-02T00:00:00.000Z');
const NOV_1_WIB = '2026-10-31T17:00:00.000Z';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !serviceRoleKey) {
  throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
}

// Distinct from the other materialize/RLS fixture admins (097 is unused elsewhere)
const FAKE_ADMIN_ID = '00000000-0000-0000-0000-000000000097';
const ts = Date.now();

let admin: SupabaseClient;
let fridayEventId: string;
let saturdayEventId: string | null = null;

type InstanceRow = { id: string; scheduled_at: string; status: string };

async function instancesOf(eventId: string): Promise<InstanceRow[]> {
  const { data, error } = await admin
    .from('event_instances')
    .select('id, scheduled_at, status')
    .eq('event_id', eventId)
    .order('scheduled_at', { ascending: true });
  if (error) throw new Error(`read instances: ${error.message}`);
  return (data ?? []) as InstanceRow[];
}

beforeAll(async () => {
  admin = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  await admin.from('app_users').upsert(
    {
      id: FAKE_ADMIN_ID,
      email: 'fake-admin@mat-s95-test.invalid',
      full_name: 'Materialize S95 Test Admin',
      role: 'admin',
      active: true,
    },
    { onConflict: 'id' },
  );

  const { data, error } = await admin
    .from('events')
    .insert({
      name: `S95 Friday ${ts}`,
      event_type: 'friday_monthly',
      start_date: '2026-07-10',
      start_time: '18:00:00',
      duration_min: 120,
      recurrence_rule: 'FREQ=MONTHLY;BYDAY=2FR',
      active: true,
      created_by: FAKE_ADMIN_ID,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`insert friday event: ${error?.message}`);
  fridayEventId = (data as { id: string }).id;
}, 30_000);

afterAll(async () => {
  // Deleting the fixture events cascades to their instances only.
  const ids = [fridayEventId, saturdayEventId].filter((v): v is string => !!v);
  if (ids.length) await admin.from('events').delete().in('id', ids);
  await admin.from('app_users').delete().eq('id', FAKE_ADMIN_ID);
}, 30_000);

describe('S9.5-T2 materializer — retire Friday, add 2nd-Saturday series', () => {
  it('MAT-S95-01: retired series (inactive + Nov+ cancelled) — re-run inserts 0 rows for it', async () => {
    await materializeEvents({ supabase: admin, now: NOW });
    const before = await instancesOf(fridayEventId);
    expect(before).toHaveLength(12);
    expect(before.every(r => r.status === 'scheduled')).toBe(true);

    // Retire: same writes as scripts/s9-5/t2-retire-friday-series.*.sql
    const { error: deactErr } = await admin.from('events').update({ active: false }).eq('id', fridayEventId);
    expect(deactErr).toBeNull();
    const { data: cancelled, error: cancelErr } = await admin
      .from('event_instances')
      .update({ status: 'cancelled', notes: 'S9.5: moved to 2nd Saturday from Nov 2026' })
      .eq('event_id', fridayEventId)
      .eq('status', 'scheduled')
      .gte('scheduled_at', NOV_1_WIB)
      .select('id');
    expect(cancelErr).toBeNull();
    expect(cancelled).toHaveLength(12);

    await materializeEvents({ supabase: admin, now: NOW });
    const after = await instancesOf(fridayEventId);
    expect(after.map(r => r.id).sort()).toEqual(before.map(r => r.id).sort());
    expect(after.every(r => r.status === 'cancelled')).toBe(true);
  });

  it('MAT-S95-02: new saturday_monthly 2SA series @15:00 → exactly 12 Saturdays; second run → 0 new', async () => {
    const { data, error } = await admin
      .from('events')
      .insert({
        name: `S95 Saturday ${ts}`,
        event_type: 'saturday_monthly',
        start_date: '2026-11-14',
        start_time: '15:00:00',
        duration_min: 180,
        recurrence_rule: 'FREQ=MONTHLY;BYDAY=2SA',
        active: true,
        created_by: FAKE_ADMIN_ID,
      })
      .select('id')
      .single();
    expect(error).toBeNull();
    saturdayEventId = (data as { id: string }).id;

    await materializeEvents({ supabase: admin, now: NOW });
    const first = await instancesOf(saturdayEventId);
    expect(first.map(r => formatJakarta(new Date(r.scheduled_at), 'yyyy-MM-dd'))).toEqual([
      '2026-11-14', '2026-12-12', '2027-01-09', '2027-02-13', '2027-03-13', '2027-04-10',
      '2027-05-08', '2027-06-12', '2027-07-10', '2027-08-14', '2027-09-11', '2027-10-09',
    ]);
    for (const r of first) {
      expect(formatJakarta(new Date(r.scheduled_at), 'i HH:mm')).toBe('6 15:00');
      expect(r.status).toBe('scheduled');
    }

    await materializeEvents({ supabase: admin, now: NOW });
    const second = await instancesOf(saturdayEventId);
    expect(second.map(r => r.id)).toEqual(first.map(r => r.id));

    // The retired Friday series is still untouched by the second run.
    const friday = await instancesOf(fridayEventId);
    expect(friday).toHaveLength(12);
    expect(friday.every(r => r.status === 'cancelled')).toBe(true);
  });
});
