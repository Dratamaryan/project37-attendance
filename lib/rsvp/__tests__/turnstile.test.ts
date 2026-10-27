// Unit tests for the S9-R4 Turnstile siteverify call (lib/rsvp/turnstile.ts).
// fetch is injected per call — no global stub — and the network is never hit.
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('server-only', () => ({}))

import {
  TURNSTILE_PROBE_RESPONSE,
  TURNSTILE_SITEVERIFY_URL,
  classifyTurnstileSecret,
  verifyTurnstile,
} from '../turnstile'

const TOKEN = 'turnstile-token-value-xyz'
const SECRET = 'turnstile-secret-value-abc'

function respond(status: number, body: unknown) {
  return vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('verifyTurnstile', () => {
  it('200 + success + action rsvp -> ok; posts form-encoded secret/response, no remoteip', async () => {
    const fetchImpl = respond(200, { success: true, action: 'rsvp', hostname: 'example.com' })
    expect(await verifyTurnstile(TOKEN, SECRET, { fetchImpl })).toBe('ok')

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(TURNSTILE_SITEVERIFY_URL)
    expect(init?.method).toBe('POST')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    const body = init?.body as URLSearchParams
    expect(body).toBeInstanceOf(URLSearchParams)
    expect(body.get('secret')).toBe(SECRET)
    expect(body.get('response')).toBe(TOKEN)
    expect(body.has('remoteip')).toBe(false)
  })

  it('success:false -> fail; logs error-codes only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchImpl = respond(200, { success: false, 'error-codes': ['timeout-or-duplicate'] })
    expect(await verifyTurnstile(TOKEN, SECRET, { fetchImpl })).toBe('fail')
    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).toContain('timeout-or-duplicate')
    expect(logged).not.toContain(TOKEN)
    expect(logged).not.toContain(SECRET)
  })

  it.each([['login'], [undefined], ['']])('success but action %j -> fail', async (action) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchImpl = respond(200, { success: true, action })
    expect(await verifyTurnstile(TOKEN, SECRET, { fetchImpl })).toBe('fail')
  })

  it.each([[400], [500], [503]])('HTTP %i -> fail even with a success body', async (status) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchImpl = respond(status, { success: true, action: 'rsvp' })
    expect(await verifyTurnstile(TOKEN, SECRET, { fetchImpl })).toBe('fail')
  })

  it('non-JSON / non-object body -> fail', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const html = vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>', { status: 200 }))
    expect(await verifyTurnstile(TOKEN, SECRET, { fetchImpl: html })).toBe('fail')
    expect(await verifyTurnstile(TOKEN, SECRET, { fetchImpl: respond(200, null) })).toBe('fail')
  })

  it('timeout (signal aborts) -> fail', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hang = vi.fn<typeof fetch>((_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      }),
    )
    expect(await verifyTurnstile(TOKEN, SECRET, { fetchImpl: hang, timeoutMs: 10 })).toBe('fail')
    expect(JSON.stringify(warn.mock.calls)).toContain('TimeoutError')
  })

  it('network throw -> fail; message is not logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const boom = vi.fn<typeof fetch>().mockRejectedValue(new TypeError(`fetch failed ${SECRET}`))
    expect(await verifyTurnstile(TOKEN, SECRET, { fetchImpl: boom })).toBe('fail')
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET)
  })
})

// S9-R6 A2 health probe.
describe('classifyTurnstileSecret', () => {
  it('invalid-input-response -> valid; posts secret + fixed dummy response, no remoteip, no-store', async () => {
    const fetchImpl = respond(200, { success: false, 'error-codes': ['invalid-input-response'] })
    expect(await classifyTurnstileSecret(SECRET, { fetchImpl })).toBe('valid')

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(TURNSTILE_SITEVERIFY_URL)
    expect(init?.method).toBe('POST')
    expect(init?.cache).toBe('no-store')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    const body = init?.body as URLSearchParams
    expect(body.get('secret')).toBe(SECRET)
    expect(body.get('response')).toBe(TURNSTILE_PROBE_RESPONSE)
    expect(body.has('remoteip')).toBe(false)
    expect([...body.keys()].sort()).toEqual(['response', 'secret'])
  })

  it.each([['invalid-input-secret'], ['missing-input-secret']])('%s -> invalid-secret', async (code) => {
    const fetchImpl = respond(200, { success: false, 'error-codes': [code] })
    expect(await classifyTurnstileSecret(SECRET, { fetchImpl })).toBe('invalid-secret')
  })

  it('both secret and response codes -> invalid-secret (secret verdict wins)', async () => {
    const fetchImpl = respond(200, { success: false, 'error-codes': ['invalid-input-response', 'invalid-input-secret'] })
    expect(await classifyTurnstileSecret(SECRET, { fetchImpl })).toBe('invalid-secret')
  })

  it('success:true -> always-pass (Cloudflare test secret), not valid', async () => {
    expect(await classifyTurnstileSecret(SECRET, { fetchImpl: respond(200, { success: true }) })).toBe('always-pass')
  })

  it('secret codes still win over success:true', async () => {
    const fetchImpl = respond(200, { success: true, 'error-codes': ['invalid-input-secret'] })
    expect(await classifyTurnstileSecret(SECRET, { fetchImpl })).toBe('invalid-secret')
  })

  it('HTTP 500 -> unknown', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchImpl = respond(500, { success: false, 'error-codes': ['invalid-input-response'] })
    expect(await classifyTurnstileSecret(SECRET, { fetchImpl })).toBe('unknown')
  })

  it('timeout -> unknown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hang = vi.fn<typeof fetch>((_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      }),
    )
    expect(await classifyTurnstileSecret(SECRET, { fetchImpl: hang, timeoutMs: 10 })).toBe('unknown')
    expect(JSON.stringify(warn.mock.calls)).toContain('TimeoutError')
  })

  it('malformed JSON / non-object body -> unknown', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const html = vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>', { status: 200 }))
    expect(await classifyTurnstileSecret(SECRET, { fetchImpl: html })).toBe('unknown')
    expect(await classifyTurnstileSecret(SECRET, { fetchImpl: respond(200, null) })).toBe('unknown')
  })

  it('any other code / no codes -> unknown', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(
      await classifyTurnstileSecret(SECRET, { fetchImpl: respond(200, { success: false, 'error-codes': ['internal-error'] }) }),
    ).toBe('unknown')
    expect(await classifyTurnstileSecret(SECRET, { fetchImpl: respond(200, { success: false }) })).toBe('unknown')
  })

  it('network throw -> unknown; never logs the secret', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const boom = vi.fn<typeof fetch>().mockRejectedValue(new TypeError(`fetch failed ${SECRET}`))
    expect(await classifyTurnstileSecret(SECRET, { fetchImpl: boom })).toBe('unknown')
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET)
  })
})
