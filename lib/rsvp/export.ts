// Pure mappers for the S9-R3b admin RSVP export — imported by the export route
// handler and tests. Human-readable English headers (same convention as the
// people-roster and instance-attendee exports). Phones arrive already shaped
// by impl_getInstanceRsvpExport (full only where follow-up consent was given);
// times are WIB via formatJakarta.

import { formatJakarta } from '@/lib/events/timezone'
import { RSVP_DISPLAY_BUCKETS, type RsvpBucket, type RsvpExportRow, type RsvpPanelTotals, type RsvpStatus } from './admin.types'

const WIB = 'yyyy-MM-dd HH:mm'

export type RsvpResponseExportRow = {
  Name: string
  Type: string
  Status: string
  Children: number
  'Follow-up consent': string
  Phone: string
  'Checked in': string
  'Submitted (WIB)': string
  'Updated (WIB)': string
}

export type RsvpSummaryExportRow = {
  Metric: string
  Value: number
}

// Explicit header order — passed to json_to_sheet so an empty sheet still gets
// its header row.
export const RESPONSE_HEADERS: Array<keyof RsvpResponseExportRow> = [
  'Name', 'Type', 'Status', 'Children', 'Follow-up consent', 'Phone', 'Checked in', 'Submitted (WIB)', 'Updated (WIB)',
]
export const SUMMARY_HEADERS: Array<keyof RsvpSummaryExportRow> = ['Metric', 'Value']

const TYPE_LABEL: Record<RsvpExportRow['display_kind'], string> = {
  member: 'Member',
  newcomer: 'Newcomer',
  removed_member: 'Removed member',
}

const STATUS_LABEL: Record<RsvpStatus, string> = {
  coming: 'Coming',
  maybe: 'Maybe',
  not_coming: 'Not coming',
}

const BUCKET_LABEL: Record<typeof RSVP_DISPLAY_BUCKETS[number], string> = {
  coming_came: 'Coming · came',
  coming_no_show: "Coming · didn't come",
  walk_in: 'Walk-in (no RSVP)',
}

function exportName(r: RsvpExportRow): string {
  if (r.display_kind === 'removed_member') return 'Removed member'
  // Same rule as the panel: a scrub only replaces a newcomer's typed name.
  return r.display_name ?? (r.anonymized ? 'Anonymized' : '(no name)')
}

export function mapRsvpToExportRow(r: RsvpExportRow): RsvpResponseExportRow {
  const created = new Date(r.created_at)
  const updated = new Date(r.updated_at)
  return {
    Name: exportName(r),
    Type: TYPE_LABEL[r.display_kind],
    Status: STATUS_LABEL[r.status],
    Children: r.children_count,
    'Follow-up consent': r.followup_consent ? 'Yes' : 'No',
    Phone: r.phone,
    'Checked in': r.attended ? 'Yes' : 'No',
    'Submitted (WIB)': formatJakarta(created, WIB),
    'Updated (WIB)': updated.getTime() === created.getTime() ? '' : formatJakarta(updated, WIB),
  }
}

export function buildSummaryRows(
  totals: RsvpPanelTotals,
  buckets: Record<RsvpBucket, number>,
  children: { expected: number; checked_in: number },
): RsvpSummaryExportRow[] {
  return [
    { Metric: 'Total responses', Value: totals.responses },
    { Metric: 'Coming (people)', Value: totals.coming_people },
    { Metric: 'Expected headcount (food)', Value: totals.coming_headcount },
    { Metric: 'Coming children', Value: totals.coming_children },
    ...RSVP_DISPLAY_BUCKETS.map(b => ({ Metric: BUCKET_LABEL[b], Value: buckets[b] })),
    { Metric: 'Children expected', Value: children.expected },
    { Metric: 'Children checked in', Value: children.checked_in },
  ]
}
