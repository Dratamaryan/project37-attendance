import 'server-only'
// S9-R4 server-side Cloudflare Turnstile verification for the public RSVP
// submit. Called only from impl_submitRsvp, and only while
// RSVP_TURNSTILE_ENABLED is on. remoteip is deliberately NOT sent: the
// visitor's IP never leaves this server.

export const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
/** The widget renders with action 'rsvp'; a token minted for any other action is rejected. */
export const TURNSTILE_ACTION = 'rsvp'
export const TURNSTILE_TIMEOUT_MS = 5000

export type TurnstileVerdict = 'ok' | 'fail'

type VerifyOptions = {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/**
 * 'ok' only for HTTP 200 + success === true + action === 'rsvp'. Every other
 * outcome — non-200, success false, wrong action, malformed body, network
 * error, timeout — is 'fail'. Logs Cloudflare's error-codes only; never the
 * token or the secret.
 */
export async function verifyTurnstile(
  token: string,
  secret: string,
  opts: VerifyOptions = {},
): Promise<TurnstileVerdict> {
  const fetchImpl = opts.fetchImpl ?? fetch
  try {
    const res = await fetchImpl(TURNSTILE_SITEVERIFY_URL, {
      method: 'POST',
      body: new URLSearchParams({ secret, response: token }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? TURNSTILE_TIMEOUT_MS),
      cache: 'no-store',
    })
    if (res.status !== 200) {
      console.warn('[rsvp] turnstile siteverify HTTP', res.status)
      return 'fail'
    }

    const body: unknown = await res.json()
    const result = (typeof body === 'object' && body !== null ? body : {}) as {
      success?: unknown
      action?: unknown
      'error-codes'?: unknown
    }
    if (result.success === true && result.action === TURNSTILE_ACTION) return 'ok'

    const codes = Array.isArray(result['error-codes'])
      ? result['error-codes'].filter((c): c is string => typeof c === 'string')
      : []
    console.warn(
      '[rsvp] turnstile rejected:',
      result.success === true ? 'action-mismatch' : codes.join(',') || 'no-error-codes',
    )
    return 'fail'
  } catch (err) {
    // Name only (TimeoutError / AbortError / TypeError) — a message could echo
    // request details.
    console.warn('[rsvp] turnstile siteverify failed:', err instanceof Error ? err.name : 'unknown')
    return 'fail'
  }
}
