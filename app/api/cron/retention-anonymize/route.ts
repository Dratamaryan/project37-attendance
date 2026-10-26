import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * S6-T4 scheduled retention pass, extended in S9-R5. Calls run_retention_pass()
 * (people) and run_rsvp_retention_pass() (event_rsvps) — both SECURITY
 * DEFINER, service_role-only EXECUTE — via the admin client. No user JWT in
 * this context, so log_audit() inside the SQL functions attributes every
 * audit row to actor_user_id = NULL ('system', see audit-log UI). Double-fire
 * safe: both functions filter on anonymized_at IS NULL, so a repeat run is a
 * no-op.
 *
 * Both passes always run, each in its own transaction: a failure in one must
 * not hold back the other (the RSVP pass is separate precisely so the people
 * pass's NULL-horizon guard can't switch it off). Either failing -> 500 with
 * whatever counts did come back.
 */
export async function GET(request: Request) {
  // Loud-fail on missing env — config drift is a deployment bug, not a caller error
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error('[retention-anonymize] CRON_SECRET not configured — config drift');
    return Response.json({ ok: false, error: 'config_drift' }, { status: 500 });
  }

  const auth = request.headers.get('authorization');
  if (auth !== `Bearer ${cronSecret}`) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  try {
    const supabase = createAdminClient();
    const people = await supabase.rpc('run_retention_pass', { p_actor_user_id: null });
    const rsvps = await supabase.rpc('run_rsvp_retention_pass', { p_actor_user_id: null });

    const counts = {
      anonymized_count: people.error ? null : (people.data as number),
      rsvp_anonymized_count: rsvps.error ? null : (rsvps.data as number),
    };

    if (people.error || rsvps.error) {
      if (people.error) console.error('[retention-anonymize] run_retention_pass failed:', people.error);
      if (rsvps.error) console.error('[retention-anonymize] run_rsvp_retention_pass failed:', rsvps.error);
      return Response.json(
        {
          ok: false,
          error: 'infra_failure',
          message: [people.error?.message, rsvps.error?.message].filter(Boolean).join('; '),
          ...counts,
        },
        { status: 500 },
      );
    }

    return Response.json({ ok: true, ...counts }, { status: 200 });
  } catch (err) {
    console.error('[retention-anonymize] infrastructure failure:', err);
    return Response.json(
      { ok: false, error: 'infra_failure', message: String(err) },
      { status: 500 },
    );
  }
}
