import type { SupabaseClient } from '@supabase/supabase-js';
import { addMonths } from 'date-fns';
import { expandRRule } from '@/lib/events/recurrence';

export type MaterializeInput = {
  /** MUST be the admin (service-role) client — bypasses RLS */
  supabase: SupabaseClient;
  now: Date;
  /** Fallback if app_settings row is missing or column is null; default 12 */
  defaultHorizonMonths?: number;
};

export type EventError = {
  event_id: string;
  event_name: string;
  reason: 'invalid_rrule' | 'invalid_input' | 'upsert_failed';
  message: string;
};

export type MaterializeResult = {
  horizon_months: number;
  events_processed: number;
  instances_inserted: number;
  instances_pruned: number;
  events_with_errors: EventError[];
};

type AppSettingsRow = { materialization_horizon_mo: number | null };
type ActiveEventRow = {
  id: string;
  name: string;
  name_id: string | null;
  start_date: string;
  start_time: string;
  recurrence_rule: string | null;
};

export async function materializeEvents(input: MaterializeInput): Promise<MaterializeResult> {
  const { supabase, now, defaultHorizonMonths = 12 } = input;

  // 1. Read horizon from app_settings
  let horizonMonths = defaultHorizonMonths;
  const { data: rawSettings, error: settingsError } = await supabase
    .from('app_settings')
    .select('materialization_horizon_mo')
    .limit(1)
    .maybeSingle();

  if (settingsError) {
    throw new Error(`Failed to read app_settings: ${settingsError.message}`);
  }

  const settings = rawSettings as AppSettingsRow | null;
  if (settings?.materialization_horizon_mo != null) {
    horizonMonths = settings.materialization_horizon_mo;
  } else {
    console.warn(
      '[materialize-events] app_settings row missing or materialization_horizon_mo is null — using default:',
      defaultHorizonMonths,
    );
  }

  // 2. Fetch active events
  const { data: rawEvents, error: eventsError } = await supabase
    .from('events')
    .select('id, name, name_id, start_date, start_time, recurrence_rule')
    .eq('active', true);

  if (eventsError) {
    throw new Error(`Failed to fetch events: ${eventsError.message}`);
  }

  const activeEvents = (rawEvents as ActiveEventRow[]) ?? [];
  let instances_inserted = 0;
  const events_with_errors: EventError[] = [];

  // 3. For each active event, expand RRULE and upsert instances
  for (const row of activeEvents) {
    try {
      const expandResult = expandRRule({
        recurrenceRule: row.recurrence_rule,
        startDate: row.start_date,
        startTime: row.start_time,
        horizonMonths,
        now,
      });

      if (expandResult.status === 'invalid_rrule' || expandResult.status === 'invalid_input') {
        events_with_errors.push({
          event_id: row.id,
          event_name: row.name,
          reason: expandResult.status,
          message: expandResult.message,
        });
        continue;
      }

      if (expandResult.occurrences.length === 0) {
        continue;
      }

      const insertRows = expandResult.occurrences.map((occ) => ({
        event_id: row.id,
        scheduled_at: occ.toISOString(),
        event_name_snapshot: row.name,
        event_name_snapshot_id: row.name_id ?? null,
        status: 'scheduled' as const,
      }));

      // ON CONFLICT (event_id, scheduled_at) DO NOTHING — idempotent re-runs
      const { data: inserted, error: insertError } = await supabase
        .from('event_instances')
        .upsert(insertRows, { onConflict: 'event_id,scheduled_at', ignoreDuplicates: true })
        .select('id');

      if (insertError) {
        events_with_errors.push({
          event_id: row.id,
          event_name: row.name,
          reason: 'upsert_failed',
          message: insertError.message,
        });
        continue;
      }

      instances_inserted += (inserted ?? []).length;
    } catch (e) {
      events_with_errors.push({
        event_id: row.id,
        event_name: row.name,
        reason: 'upsert_failed',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // 4. Prune: delete scheduled instances beyond the new horizon
  //    Never touches cancelled or completed — those are historical truth.
  const horizonEnd = addMonths(now, horizonMonths);
  const { count: pruneCount, error: pruneError } = await supabase
    .from('event_instances')
    .delete({ count: 'exact' })
    .eq('status', 'scheduled')
    .gt('scheduled_at', horizonEnd.toISOString());

  if (pruneError) {
    throw new Error(`Failed to prune event_instances: ${pruneError.message}`);
  }

  const result: MaterializeResult = {
    horizon_months: horizonMonths,
    events_processed: activeEvents.length,
    instances_inserted,
    instances_pruned: pruneCount ?? 0,
    events_with_errors,
  };

  // 5. Write observability row — non-fatal: materialization succeeded even if this fails.
  //    Use source:'materialize-events' so rows are filterable apart from heartbeat rows.
  const { error: healthErr } = await supabase.from('system_health').insert({
    table_row_counts: {
      source: 'materialize-events',
      horizon_months: result.horizon_months,
      events_processed: result.events_processed,
      instances_inserted: result.instances_inserted,
      instances_pruned: result.instances_pruned,
      error_count: result.events_with_errors.length,
    },
    status: result.events_with_errors.length > 0 ? 'degraded' : 'ok',
  });
  if (healthErr) {
    console.warn('[materialize-events] system_health write failed:', healthErr.message);
  }

  return result;
}
