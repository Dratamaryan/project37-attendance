import type { BirthdayDigestResult } from '@/lib/events/birthday-digest.impl'
import type { AttendanceSummaryResult } from '@/lib/events/attendance-summary.impl'

// Re-exported so callers (server actions, UI) don't need to reach into
// lib/events/*.impl.ts directly just to name the result type.
export type { BirthdayDigestResult, AttendanceSummaryResult }

// The manual trigger returns the SAME discriminated result the scheduled cron
// produces (claim-first against the shared (source, ict_date) slot — see
// digest-triggers.impl.ts), with one extra branch for the privilege gate.

export type RunBirthdayDigestNowResult = { status: 'not_authorized' } | BirthdayDigestResult

export type RunAttendanceSummaryNowResult = { status: 'not_authorized' } | AttendanceSummaryResult
