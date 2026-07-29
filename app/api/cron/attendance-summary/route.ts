import { createAdminClient } from '@/lib/supabase/admin';
import { runAttendanceSummary } from '@/lib/events/attendance-summary.impl';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  // Loud-fail on missing env — config drift is a deployment bug, not a caller error
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error('[attendance-summary] CRON_SECRET not configured — config drift');
    return Response.json({ ok: false, error: 'config_drift' }, { status: 500 });
  }

  const auth = request.headers.get('authorization');
  if (auth !== `Bearer ${cronSecret}`) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  try {
    const supabase = createAdminClient();
    const result = await runAttendanceSummary({ supabase, now: new Date() });

    // Send failures must log and skip, not throw — the summary already recorded a
    // 'degraded' system_health row; a 500 here would be a false infra-failure signal.
    if (result.status === 'send_failed') {
      console.error('[attendance-summary] Telegram send failed:', result.reason);
    }

    return Response.json({ ok: true, ...result }, { status: 200 });
  } catch (err) {
    console.error('[attendance-summary] infrastructure failure:', err);
    return Response.json(
      { ok: false, error: 'infra_failure', message: String(err) },
      { status: 500 },
    );
  }
}
