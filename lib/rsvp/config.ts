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
