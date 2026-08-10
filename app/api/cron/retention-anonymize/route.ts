import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * S6-T4 scheduled retention pass. Calls run_retention_pass() (SECURITY
 * DEFINER, service_role-only EXECUTE) via the admin client — no user JWT in
 * this context, so log_audit() inside the SQL function attributes every
 * anonymize row to actor_user_id = NULL ('system', see audit-log UI). Double
 * -fire safe: the SQL function's anonymized_at IS NULL eligibility filter
 * makes a repeat run a no-op, no separate dedupe needed.
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
    const { data, error } = await supabase.rpc('run_retention_pass', { p_actor_user_id: null });

    if (error) throw error;

    return Response.json({ ok: true, anonymized_count: data }, { status: 200 });
  } catch (err) {
    console.error('[retention-anonymize] infrastructure failure:', err);
    return Response.json(
      { ok: false, error: 'infra_failure', message: String(err) },
      { status: 500 },
    );
  }
}
