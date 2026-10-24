// Client-safe types for the public RSVP page (/rsvp/[token], S9-R1).
// No runtime imports — the form component imports this file.

import type { PhoneNormalizationError } from '@/lib/utils/phone'

export const RSVP_PUBLIC_STATUSES = ['coming', 'maybe', 'not_coming'] as const
export type RsvpPublicStatus = (typeof RSVP_PUBLIC_STATUSES)[number]

export type RsvpLocale = 'id' | 'en'

export const RSVP_CHILDREN_MIN = 1
export const RSVP_CHILDREN_MAX = 20
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
  status?: 'required'
  phone?: PhoneNormalizationError
  name?: 'too_long'
  children?: 'required' | 'out_of_range'
}

/**
 * useActionState state for the public form. Deliberately carries nothing the
 * visitor didn't type themselves: 'success' echoes back only their own status
 * and children count, identical for a roster member and a newcomer (no name,
 * no phone, no "welcome back").
 */
export type RsvpFormState =
  | { kind: 'idle' }
  | { kind: 'invalid'; fieldErrors: RsvpFieldErrors }
  | { kind: 'success'; status: RsvpPublicStatus; children: number }
  | { kind: 'closed' }
  | { kind: 'limit' }
  | { kind: 'unavailable' }
  | { kind: 'error' }

export const RSVP_INITIAL_STATE: RsvpFormState = { kind: 'idle' }
