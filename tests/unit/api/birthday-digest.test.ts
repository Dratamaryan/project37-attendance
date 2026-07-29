// Unit tests for GET /api/cron/birthday-digest — auth layer + send_failed logging path.
// No DB, no Telegram: impl and admin client are fully mocked.
// Run: npm test -- birthday-digest

import { vi, describe, it, expect, afterEach } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn().mockReturnValue({}),
}));

vi.mock('@/lib/events/birthday-digest.impl', () => ({
  runBirthdayDigest: vi.fn(),
}));

import { GET } from '@/app/api/cron/birthday-digest/route';
import { runBirthdayDigest } from '@/lib/events/birthday-digest.impl';

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/cron/birthday-digest', { headers });
}

describe('GET /api/cron/birthday-digest', () => {
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
    vi.mocked(runBirthdayDigest).mockResolvedValue({ status: 'empty', ict_date: '2026-07-29' });
    const res = await GET(makeRequest({ authorization: 'Bearer test-secret' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, status: 'empty', ict_date: '2026-07-29' });
    expect(runBirthdayDigest).toHaveBeenCalledOnce();
  });

  it('T4-04: correct Bearer, no birthdays today → still 200, no throw', async () => {
    process.env.CRON_SECRET = 'test-secret';
    vi.mocked(runBirthdayDigest).mockResolvedValue({ status: 'empty', ict_date: '2026-07-29' });
    const res = await GET(makeRequest({ authorization: 'Bearer test-secret' }));
    expect(res.status).toBe(200);
  });

  it('send_failed result → 200 (logged, not thrown as an infra failure)', async () => {
    process.env.CRON_SECRET = 'test-secret';
    vi.mocked(runBirthdayDigest).mockResolvedValue({
      status: 'send_failed',
      ict_date: '2026-07-29',
      count: 1,
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
    vi.mocked(runBirthdayDigest).mockRejectedValue(new Error('people read failed'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await GET(makeRequest({ authorization: 'Bearer test-secret' }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: false, error: 'infra_failure' });
    consoleErrorSpy.mockRestore();
  });
});
