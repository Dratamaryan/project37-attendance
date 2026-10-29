// Types for the S9-R7 RSVP analytics action — imported by rsvp-analytics.impl.ts,
// analytics.ts and the /admin/analytics RSVP components.

/** One rsvp_instance_metrics row (non-cancelled, ended, linked instance). */
export type RsvpInstanceMetricsRow = {
  event_instance_id: string
  event_id: string
  event_type: string
  scheduled_at: string             // ISO timestamptz
  ended_at: string                 // ISO timestamptz
  coming_people: number
  coming_headcount: number         // Σ 1 + children_count over coming RSVPs
  coming_came: number
  coming_no_show: number
  walk_ins: number
  actual_adults: number            // every attendance row at the instance
  actual_children: number          // every child_attendance row at the instance
  newcomer_rsvps: number
  became_members: number           // as of each RSVP's last submit
  invited: number                  // event_invitations status = 'sent'
  invited_responded: number
  invited_attended: number
}

/** Chart point — scheduled_date is the instance's Asia/Jakarta calendar date. */
export type RsvpChartRow = RsvpInstanceMetricsRow & { scheduled_date: string }

/**
 * Pooled KPIs over the filtered instances: rates are Σ numerator / Σ denominator,
 * never a mean of per-instance rates. A zero denominator gives null ('—').
 */
export type RsvpKpis = {
  instances: number
  coming_headcount: number
  coming_people: number
  actual_adults: number
  actual_children: number
  show_up_rate: number | null        // Σcoming_came / Σcoming_people
  no_show_rate: number | null        // Σcoming_no_show / Σcoming_people
  walk_in_share: number | null       // Σwalk_ins / Σactual_adults
  newcomer_rsvps: number
  became_members: number
  funnel_response_rate: number | null   // Σinvited_responded / Σinvited, instances with invited > 0
  funnel_attendance_rate: number | null // Σinvited_attended / Σinvited, instances with invited > 0
}

export type RsvpAnalytics = {
  rows: RsvpChartRow[]
  kpis: RsvpKpis
}

export type GetRsvpAnalyticsResult =
  | { status: 'ok'; data: RsvpAnalytics }
  | { status: 'not_authorized' }
  | { status: 'invalid_filter'; message: string }
  | { status: 'error'; message: string }
