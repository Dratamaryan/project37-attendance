import { createAdminClient } from '@/lib/supabase/admin';
import { materializeEvents } from '@/lib/events/materialize.impl';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  // Loud-fail on missing env — config drift is a deployment bug, not a caller error
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error('[materialize-events] CRON_SECRET not configured — config drift');
    return Response.json({ ok: false, error: 'config_drift' }, { status: 500 });
  }

  const auth = request.headers.get('authorization');
  if (auth !== `Bearer ${cronSecret}`) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  try {
    const supabase = createAdminClient();
    const result = await materializeEvents({ supabase, now: new Date() });
    return Response.json({ ok: true, ...result }, { status: 200 });
  } catch (err) {
    console.error('[materialize-events] infrastructure failure:', err);
    return Response.json(
      { ok: false, error: 'infra_failure', message: String(err) },
      { status: 500 },
    );
  }
}
