'use server'

import { createAnonServerClient } from '@/lib/supabase/anon'
import { defaultSubmitDeps, impl_submitRsvp } from './public.impl'
import type { RsvpFormState } from './public.types'

/**
 * Public RSVP submit, shaped for useActionState with the token bound by the
 * page: submitRsvp.bind(null, token). Anon client only — submit_rsvp is
 * EXECUTE-granted to anon, not authenticated. No user-agent capture. The
 * client IP is read only to key the in-memory soft throttle, and only as
 * sha256(ip) — transient, per server instance, never logged or persisted.
 */
export async function submitRsvp(
  token: string,
  _prevState: RsvpFormState,
  formData: FormData,
): Promise<RsvpFormState> {
  return impl_submitRsvp(token, formData, createAnonServerClient(), defaultSubmitDeps)
}
