// @vitest-environment jsdom
//
// S9-R6 A2 — Settings "RSVP health" card. The card's button drives the REAL
// runRsvpHealthCheck action + impl_runRsvpHealthCheck + classifyTurnstileSecret
// with sentinel secret values in env; only the session/guard, the anon RPC and
// fetch are faked. Proves: the check never runs on render, the button is
// disabled while it runs, each outcome maps to the right OK/Warning/Problem
// row, and no sentinel value ever reaches the action result or the DOM.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

vi.mock('server-only', () => ({}))

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key} ${JSON.stringify(params)}` : key,
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}))
vi.mock('@/lib/actions/digest-triggers', () => ({
  runBirthdayDigestNow: vi.fn(),
  runAttendanceSummaryNow: vi.fn(),
}))
vi.mock('@/lib/actions/settings', () => ({
  updateSettings: vi.fn(),
  getHorizonImpact: vi.fn(),
}))
vi.mock('@/lib/actions/parishes-admin', () => ({
  approveParish: vi.fn(),
}))

// Session + guard: an active admin by default; tests can flip it.
const guard = vi.fn()
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }))
vi.mock('@/lib/auth/require-admin', () => ({
  requireActiveAdmin: (...args: unknown[]) => guard(...args),
}))

// The anon RPC the gate probe calls.
const rpc = vi.fn()
vi.mock('@/lib/supabase/anon', () => ({
  createAnonServerClient: () => ({ rpc: (...args: unknown[]) => rpc(...args) }),
}))

// Spy on the real action so every serialized result can be inspected.
const actionResults: unknown[] = []
vi.mock('@/lib/rsvp/health', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rsvp/health')>()
  return {
    runRsvpHealthCheck: async () => {
      const res = await actual.runRsvpHealthCheck()
      actionResults.push(res)
      return res
    },
  }
})

import { SettingsClient } from '../settings-client'

const SENTINEL_GATE = 'SENTINELGATE222'
const SENTINEL_TS_SECRET = 'SENTINELTSSECRET333'
const SENTINEL_SITE_KEY = 'SENTINELSITEKEY444'
const SENTINELS = [SENTINEL_GATE, SENTINEL_TS_SECRET, SENTINEL_SITE_KEY]

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

// null -> { success: true }: what Cloudflare's always-passes test secret returns.
function siteverifyReturns(codes: string[] | null) {
  const fetchFake = vi.fn(async () => ({
    status: 200,
    json: async () => (codes === null ? { success: true } : { success: false, 'error-codes': codes }),
  }))
  vi.stubGlobal('fetch', fetchFake)
  return fetchFake
}

function renderCard() {
  const view = render(
    <SettingsClient
      initialSettings={null}
      settingsLoadError={true}
      initialPendingParishes={[]}
      parishesLoadError={false}
      telegramBotConfigured={true}
    />,
  )
  const card = screen.getByRole('region', { name: 'rsvp_health.title' })
  return { view, card }
}

function assertNoSentinel(text: string) {
  for (const s of SENTINELS) expect(text).not.toContain(s)
}

beforeEach(() => {
  actionResults.length = 0
  guard.mockReset().mockResolvedValue({ status: 'ok', actorId: 'admin-id', role: 'admin' })
  rpc.mockReset().mockResolvedValue({ data: { ok: false, code: 'closed' }, error: null })
  setEnv('VERCEL_ENV', 'preview')
  setEnv('RSVP_PUBLIC_ENABLED', 'true')
  setEnv('RSVP_GATE_SECRET', SENTINEL_GATE)
  setEnv('RSVP_TURNSTILE_ENABLED', 'true')
  setEnv('RSVP_TURNSTILE_SITE_KEY', SENTINEL_SITE_KEY)
  setEnv('RSVP_TURNSTILE_SECRET_KEY', SENTINEL_TS_SECRET)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  ENV_KEYS.forEach((k, i) => setEnv(k, ORIGINAL[i]))
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('RSVP health card', () => {
  it('never runs on render', () => {
    const fetchFake = siteverifyReturns(['invalid-input-response'])
    renderCard()
    expect(rpc).not.toHaveBeenCalled()
    expect(fetchFake).not.toHaveBeenCalled()
    expect(guard).not.toHaveBeenCalled()
  })

  it('sentinels: healthy run — action result and rendered card contain no sentinel', async () => {
    const fetchFake = siteverifyReturns(['invalid-input-response'])
    const { view, card } = renderCard()

    fireEvent.click(within(card).getByRole('button', { name: 'rsvp_health.button' }))
    // Disabled while running.
    expect(within(card).getByRole('button', { name: 'rsvp_health.button_pending' })).toBeDisabled()

    await waitFor(() => expect(within(card).getByText('rsvp_health.gate.match')).toBeInTheDocument())
    expect(within(card).getByRole('button', { name: 'rsvp_health.button' })).toBeEnabled()

    // The sentinels really were in play: the probes received them server-side.
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_gate: SENTINEL_GATE })
    const [, init] = fetchFake.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.body as URLSearchParams).get('secret')).toBe(SENTINEL_TS_SECRET)

    expect(actionResults).toHaveLength(1)
    const serialized = JSON.stringify(actionResults[0])
    assertNoSentinel(serialized)
    expect(actionResults[0]).toMatchObject({
      status: 'ok',
      result: {
        environment: 'preview',
        publicEnabled: true,
        gate: 'match',
        turnstile: { enabled: true, keys: 'both-set', secret: 'valid' },
      },
    })

    expect(within(card).getByText('rsvp_health.turnstile.secret_valid_on')).toBeInTheDocument()
    expect(within(card).getByText('rsvp_health.turnstile.pairing_note')).toBeInTheDocument()
    expect(within(card).getAllByText('rsvp_health.status.ok')).toHaveLength(2)
    assertNoSentinel(view.container.innerHTML)
    assertNoSentinel(document.body.innerHTML)
  })

  it('sentinels: problem run (mismatch + invalid secret) — still no sentinel anywhere', async () => {
    rpc.mockResolvedValue({ data: { ok: false, code: 'unavailable' }, error: null })
    siteverifyReturns(['invalid-input-secret'])
    const { view, card } = renderCard()

    fireEvent.click(within(card).getByRole('button', { name: 'rsvp_health.button' }))
    await waitFor(() => expect(within(card).getByText('rsvp_health.gate.mismatch')).toBeInTheDocument())

    expect(within(card).getByText('rsvp_health.turnstile.secret_invalid')).toBeInTheDocument()
    expect(within(card).getAllByText('rsvp_health.status.problem')).toHaveLength(2)
    assertNoSentinel(JSON.stringify(actionResults))
    assertNoSentinel(view.container.innerHTML)
  })

  it.each([
    ['missing-env', () => setEnv('RSVP_GATE_SECRET', undefined), 'rsvp_health.gate.missing_env', 'rsvp_health.status.problem'],
    ['unknown (RPC error)', () => rpc.mockResolvedValue({ data: null, error: { code: 'x' } }), 'rsvp_health.gate.unknown', 'rsvp_health.status.warning'],
  ])('gate %s row', async (_label, arrange, text, status) => {
    arrange()
    siteverifyReturns(['invalid-input-response'])
    const { card } = renderCard()
    fireEvent.click(within(card).getByRole('button', { name: 'rsvp_health.button' }))
    await waitFor(() => expect(within(card).getByText(text)).toBeInTheDocument())
    expect(within(card).getByText(status)).toBeInTheDocument()
  })

  it.each([
    ['enabled + keys missing -> Problem', 'true', false, [], 'rsvp_health.turnstile.on_keys_missing', 'rsvp_health.status.problem'],
    ['disabled + keys missing -> OK-neutral', undefined, false, [], 'rsvp_health.turnstile.off_keys_missing', 'rsvp_health.status.ok'],
    ['disabled + valid secret -> OK', undefined, true, ['invalid-input-response'], 'rsvp_health.turnstile.secret_valid_off', 'rsvp_health.status.ok'],
    ['unknown -> Warning', 'true', true, ['internal-error'], 'rsvp_health.turnstile.secret_unknown', 'rsvp_health.status.warning'],
    ['enabled + always-pass -> Problem', 'true', true, null, 'rsvp_health.turnstile.secret_always_pass', 'rsvp_health.status.problem'],
    ['disabled + always-pass -> Problem', undefined, true, null, 'rsvp_health.turnstile.secret_always_pass', 'rsvp_health.status.problem'],
  ])('turnstile %s', async (_label, enabled, keysSet, codes, text, status) => {
    setEnv('RSVP_TURNSTILE_ENABLED', enabled)
    if (!keysSet) setEnv('RSVP_TURNSTILE_SECRET_KEY', undefined)
    const fetchFake = siteverifyReturns(codes)
    const { view, card } = renderCard()
    fireEvent.click(within(card).getByRole('button', { name: 'rsvp_health.button' }))
    await waitFor(() => expect(within(card).getByText(text)).toBeInTheDocument())
    const row = within(card).getByText('rsvp_health.turnstile.label').closest('li') as HTMLElement
    expect(within(row).getByText(status)).toBeInTheDocument()
    if (!keysSet) expect(fetchFake).not.toHaveBeenCalled()
    assertNoSentinel(JSON.stringify(actionResults))
    assertNoSentinel(view.container.innerHTML)
  })

  it('not authorized (organizer / anonymous) -> message, no probes run', async () => {
    guard.mockResolvedValue({ status: 'denied' })
    const fetchFake = siteverifyReturns(['invalid-input-response'])
    const { card } = renderCard()
    fireEvent.click(within(card).getByRole('button', { name: 'rsvp_health.button' }))
    await waitFor(() => expect(within(card).getByText('rsvp_health.not_authorized')).toBeInTheDocument())
    expect(rpc).not.toHaveBeenCalled()
    expect(fetchFake).not.toHaveBeenCalled()
    expect(actionResults).toEqual([{ status: 'not_authorized' }])
  })
})
