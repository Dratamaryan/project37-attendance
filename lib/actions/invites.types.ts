// Types for invite server actions — imported by invites.impl.ts and invites.ts.

// ── recipient resolution (F/2, F/4) ─────────────────────────────────────────

export interface RecipientFilter {
  tribe?: string
  kepanitiaan?: string
  /** person_attendance_counts.last_attended_at >= now - N days */
  attendanceRecencyDays?: number
  /** person_attendance_counts.total_attendance >= N */
  minAttendance?: number
}

export interface HasEmailRecipient {
  personId: string
  fullName: string
  email: string
}

/** F/4 — first-class deliverable, not an edge case. Name + phone so the admin can WhatsApp them. */
export interface NoEmailRecipient {
  personId: string
  fullName: string
  phoneE164: string
}

export interface ResolveRecipientsResult {
  hasEmail: HasEmailRecipient[]
  noEmail: NoEmailRecipient[]
}

// ── sendInvites ──────────────────────────────────────────────────────────────

export type StoppedReason = 'completed' | 'run_budget_exhausted' | 'quota_exhausted' | 'daily_cap_exhausted'

export type SendInvitesResult =
  | { status: 'forbidden'; message: string }
  | { status: 'error'; message: string }
  | {
      status: 'ok'
      eventInstanceId: string
      /** F/4 — always returned alongside the send outcome, never just on error. */
      noEmail: NoEmailRecipient[]
      attempted: number
      sent: number
      failed: number
      skippedAlreadySent: number
      /** Recipients not yet claimed this run — re-invoking sendInvites with the same filter resumes them. */
      remaining: number
      stoppedReason: StoppedReason
    }

// ── resendInvite (T4-10, E/4) ─────────────────────────────────────────────────

export type ResendInviteResult =
  | { status: 'forbidden'; message: string }
  | { status: 'error'; message: string }
  | { status: 'not_found' }
  | { status: 'ok'; sequence: number }
  | { status: 'send_failed'; message: string; sequence: number }
  | { status: 'daily_cap_exhausted'; sequence: number }
