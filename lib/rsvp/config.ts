import 'server-only'
// Server-only RSVP configuration. Neither value has a NEXT_PUBLIC_ variant,
// so neither can be read (or flipped) client-side.

/**
 * Public RSVP go-live switch. Staging true; prod false until go-live. Case-
 * and whitespace-insensitive (Vercel values were entered as TRUE/FALSE);
 * anything but "true", including unset, is off.
 */
export function isRsvpPublicEnabled(): boolean {
  return (process.env.RSVP_PUBLIC_ENABLED ?? '').trim().toLowerCase() === 'true'
}

/**
 * The submit_rsvp p_gate value — must equal the Supabase vault secret
 * 'rsvp_gate' of the project this deployment talks to. Trimmed; unset or
 * blank -> null (the caller fails closed as 'unavailable'). Never log it.
 */
export function getRsvpGateSecret(): string | null {
  const value = (process.env.RSVP_GATE_SECRET ?? '').trim()
  return value === '' ? null : value
}

/**
 * S9-R4 invisible Turnstile toggle. Same rule as RSVP_PUBLIC_ENABLED: only
 * "true" (case/whitespace-insensitive) is on; unset is off.
 */
export function isRsvpTurnstileEnabled(): boolean {
  return (process.env.RSVP_TURNSTILE_ENABLED ?? '').trim().toLowerCase() === 'true'
}

/**
 * Both Turnstile keys, trimmed; null when either is blank (the caller fails
 * closed while the toggle is on). The site key is public by nature but is
 * still read server-side and passed to the form as a prop — no NEXT_PUBLIC_
 * variant. Never log the secret.
 */
export function getRsvpTurnstileKeys(): { siteKey: string; secretKey: string } | null {
  const siteKey = (process.env.RSVP_TURNSTILE_SITE_KEY ?? '').trim()
  const secretKey = (process.env.RSVP_TURNSTILE_SECRET_KEY ?? '').trim()
  return siteKey === '' || secretKey === '' ? null : { siteKey, secretKey }
}
