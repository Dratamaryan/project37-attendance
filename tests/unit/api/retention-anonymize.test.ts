// Unit tests for GET /api/cron/retention-anonymize — auth + both passes.
// No DB: the admin client's rpc() is mocked. The SQL functions themselves are
// covered by tests/integration/retention-anonymize.test.ts and
// rsvp-retention.test.ts.
// Run: npm test -- retention-anonymize

import { vi, describe, it, expect, afterEach } from 'vitest';

const rpc = vi.fn();
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({ rpc })),
}));

import { GET } from '@/app/api/cron/retention-anonymize/route';

type RpcResult = { data: unknown; error: { message: string } | null };

function mockPasses(people: RpcResult, rsvps: RpcResult) {
  rpc.mockImplementation(async (fn: string) => {
    if (fn === 'run_retention_pass') return people;
    if (fn === 'run_rsvp_retention_pass') return rsvps;
    throw new Error(`unexpected rpc ${fn}`);
  });
}

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/cron/retention-anonymize', { headers });
}

describe('GET /api/cron/retention-anonymize', () => {
  const saved = process.env.CRON_SECRET;

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = saved;
    }
    vi.clearAllMocks();
  });

  it('AUTH-01: CRON_SECRET env unset → 500 config_drift, no pass runs', async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(makeRequest());
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false, error: 'config_drift' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('AUTH-02: no Authorization header → 401, no pass runs', async () => {
    process.env.CRON_SECRET = 'test-secret';
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ ok: false, error: 'unauthorized' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('AUTH-03: wrong Bearer value → 401, no pass runs', async () => {
    process.env.CRON_SECRET = 'test-secret';
    const res = await GET(makeRequest({ authorization: 'Bearer wrong-value' }));
    expect(res.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('correct Bearer → both passes with a NULL actor, 200 with both counts', async () => {
    process.env.CRON_SECRET = 'test-secret';
    mockPasses({ data: 2, error: null }, { data: 17, error: null });
    const res = await GET(makeRequest({ authorization: 'Bearer test-secret' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, anonymized_count: 2, rsvp_anonymized_count: 17 });
    expect(rpc).toHaveBeenCalledWith('run_retention_pass', { p_actor_user_id: null });
    expect(rpc).toHaveBeenCalledWith('run_rsvp_retention_pass', { p_actor_user_id: null });
  });

  it('people pass fails → RSVP pass still runs; 500 carries the RSVP count', async () => {
    process.env.CRON_SECRET = 'test-secret';
    mockPasses({ data: null, error: { message: 'people boom' } }, { data: 3, error: null });
    const res = await GET(makeRequest({ authorization: 'Bearer test-secret' }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      ok: false, error: 'infra_failure', message: 'people boom',
      anonymized_count: null, rsvp_anonymized_count: 3,
    });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('RSVP pass fails → 500 carries the people count', async () => {
    process.env.CRON_SECRET = 'test-secret';
    mockPasses({ data: 0, error: null }, { data: null, error: { message: 'rsvp boom' } });
    const res = await GET(makeRequest({ authorization: 'Bearer test-secret' }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      ok: false, error: 'infra_failure', message: 'rsvp boom',
      anonymized_count: 0, rsvp_anonymized_count: null,
    });
  });

  it('admin client throws → 500 infra_failure', async () => {
    process.env.CRON_SECRET = 'test-secret';
    rpc.mockRejectedValue(new Error('network down'));
    const res = await GET(makeRequest({ authorization: 'Bearer test-secret' }));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false, error: 'infra_failure' });
  });
});
