import type { PhoneNormalizationError, SupportedCountry } from '../utils/phone'

export type { SupportedCountry, PhoneNormalizationError }

// Fields returned across all people actions.
// Excludes admin-only fields (kepanitiaan, tribe, birth_place, current_city,
// current_area, notes) — the admin edit page fetches the full row directly.
// photo_url is a raw storage path or legacy GDrive URL; UI resolves via
// getPhotoSignedUrl (Task 7).
export type PersonSummary = {
  id: string
  phone_e164: string
  full_name: string
  nickname: string
  email: string | null
  birth_date: string | null      // ISO date (YYYY-MM-DD); Postgres `date` serialized as string
  gender: 'male' | 'female' | null
  origin_parish: string | null
  marital_status: 'married' | 'single' | null
  photo_url: string | null
  photo_publish_consent: boolean
  created_at: string
}

// ── lookupByPhone ────────────────────────────────────────────────

export type LookupResult =
  | { status: 'found';         person: PersonSummary }
  | { status: 'not_found';     normalized_e164: string }
  | { status: 'invalid_phone'; reason: PhoneNormalizationError }
  | { status: 'error';         message: string }

// ── createPerson ─────────────────────────────────────────────────

export type CreatePersonInput = {
  // Required
  phone_e164_raw: string
  country: SupportedCountry
  full_name: string
  nickname: string
  birth_date: string  // ISO date string (YYYY-MM-DD)
  // Optional — absent means null in DB; present-and-null explicitly clears the field
  email?: string | null
  birth_place?: string | null
  gender?: 'male' | 'female' | null
  origin_parish?: string | null
  marital_status?: 'married' | 'single' | null
  current_city?: string | null
  current_area?: string | null
  photo_url?: string | null
  photo_publish_consent?: boolean
  photo_consent_at?: string | null
  notes?: string | null
  /**
   * Admin-only fields. Accepted by the action for direct admin tooling;
   * NOT exposed in check-in UI (Tasks T8/T9). UI layers enforce the
   * restriction at the component level.
   */
  kepanitiaan?: string | null
  tribe?: string | null
}

export type CreateResult =
  | { status: 'created';          person: PersonSummary }
  | { status: 'duplicate_phone';  existing: { id: string; full_name: string } }
  | { status: 'validation_error'; field_errors: Record<string, string> }
  | { status: 'error';            message: string }

// ── updatePerson ─────────────────────────────────────────────────

// Field-presence convention: field present in the object (even if null) means
// write that value to the DB; field absent from the object means don't touch it.
// phone_e164 and photo_publish_consent are rejected at runtime if passed —
// use setPhotoConsent for consent; phone changes are Sprint 5 / admin-only.
// Note: actions set updated_at explicitly on every UPDATE — no DB trigger on people.
export type UpdatePersonInput = Partial<{
  full_name:      string
  nickname:       string
  email:          string | null
  birth_place:    string | null
  birth_date:     string | null
  gender:         'male' | 'female' | null
  origin_parish:  string | null
  marital_status: 'married' | 'single' | null
  kepanitiaan:    string | null
  tribe:          string | null
  current_city:   string | null
  current_area:   string | null
  photo_url:      string | null
  notes:          string | null
}>

export type UpdateResult =
  | { status: 'updated';          person: PersonSummary }
  | { status: 'not_found' }
  | { status: 'validation_error'; field_errors: Record<string, string> }
  | { status: 'error';            message: string }

// ── softDeletePerson ─────────────────────────────────────────────

export type SoftDeleteResult =
  | { status: 'deleted' }
  | { status: 'not_found' }
  | { status: 'not_authorized'; message: string }
  | { status: 'error';          message: string }

// ── listPeople ────────────────────────────────────────────────────

export type ListPeopleInput = {
  query?: string           // name / nickname / phone substring; case-insensitive
  include_deleted?: boolean // default false
  page?: number            // default 1
  page_size?: number       // default 25, max 100
}

export type PersonListItem = {
  id: string
  phone_e164: string             // displayed via formatPhoneForDisplay in UI
  full_name: string
  nickname: string
  origin_parish: string | null
  photo_url: string | null       // raw DB path or legacy GDrive URL
  photo_signed_url: string | null // pre-resolved server-side (null when no photo or URL error)
  created_at: string
  updated_at: string
  deleted_at: string | null      // null when active; ISO timestamp when soft-deleted
}

export type ListPeopleResult =
  | { status: 'ok'; people: PersonListItem[]; total: number; page: number; page_size: number }
  | { status: 'not_authorized' }
  | { status: 'error'; message: string }
