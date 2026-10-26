// Types for the S9-R3 admin RSVP panel — imported by admin.impl.ts, the
// 'use server' wrapper admin.ts, the instance page, RsvpPanel, and tests.
// Client-safe: no runtime code.

export type RsvpStatus = 'coming' | 'maybe' | 'not_coming'

/** Every bucket value rsvp_checkin_crosstab can emit — zero-filled in the panel. */
export const RSVP_BUCKETS = [
  'coming_came',
  'coming_no_show',
  'maybe_came',
  'maybe_no_show',
  'not_coming_came',
  'not_coming_no_show',
  'walk_in',
] as const
export type RsvpBucket = typeof RSVP_BUCKETS[number]

export type RsvpPanelTotals = {
  responses: number
  coming_people: number
  coming_headcount: number   // Σ(1 + children_count) over 'coming' — the food count
  coming_children: number
  maybe_people: number
  maybe_headcount: number
  not_coming_people: number
}

export type RsvpPanelRow = {
  rsvp_id: string
  // member: resolves to a live roster person; removed_member: resolves to a
  // soft-deleted/anonymized person; newcomer: resolves to no one.
  display_kind: 'member' | 'removed_member' | 'newcomer'
  display_name: string | null   // roster name (member) | submitted name (newcomer) | null
  status: RsvpStatus
  children_count: number
  followup_consent: boolean
  phone_masked: string | null   // "•••• 1234"; null when the RSVP phone is null
  created_at: string
  updated_at: string
  attended: boolean
  // S9-R5: phone and name scrubbed by retention; resolution is unchanged.
  anonymized: boolean
}

export type RsvpPanel = {
  link: { active: boolean; url: string | null }   // url only when the public flag is on
  publicEnabled: boolean
  totals: RsvpPanelTotals
  buckets: Record<RsvpBucket, number>
  children: { expected: number; checked_in: number }
  rows: RsvpPanelRow[]
}

type NotAuthorized = { status: 'not_authorized' }
type InvalidInput = { status: 'invalid_input' }
type ActionError = { status: 'error'; message: string }

export type GetOrCreateRsvpLinkResult =
  | { status: 'ok'; url: string; linkId: string; created: boolean }
  | { status: 'disabled' }
  | { status: 'not_found' }
  | { status: 'closed' }
  | { status: 'misconfigured' }
  | NotAuthorized
  | InvalidInput
  | ActionError

export type DeactivateRsvpLinkResult =
  | { status: 'ok'; linkId: string }
  | { status: 'no_link' }
  | NotAuthorized
  | InvalidInput
  | ActionError

export type GetInstanceRsvpPanelResult =
  | { status: 'ok'; panel: RsvpPanel }
  | NotAuthorized
  | InvalidInput
  | ActionError

export type DeleteRsvpResult =
  | { status: 'ok' }
  | { status: 'not_found' }
  | NotAuthorized
  | InvalidInput
  | ActionError

// ── export (S9-R3b) ──────────────────────────────────────────────────────────

/**
 * One RSVP in the admin .xlsx export. Same derivation as RsvpPanelRow; only
 * the phone differs: full E.164 when followup_consent, else "•••• 1234",
 * '' when the RSVP has no phone.
 */
export type RsvpExportRow = Omit<RsvpPanelRow, 'phone_masked'> & { phone: string }

export type GetInstanceRsvpExportResult =
  | {
      status: 'ok'
      instance: { id: string; scheduled_at: string }
      totals: RsvpPanelTotals
      buckets: Record<RsvpBucket, number>
      children: { expected: number; checked_in: number }
      rows: RsvpExportRow[]
      full_phone_rows: number   // rows exported with a full phone (consented + phone present)
    }
  | { status: 'not_found' }
  | NotAuthorized
  | InvalidInput
  | ActionError

// ── per-person history (S9-R3b) ──────────────────────────────────────────────

export type PersonRsvpHistoryRow = {
  rsvp_id: string
  instance_id: string
  event_id: string
  scheduled_at: string
  instance_status: string
  display_name: string          // occurrence name for the requested locale (displayInstanceName)
  rsvp_status: RsvpStatus
  children_count: number
  attended: boolean
}

export type ListPersonRsvpHistoryResult =
  | { status: 'ok'; rows: PersonRsvpHistoryRow[] }
  | NotAuthorized
  | InvalidInput
  | ActionError
