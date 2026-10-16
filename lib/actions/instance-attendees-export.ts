// Pure mappers for the S8-T5 admin per-instance attendee export — imported by
// the export route handler and tests. Human-readable English headers (D5, same
// convention as the people-roster export). Phones arrive already masked from
// impl_getInstanceAttendees; times are WIB via formatJakarta (D4).

import { formatJakarta } from '@/lib/events/timezone'
import type { InstanceAdultAttendee, InstanceChildAttendee } from './instance-attendees.types'

const WIB = 'yyyy-MM-dd HH:mm'

export type InstanceAdultExportRow = {
  Name: string
  Nickname: string
  'Phone (last 4)': string
  'Checked in (WIB)': string
  'First-timer': string
  'Checked in by': string
}

export type InstanceChildExportRow = {
  'Child name': string
  'Parent name': string
  'Parent phone (last 4)': string
  'Checked in (WIB)': string
}

// Explicit header order — passed to json_to_sheet so an empty sheet still gets
// its header row.
export const ADULT_HEADERS: Array<keyof InstanceAdultExportRow> = [
  'Name', 'Nickname', 'Phone (last 4)', 'Checked in (WIB)', 'First-timer', 'Checked in by',
]
export const CHILD_HEADERS: Array<keyof InstanceChildExportRow> = [
  'Child name', 'Parent name', 'Parent phone (last 4)', 'Checked in (WIB)',
]

export function mapAdultToExportRow(a: InstanceAdultAttendee): InstanceAdultExportRow {
  return {
    Name: a.full_name,
    Nickname: a.nickname ?? '',
    'Phone (last 4)': a.phone_masked,
    'Checked in (WIB)': formatJakarta(new Date(a.checked_in_at), WIB),
    'First-timer': a.is_first_timer ? 'Yes' : 'No',
    'Checked in by': a.checker_email ?? '',
  }
}

export function mapChildToExportRow(c: InstanceChildAttendee): InstanceChildExportRow {
  return {
    'Child name': c.child_name,
    'Parent name': c.parent_name ?? '',
    'Parent phone (last 4)': c.parent_phone_masked ?? '',
    'Checked in (WIB)': formatJakarta(new Date(c.checked_in_at), WIB),
  }
}
