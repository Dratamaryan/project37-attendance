// Pure attendance-grouping and formatting logic — no I/O. See
// lib/events/attendance-summary.impl.ts for the DB/Telegram orchestration
// that calls this.

import { addHours } from 'date-fns'
import { formatJakarta, toJakartaInstant } from '@/lib/events/timezone'

export type AttendanceRow = {
  event_instance_id: string
  full_name: string
  checked_in_at: string
  event_name_snapshot: string
  event_name_snapshot_id: string | null
  scheduled_at: string
  instance_status: 'scheduled' | 'cancelled' | 'completed'
}

export type InstanceAttendance = {
  event_instance_id: string
  label: string
  scheduled_at: string
  attendees: string[]
}

/**
 * Computes the ICT day D = [D-1 17:00 UTC, D 17:00 UTC) that is ENDING at the
 * 23:30 ICT fire time (D/2), via lib/events/timezone.ts only (D/3) — never
 * `new Date()` arithmetic. Exported (unlike birthday-digest.impl.ts's inline
 * equivalent) so the boundary math itself is unit-testable without a DB.
 */
export function computeIctDayBounds(now: Date): { ictDate: string; startUtc: Date; endUtc: Date } {
  const ictDate = formatJakarta(now, 'yyyy-MM-dd')
  const startUtc = toJakartaInstant(ictDate, '00:00')
  const endUtc = addHours(startUtc, 24)
  return { ictDate, startUtc, endUtc }
}

/**
 * Cancelled instances still show their check-ins (they physically happened —
 * filtering would be more misleading than annotating, same reasoning as the
 * `(deleted)` badge on soft-deleted people). The label annotates instead.
 */
function instanceLabel(
  row: Pick<AttendanceRow, 'event_name_snapshot' | 'event_name_snapshot_id' | 'scheduled_at' | 'instance_status'>,
): string {
  const name = row.event_name_snapshot_id ?? row.event_name_snapshot
  const time = formatJakarta(new Date(row.scheduled_at), 'HH:mm')
  const cancelledSuffix = row.instance_status === 'cancelled' ? ' (dibatalkan)' : ''
  return `${name}${cancelledSuffix} — ${time}`
}

/** Groups attendance rows by event instance, ordered by scheduled_at; attendee
 * order within an instance follows input order (callers pass rows pre-sorted
 * by checked_in_at). */
export function groupAttendanceByInstance(rows: AttendanceRow[]): InstanceAttendance[] {
  const byInstance = new Map<string, { row: AttendanceRow; attendees: string[] }>()

  for (const row of rows) {
    const existing = byInstance.get(row.event_instance_id)
    if (existing) {
      existing.attendees.push(row.full_name)
    } else {
      byInstance.set(row.event_instance_id, { row, attendees: [row.full_name] })
    }
  }

  return Array.from(byInstance.values())
    .sort((a, b) => (a.row.scheduled_at < b.row.scheduled_at ? -1 : 1))
    .map(({ row, attendees }) => ({
      event_instance_id: row.event_instance_id,
      label: instanceLabel(row),
      scheduled_at: row.scheduled_at,
      attendees,
    }))
}

// Reserves room for the trailing "…dan N lainnya" line (worst case ~20 chars
// even for a 4-digit N), plus slack. Checked before every append below, so no
// single line — however long `full_name` happens to be, since the column has
// no DB length constraint — can ever push the running total past `maxChars`.
const OMITTED_LINE_RESERVE = 40

/**
 * Builds the Telegram message, truncating with an accurate omitted-count
 * rather than cutting mid-line or exceeding Telegram's 4096-char hard limit
 * (E/6 — Telegram REJECTS oversized messages). `maxChars` defaults to 3900,
 * a safety margin below 4096 for `OMITTED_LINE_RESERVE` and general slack.
 *
 * The header's total count is always the TRUE total (every check-in today),
 * even when the body below it omits some — same annotate-don't-hide spirit
 * as the cancelled-instance label.
 */
export function formatAttendanceSummary(instances: InstanceAttendance[], maxChars = 3900): string {
  const totalCount = instances.reduce((sum, i) => sum + i.attendees.length, 0)
  let text = `📋 Ringkasan Kehadiran Hari Ini (${totalCount})`
  let omitted = 0
  let truncated = false

  for (const instance of instances) {
    if (truncated) {
      omitted += instance.attendees.length
      continue
    }

    const instanceHeader = `\n\n🗓 ${instance.label} (${instance.attendees.length})`
    if (text.length + instanceHeader.length + OMITTED_LINE_RESERVE > maxChars) {
      omitted += instance.attendees.length
      truncated = true
      continue
    }
    text += instanceHeader

    for (let i = 0; i < instance.attendees.length; i++) {
      const line = `\n  • ${instance.attendees[i]}`
      if (text.length + line.length + OMITTED_LINE_RESERVE > maxChars) {
        omitted += instance.attendees.length - i
        truncated = true
        break
      }
      text += line
    }
  }

  if (truncated) {
    text += `\n…dan ${omitted} lainnya`
  }

  return text
}
