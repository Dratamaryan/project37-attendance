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

// ── S9-R6 A2 secret health probe ─────────────────────────────────────────────

/** Fixed, obviously-fake response token: siteverify can never accept it. */
export const TURNSTILE_PROBE_RESPONSE = 'rsvp-health-probe'

export type TurnstileSecretClass = 'valid' | 'invalid-secret' | 'always-pass' | 'unknown'

/**
 * Admin health check only (lib/rsvp/health.impl.ts). POSTs siteverify with the
 * secret and a dummy response token and reads which input Cloudflare rejects:
 * a good secret gets past the secret check and fails on the response
 * ('invalid-input-response' -> 'valid'); a bad or blank secret fails on the
 * secret ('invalid-input-secret' / 'missing-input-secret' -> 'invalid-secret').
 * Precedence: the secret codes are checked first (they win when both codes
 * appear); then success:true -> 'always-pass' — a dummy token only succeeds
 * against Cloudflare's always-passes TEST secret, so bot protection is
 * effectively off and this must not read as healthy; then
 * 'invalid-input-response' -> 'valid'. Non-200, timeout, network error,
 * malformed body or any other code -> 'unknown'. Same request shape as
 * verifyTurnstile (no remoteip, timeout, no-store). Never logs the secret or
 * the raw body.
 */
export async function classifyTurnstileSecret(
  secret: string,
  opts: VerifyOptions = {},
): Promise<TurnstileSecretClass> {
  const fetchImpl = opts.fetchImpl ?? fetch
  try {
    const res = await fetchImpl(TURNSTILE_SITEVERIFY_URL, {
      method: 'POST',
      body: new URLSearchParams({ secret, response: TURNSTILE_PROBE_RESPONSE }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? TURNSTILE_TIMEOUT_MS),
      cache: 'no-store',
    })
    if (res.status !== 200) {
      console.warn('[rsvp-health] turnstile siteverify HTTP', res.status)
      return 'unknown'
    }

    const body: unknown = await res.json()
    if (typeof body !== 'object' || body === null) return 'unknown'
    const result = body as { success?: unknown; 'error-codes'?: unknown }
    const codes = Array.isArray(result['error-codes'])
      ? result['error-codes'].filter((c): c is string => typeof c === 'string')
      : []

    if (codes.includes('invalid-input-secret') || codes.includes('missing-input-secret')) return 'invalid-secret'
    if (result.success === true) return 'always-pass'
    if (codes.includes('invalid-input-response')) return 'valid'
    console.warn('[rsvp-health] turnstile unexpected error-codes:', codes.join(',') || 'none')
    return 'unknown'
  } catch (err) {
    console.warn('[rsvp-health] turnstile siteverify failed:', err instanceof Error ? err.name : 'unknown')
    return 'unknown'
  }
}
