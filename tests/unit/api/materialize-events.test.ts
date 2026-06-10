// Unit tests for GET /api/cron/materialize-events — auth layer only.
// No DB: impl and admin client are fully mocked.
// Run: npm test -- materialize-events

import { vi, describe, it, expect, afterEach } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn().mockReturnValue({}),
}));

vi.mock('@/lib/events/materialize.impl', () => ({
  materializeEvents: vi.fn(),
}));

import { GET } from '@/app/api/cron/materialize-events/route';
import { materializeEvents } from '@/lib/events/materialize.impl';

const FIXED_RESULT = {
  horizon_months: 12,
  events_processed: 2,
  instances_inserted: 38,
  instances_pruned: 0,
  events_with_errors: [],
};

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/cron/materialize-events', { headers });
}

describe('GET /api/cron/materialize-events — auth', () => {
  const saved = process.env.CRON_SECRET;

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = saved;
    }
    vi.clearAllMocks();
  });

  it('AUTH-01: CRON_SECRET env unset → 500 config_drift', async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(makeRequest());
    expect(res.status).toBe(500);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ ok: false, error: 'config_drift' });
  });

  it('AUTH-02: CRON_SECRET set, no Authorization header → 401 unauthorized', async () => {
    process.env.CRON_SECRET = 'test-secret';
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ ok: false, error: 'unauthorized' });
  });

  it('AUTH-03: CRON_SECRET set, wrong Bearer value → 401 unauthorized', async () => {
    process.env.CRON_SECRET = 'test-secret';
    const res = await GET(makeRequest({ authorization: 'Bearer wrong-value' }));
    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ ok: false, error: 'unauthorized' });
  });

  it('AUTH-04: correct Bearer → impl invoked, 200 with result shape', async () => {
    process.env.CRON_SECRET = 'test-secret';
    vi.mocked(materializeEvents).mockResolvedValue(FIXED_RESULT);
    const res = await GET(makeRequest({ authorization: 'Bearer test-secret' }));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, ...FIXED_RESULT });
    expect(materializeEvents).toHaveBeenCalledOnce();
  });
});
