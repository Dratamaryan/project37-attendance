// Client-safe types for the public RSVP page (/rsvp/[token], S9-R1).
// No runtime imports — the form component imports this file.

import type { PhoneNormalizationError } from '@/lib/utils/phone'

// S9.5-T5: submitting the form IS the attendance confirmation — the only
// status the public form writes. event_rsvps still accepts 'maybe' /
// 'not_coming' (legacy rows), but a public submit carrying either is rejected
// as form_outdated, never converted.
export type RsvpPublicStatus = 'coming'

export type RsvpLocale = 'id' | 'en'

export const RSVP_CHILDREN_MIN = 1
export const RSVP_CHILDREN_MAX = 20
export const RSVP_NAME_MIN = 2
export const RSVP_NAME_MAX = 100

/** Event header, fully formatted server-side (WIB, per locale). */
export type RsvpEventView = {
  name: string
  dateLabel: string
  timeLabel: string
  location: string | null
  imageUrl: string | null
}

export type RsvpPageData =
  | { kind: 'disabled' }
  | { kind: 'closed' }
  | { kind: 'open'; event: RsvpEventView }

export type RsvpFieldErrors = {
  phone?: PhoneNormalizationError
  name?: 'required' | 'too_short' | 'too_long'
  children?: 'required' | 'out_of_range'
}

/**
 * useActionState state for the public form. Deliberately carries nothing the
 * visitor didn't type themselves: 'success' echoes back only their own
 * children count, identical for a roster member and a newcomer (no name, no
 * phone, no "welcome back"). status stays on 'success' only so a page loaded
 * before S9.5-T5 (whose recap reads it) still renders.
 *
 * form_outdated rides on kind 'error': a pre-T5 page has no branch for a new
 * kind and would show nothing, but it does render 'error' as a banner.
 */
export type RsvpFormState =
  | { kind: 'idle' }
  | { kind: 'invalid'; fieldErrors: RsvpFieldErrors }
  | { kind: 'success'; status: RsvpPublicStatus; children: number }
  | { kind: 'closed' }
  | { kind: 'limit' }
  | { kind: 'unavailable' }
  | { kind: 'error'; reason?: 'form_outdated' }

export const RSVP_INITIAL_STATE: RsvpFormState = { kind: 'idle' }
