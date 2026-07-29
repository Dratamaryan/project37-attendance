// Unit tests for GET /api/cron/attendance-summary — auth layer + send_failed logging path.
// No DB, no Telegram: impl and admin client are fully mocked.
// Run: npm test -- attendance-summary

import { vi, describe, it, expect, afterEach } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn().mockReturnValue({}),
}));

vi.mock('@/lib/events/attendance-summary.impl', () => ({
  runAttendanceSummary: vi.fn(),
}));

import { GET } from '@/app/api/cron/attendance-summary/route';
import { runAttendanceSummary } from '@/lib/events/attendance-summary.impl';

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/cron/attendance-summary', { headers });
}

describe('GET /api/cron/attendance-summary', () => {
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
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: false, error: 'config_drift' });
  });

  it('AUTH-02: CRON_SECRET set, no Authorization header → 401 unauthorized', async () => {
    process.env.CRON_SECRET = 'test-secret';
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: false, error: 'unauthorized' });
  });

  it('AUTH-03: CRON_SECRET set, wrong Bearer value → 401 unauthorized', async () => {
    process.env.CRON_SECRET = 'test-secret';
    const res = await GET(makeRequest({ authorization: 'Bearer wrong-value' }));
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: false, error: 'unauthorized' });
  });

  it('AUTH-04: correct Bearer, empty day → impl invoked, 200 with result shape', async () => {
    process.env.CRON_SECRET = 'test-secret';
    vi.mocked(runAttendanceSummary).mockResolvedValue({ status: 'empty', ict_date: '2026-07-29' });
    const res = await GET(makeRequest({ authorization: 'Bearer test-secret' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, status: 'empty', ict_date: '2026-07-29' });
    expect(runAttendanceSummary).toHaveBeenCalledOnce();
  });

  it('no check-ins today → still 200, no throw', async () => {
    process.env.CRON_SECRET = 'test-secret';
    vi.mocked(runAttendanceSummary).mockResolvedValue({ status: 'empty', ict_date: '2026-07-29' });
    const res = await GET(makeRequest({ authorization: 'Bearer test-secret' }));
    expect(res.status).toBe(200);
  });

  it('send_failed result → 200 (logged, not thrown as an infra failure)', async () => {
    process.env.CRON_SECRET = 'test-secret';
    vi.mocked(runAttendanceSummary).mockResolvedValue({
      status: 'send_failed',
      ict_date: '2026-07-29',
      count: 12,
      reason: 'network_error',
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await GET(makeRequest({ authorization: 'Bearer test-secret' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, status: 'send_failed' });
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('impl throws (infra failure) → 500 infra_failure, not an uncaught rejection', async () => {
    process.env.CRON_SECRET = 'test-secret';
    vi.mocked(runAttendanceSummary).mockRejectedValue(new Error('attendance read failed'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await GET(makeRequest({ authorization: 'Bearer test-secret' }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: false, error: 'infra_failure' });
    consoleErrorSpy.mockRestore();
  });
});
