// Types for the S6-T10a people-roster Excel export — imported by
// people-export.impl.ts and its route handler / tests.

/**
 * One row per `people` record in scope: active + soft-deleted, excludes
 * anonymized (WHERE anonymized_at IS NULL). This is a roster convenience
 * artifact, not the importer's inverse — column set is deliberately a
 * curated subset of `people`, not every column.
 */
export type RosterRow = {
  full_name: string
  nickname: string
  phone_e164: string
  email: string | null
  birth_date: string | null // date, 'YYYY-MM-DD'
  birth_place: string | null
  gender: 'male' | 'female' | null
  origin_parish: string | null
  marital_status: 'married' | 'single' | null
  kepanitiaan: string | null
  tribe: string | null
  current_city: string | null
  photo_consent_state: 'granted' | 'refused' | 'unknown'
  photo_publish_consent: boolean
  deleted_at: string | null // ISO timestamptz
  created_at: string // ISO timestamptz
}

/** Human-readable sheet row — keys are the literal Excel column headers. */
export type PeopleRosterExportRow = {
  Name: string
  Nickname: string
  Phone: string
  Email: string
  'Birth date': string
  'Birth place': string
  Gender: string
  'Origin parish': string
  'Marital status': string
  Kepanitiaan: string
  Tribe: string
  'Current city': string
  'Photo consent': string
  'Can publish': string
  Status: string
  Created: string
}

export type GetRosterRowsResult =
  | { status: 'ok'; data: RosterRow[] }
  | { status: 'error'; message: string }
