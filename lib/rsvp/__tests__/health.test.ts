// Unit tests for the S9-R6 A2 RSVP health check (lib/rsvp/health.impl.ts).
// The RPC and the Turnstile classifier are injected fakes — no network, no DB.
// The real RPC is covered in tests/integration/rsvp-health.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('server-only', () => ({}))

import {
  RSVP_HEALTH_PROBE_TOKEN,
  impl_runRsvpHealthCheck,
  type RsvpHealthDeps,
} from '../health.impl'

const ENV_KEYS = [
  'VERCEL_ENV',
  'RSVP_PUBLIC_ENABLED',
  'RSVP_GATE_SECRET',
  'RSVP_TURNSTILE_ENABLED',
  'RSVP_TURNSTILE_SITE_KEY',
  'RSVP_TURNSTILE_SECRET_KEY',
] as const
const ORIGINAL = ENV_KEYS.map((k) => process.env[k])

function setEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

function deps(rpcResult: unknown, classify: RsvpHealthDeps['classifyTurnstileSecret'] = async () => 'valid') {
  const rpc = vi.fn<RsvpHealthDeps['rpc']>(async () => rpcResult as { data: unknown; error: unknown })
  const classifyTurnstileSecret = vi.fn(classify)
  return { rpc, classifyTurnstileSecret }
}

beforeEach(() => {
  ENV_KEYS.forEach((k) => setEnv(k, undefined))
  setEnv('RSVP_GATE_SECRET', 'unit-gate')
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  ENV_KEYS.forEach((k, i) => setEnv(k, ORIGINAL[i]))
  vi.restoreAllMocks()
})

describe('impl_runRsvpHealthCheck — gate mapping', () => {
  it.each([
    ['code closed', { data: { ok: false, code: 'closed' }, error: null }, 'match'],
    ['code unavailable', { data: { ok: false, code: 'unavailable' }, error: null }, 'mismatch'],
    ['ok:true (must never happen)', { data: { ok: true }, error: null }, 'unknown'],
    ['code invalid', { data: { ok: false, code: 'invalid' }, error: null }, 'unknown'],
    ['code limit', { data: { ok: false, code: 'limit' }, error: null }, 'unknown'],
    ['null data', { data: null, error: null }, 'unknown'],
    ['RPC error', { data: null, error: { code: '42501', message: 'permission denied' } }, 'unknown'],
  ])('%s -> %s', async (_label, rpcResult, expected) => {
    const d = deps(rpcResult)
    expect((await impl_runRsvpHealthCheck(d)).gate).toBe(expected)
  })

  it('ok:true is flagged loudly', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await impl_runRsvpHealthCheck(deps({ data: { ok: true }, error: null }))
    expect(JSON.stringify(err.mock.calls)).toContain('ok:true')
  })

  it('RPC throw -> unknown', async () => {
    const d = deps(null)
    d.rpc.mockRejectedValue(new Error('network'))
    expect((await impl_runRsvpHealthCheck(d)).gate).toBe('unknown')
  })

  it('RPC hang -> unknown within the deadline', async () => {
    const d = deps(null)
    d.rpc.mockImplementation(() => new Promise(() => {}))
    const res = await impl_runRsvpHealthCheck({ ...d, deadlineMs: 20 })
    expect(res.gate).toBe('unknown')
  })

  it('calls submit_rsvp with the env gate and the fixed probe arguments', async () => {
    const d = deps({ data: { ok: false, code: 'closed' }, error: null })
    await impl_runRsvpHealthCheck(d)
    expect(d.rpc).toHaveBeenCalledTimes(1)
    expect(d.rpc).toHaveBeenCalledWith('submit_rsvp', {
      p_gate: 'unit-gate',
      p_token: 'rsvp-health.probe',
      p_phone_e164: '+620000000000',
      p_name: null,
      p_children_count: 0,
      p_followup_consent: false,
      p_status: 'maybe',
    })
    expect(RSVP_HEALTH_PROBE_TOKEN).toContain('.')
  })

  it.each([[undefined], [''], ['   ']])('gate env %j -> missing-env, no RPC call', async (value) => {
    setEnv('RSVP_GATE_SECRET', value)
    const d = deps({ data: { ok: false, code: 'closed' }, error: null })
    expect((await impl_runRsvpHealthCheck(d)).gate).toBe('missing-env')
    expect(d.rpc).not.toHaveBeenCalled()
  })
})

describe('impl_runRsvpHealthCheck — turnstile', () => {
  const CLOSED = { data: { ok: false, code: 'closed' }, error: null }

  it('keys missing -> skipped, classifier not called (enabled or not)', async () => {
    for (const enabled of [undefined, 'true']) {
      setEnv('RSVP_TURNSTILE_ENABLED', enabled)
      setEnv('RSVP_TURNSTILE_SITE_KEY', 'site-only')
      const d = deps(CLOSED)
      const res = await impl_runRsvpHealthCheck(d)
      expect(res.turnstile).toEqual({ enabled: enabled === 'true', keys: 'missing', secret: 'skipped' })
      expect(d.classifyTurnstileSecret).not.toHaveBeenCalled()
    }
  })

  it('keys set + Turnstile DISABLED -> classifier still runs with the secret', async () => {
    setEnv('RSVP_TURNSTILE_SITE_KEY', 'unit-site')
    setEnv('RSVP_TURNSTILE_SECRET_KEY', 'unit-secret')
    const d = deps(CLOSED, async () => 'invalid-secret')
    const res = await impl_runRsvpHealthCheck(d)
    expect(d.classifyTurnstileSecret).toHaveBeenCalledWith('unit-secret')
    expect(res.turnstile).toEqual({ enabled: false, keys: 'both-set', secret: 'invalid-secret' })
  })

  it('keys set + enabled -> classifier verdict passed through', async () => {
    setEnv('RSVP_TURNSTILE_ENABLED', 'TRUE')
    setEnv('RSVP_TURNSTILE_SITE_KEY', 'unit-site')
    setEnv('RSVP_TURNSTILE_SECRET_KEY', 'unit-secret')
    const res = await impl_runRsvpHealthCheck(deps(CLOSED, async () => 'valid'))
    expect(res.turnstile).toEqual({ enabled: true, keys: 'both-set', secret: 'valid' })
  })

  it.each([[undefined], ['true']])('always-pass passed through (enabled=%j)', async (enabled) => {
    setEnv('RSVP_TURNSTILE_ENABLED', enabled)
    setEnv('RSVP_TURNSTILE_SITE_KEY', 'unit-site')
    setEnv('RSVP_TURNSTILE_SECRET_KEY', 'unit-secret')
    const res = await impl_runRsvpHealthCheck(deps(CLOSED, async () => 'always-pass'))
    expect(res.turnstile).toEqual({ enabled: enabled === 'true', keys: 'both-set', secret: 'always-pass' })
  })

  it('classifier throw or hang -> unknown', async () => {
    setEnv('RSVP_TURNSTILE_SITE_KEY', 'unit-site')
    setEnv('RSVP_TURNSTILE_SECRET_KEY', 'unit-secret')
    const thrown = await impl_runRsvpHealthCheck(deps(CLOSED, async () => { throw new Error('x') }))
    expect(thrown.turnstile.secret).toBe('unknown')
    const hung = await impl_runRsvpHealthCheck({ ...deps(CLOSED, () => new Promise(() => {})), deadlineMs: 20 })
    expect(hung.turnstile.secret).toBe('unknown')
  })

  it('gate and turnstile probes run in parallel', async () => {
    setEnv('RSVP_TURNSTILE_SITE_KEY', 'unit-site')
    setEnv('RSVP_TURNSTILE_SECRET_KEY', 'unit-secret')
    let releaseRpc: (v: { data: unknown; error: unknown }) => void = () => {}
    const d = deps(CLOSED)
    d.rpc.mockImplementation(() => new Promise((r) => { releaseRpc = r }))
    const pending = impl_runRsvpHealthCheck(d)
    await Promise.resolve()
    await Promise.resolve()
    expect(d.classifyTurnstileSecret).toHaveBeenCalled()
    releaseRpc(CLOSED)
    expect((await pending).gate).toBe('match')
  })
})

describe('impl_runRsvpHealthCheck — info fields', () => {
  it('environment from VERCEL_ENV, else local; publicEnabled; ISO checkedAt; exact key set', async () => {
    const d = deps({ data: { ok: false, code: 'closed' }, error: null })
    const local = await impl_runRsvpHealthCheck(d)
    expect(local.environment).toBe('local')
    expect(local.publicEnabled).toBe(false)
    expect(new Date(local.checkedAt).toISOString()).toBe(local.checkedAt)
    expect(Object.keys(local).sort()).toEqual(['checkedAt', 'environment', 'gate', 'publicEnabled', 'turnstile'])

    setEnv('VERCEL_ENV', 'preview')
    setEnv('RSVP_PUBLIC_ENABLED', 'true')
    const preview = await impl_runRsvpHealthCheck(d)
    expect(preview.environment).toBe('preview')
    expect(preview.publicEnabled).toBe(true)
  })
})
