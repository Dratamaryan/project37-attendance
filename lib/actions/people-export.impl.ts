// No 'use server' — imported directly by the export route handler and by tests.
// Never import this file in Client Components.
//
// CLIENT CHOICE: the RLS-applied SERVER client (same client export.impl.ts uses),
// NOT the service-role admin client. Live `people` RLS policies (schema-gated via
// the Management API, 2026-08-12):
//   admin_select_all: USING (is_admin())                     -- no deleted_at filter
//   organizer_select: USING (deleted_at IS NULL AND is_organizer())
// admin_select_all has no deleted_at restriction, so an authenticated admin's
// server-client SELECT already sees active AND soft-deleted rows — RLS does not
// need to be bypassed to satisfy the locked scope. The admin client would violate
// CLAUDE.md rule 5 (service role only for contexts that must bypass RLS) for no
// benefit here. The anonymized-row exclusion is a scope decision, not a security
// one, so it's applied explicitly via `.is('anonymized_at', null)` in the query
// rather than relied on from RLS (RLS does not filter anonymized_at at all).

import type { SupabaseClient } from '@supabase/supabase-js'
import type { RosterRow, PeopleRosterExportRow, GetRosterRowsResult } from './people-export.types'

// Confirmed prod PostgREST max_rows = 1000 (Management API /postgrest, same cap
// export.impl.ts paginates around). The roster is ~188 rows today — well under
// the cap, so a single unpaginated select is correct. Revisit with keyset
// pagination (see fetchFilteredAttendanceRows in export.impl.ts) if the roster
// ever approaches four figures.
const ROSTER_COLUMNS =
  'full_name, nickname, phone_e164, email, birth_date, birth_place, gender, origin_parish, ' +
  'marital_status, kepanitiaan, tribe, current_city, photo_consent_state, photo_publish_consent, ' +
  'deleted_at, created_at'

/**
 * Fetches the people-roster export scope: active + soft-deleted, excludes
 * anonymized rows (WHERE anonymized_at IS NULL). See the CLIENT CHOICE note
 * above for why the caller's RLS-applied server client is sufficient.
 */
export async function impl_getRosterRows(
  { supabase }: { supabase: SupabaseClient },
): Promise<GetRosterRowsResult> {
  const { data, error } = await supabase
    .from('people')
    .select(ROSTER_COLUMNS)
    .is('anonymized_at', null)
    .order('full_name', { ascending: true })

  if (error) {
    console.error('[getRosterRows]', error)
    return { status: 'error', message: 'Failed to fetch people roster' }
  }

  return { status: 'ok', data: (data ?? []) as unknown as RosterRow[] }
}

/**
 * Slices an ISO date/timestamptz string down to its 'YYYY-MM-DD' date part.
 * Deliberately string slicing, not `new Date(...).toISOString()` — the latter
 * would re-parse into a Date and is a no-op for UTC-suffixed strings but an
 * unnecessary foot-gun; slicing can never tz-shift the calendar day.
 */
function toDateOnly(iso: string | null): string {
  return iso === null ? '' : iso.slice(0, 10)
}

const GENDER_LABEL: Record<'male' | 'female', string> = { male: 'Male', female: 'Female' }
const MARITAL_LABEL: Record<'married' | 'single', string> = { married: 'Married', single: 'Single' }

/**
 * Maps one DB roster row to its human-readable Excel row. `Photo consent`
 * carries `photo_consent_state` verbatim (granted/refused/unknown — already
 * readable). `Can publish` is the separate `photo_publish_consent` boolean
 * rendered as Yes/No (not "granted"/"not granted" — that vocabulary would
 * collide with the Photo consent column and wrongly imply the 'unknown'
 * legacy-import cohort declined, when they were simply never asked).
 */
export function mapRosterRowToExportRow(row: RosterRow): PeopleRosterExportRow {
  return {
    Name: row.full_name,
    Nickname: row.nickname,
    Phone: row.phone_e164,
    Email: row.email ?? '',
    'Birth date': toDateOnly(row.birth_date),
    'Birth place': row.birth_place ?? '',
    Gender: row.gender === null ? '' : GENDER_LABEL[row.gender],
    'Origin parish': row.origin_parish ?? '',
    'Marital status': row.marital_status === null ? '' : MARITAL_LABEL[row.marital_status],
    Kepanitiaan: row.kepanitiaan ?? '',
    Tribe: row.tribe ?? '',
    'Current city': row.current_city ?? '',
    'Photo consent': row.photo_consent_state,
    'Can publish': row.photo_publish_consent ? 'Yes' : 'No',
    Status: row.deleted_at === null ? 'active' : 'inactive/soft-deleted',
    Created: toDateOnly(row.created_at),
  }
}
