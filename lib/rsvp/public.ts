'use server'

import { createAnonServerClient } from '@/lib/supabase/anon'
import { impl_submitRsvp } from './public.impl'
import type { RsvpFormState } from './public.types'

/**
 * Public RSVP submit, shaped for useActionState with the token bound by the
 * page: submitRsvp.bind(null, token). Anon client only — submit_rsvp is
 * EXECUTE-granted to anon, not authenticated. No IP / user-agent capture.
 */
export async function submitRsvp(
  token: string,
  _prevState: RsvpFormState,
  formData: FormData,
): Promise<RsvpFormState> {
  return impl_submitRsvp(token, formData, createAnonServerClient())
}
