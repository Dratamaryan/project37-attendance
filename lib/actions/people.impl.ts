// No 'use server' — imported by people.ts (server actions) and by tests.
// Never import this file in Client Components.

import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizePhone } from '../utils/phone'
import { logAudit, AUDIT_ACTIONS } from '../audit'
import type {
  LookupResult,
  CreatePersonInput,
  CreateResult,
  UpdatePersonInput,
  UpdateResult,
  SoftDeleteResult,
  PersonSummary,
  ListPeopleInput,
  ListPeopleResult,
  PersonListItem,
  PersonFull,
  GetPersonResult,
  RestoreResult,
} from './people.types'
import type { SupportedCountry } from '../utils/phone'
import { impl_getPhotoSignedUrl } from '../storage/photos.impl'

const SUMMARY_FIELDS =
  'id, phone_e164, full_name, nickname, email, birth_date, gender, origin_parish, marital_status, photo_url, photo_publish_consent, created_at'

// ── lookupByPhone ────────────────────────────────────────────────────────────

export async function impl_lookupByPhone(
  rawPhone: string,
  country: SupportedCountry,
  supabase: SupabaseClient,
): Promise<LookupResult> {
  const normalized = normalizePhone(rawPhone, country)
  if (!normalized.ok) {
    return { status: 'invalid_phone', reason: normalized.reason }
  }

  const { data, error } = await supabase
    .from('people')
    .select(SUMMARY_FIELDS)
    .eq('phone_e164', normalized.e164)
    .is('deleted_at', null)   // explicit: check-in lookup never returns deleted people,
    .single()                 // even for admins who bypass the organizer_select RLS filter

  if (error) {
    if (error.code === 'PGRST116') {
      return { status: 'not_found', normalized_e164: normalized.e164 }
    }
    console.error('[lookupByPhone]', error)
    return { status: 'error', message: 'Lookup failed' }
  }

  return { status: 'found', person: data as PersonSummary }
}

// ── createPerson ─────────────────────────────────────────────────────────────

export async function impl_createPerson(
  input: CreatePersonInput,
  supabase: SupabaseClient,
): Promise<CreateResult> {
  const { data: authData } = await supabase.auth.getUser()
  const user = authData.user
  if (!user) return { status: 'error', message: 'Not authenticated' }

  // Validate required fields and normalize phone up front
  const fieldErrors: Record<string, string> = {}

  const normalized = normalizePhone(input.phone_e164_raw, input.country)
  if (!normalized.ok) {
    fieldErrors.phone_e164_raw = `Invalid phone: ${normalized.reason}`
  }
  if (!input.full_name?.trim()) fieldErrors.full_name = 'Required'
  if (!input.nickname?.trim()) fieldErrors.nickname = 'Required'
  if (!input.birth_date) fieldErrors.birth_date = 'Required'

  if (Object.keys(fieldErrors).length > 0) {
    return { status: 'validation_error', field_errors: fieldErrors }
  }

  const e164 = (normalized as { ok: true; e164: string }).e164

  // Pre-check for duplicate phone (friendly UX path — gives existing person's name
  // for the "already registered as [Name]" message in T1-11)
  const { data: existing, error: dupCheckError } = await supabase
    .from('people')
    .select('id, full_name')
    .eq('phone_e164', e164)
    .is('deleted_at', null)
    .single()

  if (dupCheckError && dupCheckError.code !== 'PGRST116') {
    console.error('[createPerson] duplicate check', dupCheckError)
    return { status: 'error', message: 'Database error during duplicate check' }
  }

  if (existing) {
    return { status: 'duplicate_phone', existing: { id: existing.id, full_name: existing.full_name } }
  }

  // Insert
  const { data: created, error: insertError } = await supabase
    .from('people')
    .insert({
      phone_e164:            e164,
      full_name:             input.full_name.trim(),
      nickname:              input.nickname.trim(),
      birth_date:            input.birth_date,
      email:                 input.email ?? null,
      birth_place:           input.birth_place ?? null,
      gender:                input.gender ?? null,
      origin_parish:         input.origin_parish ?? null,
      marital_status:        input.marital_status ?? null,
      current_city:          input.current_city ?? null,
      current_area:          input.current_area ?? null,
      photo_url:             input.photo_url ?? null,
      photo_publish_consent: input.photo_publish_consent ?? false,
      photo_consent_at:      input.photo_consent_at ?? null,
      notes:                 input.notes ?? null,
      kepanitiaan:           input.kepanitiaan ?? null,
      tribe:                 input.tribe ?? null,
      updated_at:            new Date().toISOString(),
    })
    .select(SUMMARY_FIELDS)
    .single()

  if (insertError) {
    if (insertError.code === '23505') {
      // TOCTOU race: another concurrent request inserted the same phone between
      // the pre-check SELECT and this INSERT. The UNIQUE constraint catches it;
      // fetch the winner's row to return the friendly duplicate message.
      const { data: conflicting } = await supabase
        .from('people')
        .select('id, full_name')
        .eq('phone_e164', e164)
        .single()
      return {
        status: 'duplicate_phone',
        existing: conflicting
          ? { id: conflicting.id, full_name: conflicting.full_name }
          : { id: '', full_name: 'Unknown' },
      }
    }
    console.error('[createPerson] insert', insertError)
    return { status: 'error', message: 'Failed to create person' }
  }

  // Audit — minimal details only, no full PII dump
  await logAudit({
    actorUserId: user.id,
    action:      AUDIT_ACTIONS.PEOPLE_CREATE,
    entityType:  'people',
    entityId:    created.id,
    detailsJson: {
      phone_e164: e164,
      full_name:  input.full_name.trim(),
      has_photo:  !!input.photo_url,
    },
  }, supabase)

  return { status: 'created', person: created as PersonSummary }
}

// ── updatePerson ─────────────────────────────────────────────────────────────

export async function impl_updatePerson(
  id: string,
  input: UpdatePersonInput,
  supabase: SupabaseClient,
): Promise<UpdateResult> {
  // Guard immutable and consent-only fields
  if ('phone_e164' in input) {
    return {
      status: 'validation_error',
      field_errors: { phone_e164: 'Phone cannot be changed. Contact an admin.' },
    }
  }
  if ('photo_publish_consent' in input) {
    return {
      status: 'validation_error',
      field_errors: { photo_publish_consent: 'Use setPhotoConsent to change photo consent.' },
    }
  }

  const { data: authData } = await supabase.auth.getUser()
  const user = authData.user
  if (!user) return { status: 'error', message: 'Not authenticated' }

  // Fetch before-values for the changed fields (used in audit diff)
  const { data: before, error: fetchError } = await supabase
    .from('people')
    .select(SUMMARY_FIELDS)
    .eq('id', id)
    .is('deleted_at', null)
    .single()

  if (fetchError) {
    if (fetchError.code === 'PGRST116') return { status: 'not_found' }
    console.error('[updatePerson] fetch', fetchError)
    return { status: 'error', message: 'Failed to fetch person' }
  }

  const changedFields = Object.keys(input) as (keyof UpdatePersonInput)[]
  const beforeSnapshot = Object.fromEntries(
    changedFields.map(f => [f, (before as Record<string, unknown>)[f]])
  )
  const afterSnapshot = Object.fromEntries(
    changedFields.map(f => [f, (input as Record<string, unknown>)[f]])
  )

  // Spread input directly — Object.entries captures only present keys, so absent
  // fields are never included in the payload (honoring the "absent = don't touch" convention).
  const { data: updated, error: updateError } = await supabase
    .from('people')
    .update({ ...input, updated_at: new Date().toISOString() })
    .eq('id', id)
    .is('deleted_at', null)
    .select(SUMMARY_FIELDS)
    .single()

  if (updateError) {
    if (updateError.code === 'PGRST116') return { status: 'not_found' }
    console.error('[updatePerson] update', updateError)
    return { status: 'error', message: 'Failed to update person' }
  }

  await logAudit({
    actorUserId: user.id,
    action:      AUDIT_ACTIONS.PEOPLE_UPDATE,
    entityType:  'people',
    entityId:    id,
    detailsJson: {
      changed_fields: changedFields,
      before:         beforeSnapshot,
      after:          afterSnapshot,
    },
  }, supabase)

  return { status: 'updated', person: updated as PersonSummary }
}

// ── softDeletePerson ─────────────────────────────────────────────────────────

export async function impl_softDeletePerson(
  id: string,
  supabase: SupabaseClient,
): Promise<SoftDeleteResult> {
  const { data: authData } = await supabase.auth.getUser()
  const user = authData.user
  if (!user) return { status: 'error', message: 'Not authenticated' }

  const now = new Date().toISOString()

  const { data, error } = await supabase
    .from('people')
    .update({ deleted_at: now, updated_at: now })
    .eq('id', id)
    .select('id')
    .single()

  if (error) {
    if (error.code === 'PGRST116') {
      // Person does not exist or is already deleted
      return { status: 'not_found' }
    }
    if (error.code === '42501') {
      // Organizer hit the organizer_update WITH CHECK constraint (deleted_at IS NULL)
      // — setting deleted_at to a non-null value is blocked at the RLS layer
      return { status: 'not_authorized', message: 'Only admins can delete people' }
    }
    console.error('[softDeletePerson]', error)
    return { status: 'error', message: 'Failed to delete person' }
  }

  if (!data) {
    return { status: 'not_authorized', message: 'Only admins can delete people' }
  }

  await logAudit({
    actorUserId: user.id,
    action:      AUDIT_ACTIONS.PEOPLE_SOFT_DELETE,
    entityType:  'people',
    entityId:    id,
  }, supabase)

  return { status: 'deleted' }
}

// ── setPhotoConsent ──────────────────────────────────────────────────────────

/**
 * Updates photo_publish_consent and related timestamp/version fields atomically.
 *
 * Grant (consent=true):
 *   - Sets photo_consent_at to now()
 *   - Stamps photo_consent_version from app_settings.consent_policy_version
 *   - Writes CONSENT_GRANT audit entry
 *
 * Revoke (consent=false):
 *   - Clears photo_consent_at (set to null)
 *   - Leaves photo_consent_version untouched in DB — preserves the version the
 *     person last consented under for historical record. Re-granting stamps the
 *     then-current version.
 *   - Writes CONSENT_REVOKE audit entry
 *
 * If the app_settings SELECT fails (non-blocking), falls back to null for
 * photo_consent_version and logs a warning — the consent write is not blocked
 * by a settings read failure. Prefer null over a wrong version string.
 */
export async function impl_setPhotoConsent(
  id: string,
  consent: boolean,
  supabase: SupabaseClient,
): Promise<UpdateResult> {
  const { data: authData } = await supabase.auth.getUser()
  const user = authData.user
  if (!user) return { status: 'error', message: 'Not authenticated' }

  // Fetch current consent value for audit diff
  const { data: current, error: fetchError } = await supabase
    .from('people')
    .select('id, photo_publish_consent')
    .eq('id', id)
    .is('deleted_at', null)
    .single()

  if (fetchError) {
    if (fetchError.code === 'PGRST116') return { status: 'not_found' }
    console.error('[setPhotoConsent] fetch', fetchError)
    return { status: 'error', message: 'Failed to fetch person' }
  }

  // Build update payload.
  // Grant: stamp photo_consent_version from app_settings.
  // Revoke: leave photo_consent_version untouched — don't include the key.
  const updatePayload: Record<string, unknown> = {
    photo_publish_consent: consent,
    photo_consent_at:      consent ? new Date().toISOString() : null,
    updated_at:            new Date().toISOString(),
  }

  if (consent) {
    const { data: settings, error: settingsError } = await supabase
      .from('app_settings')
      .select('consent_policy_version')
      .single()

    if (settingsError) {
      console.warn('[setPhotoConsent] could not read consent_policy_version, falling back to null', settingsError)
    }

    updatePayload.photo_consent_version = settings?.consent_policy_version ?? null
  }

  const { data: updated, error: updateError } = await supabase
    .from('people')
    .update(updatePayload)
    .eq('id', id)
    .is('deleted_at', null)
    .select(SUMMARY_FIELDS)
    .single()

  if (updateError) {
    if (updateError.code === 'PGRST116') return { status: 'not_found' }
    console.error('[setPhotoConsent] update', updateError)
    return { status: 'error', message: 'Failed to update consent' }
  }

  await logAudit({
    actorUserId: user.id,
    action:      consent ? AUDIT_ACTIONS.CONSENT_GRANT : AUDIT_ACTIONS.CONSENT_REVOKE,
    entityType:  'people',
    entityId:    id,
    detailsJson: { from: current.photo_publish_consent, to: consent },
  }, supabase)

  return { status: 'updated', person: updated as PersonSummary }
}

// ── listPeople ────────────────────────────────────────────────────────────────

const LIST_FIELDS =
  'id, phone_e164, full_name, nickname, origin_parish, photo_url, created_at, updated_at, deleted_at'

// Phone-only pattern: optional leading +, then digits only.
// Used to decide whether to search phone_e164 vs full_name/nickname.
const PHONE_SEARCH_RE = /^\+?\d+$/

export async function impl_listPeople(
  input: ListPeopleInput,
  supabase: SupabaseClient,
): Promise<ListPeopleResult> {
  const { data: authData } = await supabase.auth.getUser()
  const user = authData.user
  if (!user) return { status: 'not_authorized' }

  const { data: appUser } = await supabase
    .from('app_users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (appUser?.role !== 'admin') return { status: 'not_authorized' }

  // Validate page_size before clamping so callers get an explicit error
  if ((input.page_size ?? 25) > 100) {
    return { status: 'error', message: 'page_size max is 100' }
  }

  const page = Math.max(1, input.page ?? 1)
  const page_size = Math.max(1, input.page_size ?? 25)
  const query = input.query?.trim() ?? ''
  const include_deleted = input.include_deleted ?? false
  const from = (page - 1) * page_size
  const to = from + page_size - 1

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dbQuery: any = supabase
    .from('people')
    .select(LIST_FIELDS, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to)

  if (!include_deleted) {
    dbQuery = dbQuery.is('deleted_at', null)
  }

  if (query) {
    if (PHONE_SEARCH_RE.test(query)) {
      dbQuery = dbQuery.ilike('phone_e164', `%${query}%`)
    } else {
      dbQuery = dbQuery.or(`full_name.ilike.%${query}%,nickname.ilike.%${query}%`)
    }
  }

  const { data: rows, error, count } = await dbQuery

  if (error) {
    console.error('[listPeople]', error)
    return { status: 'error', message: 'Query failed' }
  }

  // Resolve signed URLs for all rows in parallel — avoids N+1 sequential round-trips.
  // photo_signed_url is null when the row has no photo or the URL cannot be resolved.
  const people: PersonListItem[] = await Promise.all(
    (rows ?? []).map(async (row: Record<string, unknown>) => {
      const urlResult = await impl_getPhotoSignedUrl(row.photo_url as string | null, supabase)
      const photo_signed_url =
        urlResult.status === 'signed' || urlResult.status === 'legacy_url'
          ? urlResult.url
          : null
      return { ...row, photo_signed_url } as PersonListItem
    })
  )

  return { status: 'ok', people, total: count ?? 0, page, page_size }
}

// ── getPersonById ─────────────────────────────────────────────────────────────

const FULL_FIELDS =
  'id, phone_e164, full_name, nickname, email, birth_place, birth_date, gender, ' +
  'origin_parish, marital_status, kepanitiaan, tribe, notes, current_city, current_area, ' +
  'photo_url, photo_publish_consent, photo_consent_at, photo_consent_version, ' +
  'created_at, updated_at, deleted_at'

export async function impl_getPersonById(
  id: string,
  supabase: SupabaseClient,
): Promise<GetPersonResult> {
  const { data: authData } = await supabase.auth.getUser()
  const user = authData.user
  if (!user) return { status: 'not_authorized' }

  const { data: appUser } = await supabase
    .from('app_users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (appUser?.role !== 'admin') return { status: 'not_authorized' }

  // No is('deleted_at', null) filter — edit page must load soft-deleted persons too.
  const { data, error } = await supabase
    .from('people')
    .select(FULL_FIELDS)
    .eq('id', id)
    .single()

  if (error) {
    if (error.code === 'PGRST116') return { status: 'not_found' }
    console.error('[getPersonById]', error)
    return { status: 'error', message: 'Failed to fetch person' }
  }

  return { status: 'ok', person: data as unknown as PersonFull }
}

// ── restorePerson ─────────────────────────────────────────────────────────────

export async function impl_restorePerson(
  id: string,
  supabase: SupabaseClient,
): Promise<RestoreResult> {
  const { data: authData } = await supabase.auth.getUser()
  const user = authData.user
  if (!user) return { status: 'not_authorized' }

  const { data: appUser } = await supabase
    .from('app_users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (appUser?.role !== 'admin') return { status: 'not_authorized' }

  const now = new Date().toISOString()

  // No is('deleted_at', null) filter — idempotent: restoring an already-active
  // person is a no-op that still returns 'restored'.
  const { data, error } = await supabase
    .from('people')
    .update({ deleted_at: null, updated_at: now })
    .eq('id', id)
    .select('id')
    .single()

  if (error) {
    if (error.code === 'PGRST116') return { status: 'not_found' }
    if (error.code === '42501') return { status: 'not_authorized' }
    console.error('[restorePerson]', error)
    return { status: 'error', message: 'Failed to restore person' }
  }

  if (!data) return { status: 'not_found' }

  await logAudit({
    actorUserId: user.id,
    action:      AUDIT_ACTIONS.PEOPLE_RESTORE,
    entityType:  'people',
    entityId:    id,
  }, supabase)

  return { status: 'restored' }
}
