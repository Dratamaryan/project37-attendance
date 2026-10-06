// No 'use server' — imported by children.ts (server actions) and by tests.
// Never import this file in Client Components.

import type { SupabaseClient } from '@supabase/supabase-js'
import { sanitizeNameQuery, NAME_QUERY_MIN_LENGTH } from '../utils/name-query'
import { logAudit, AUDIT_ACTIONS } from '../audit'
import { formatJakarta } from '../events/timezone'
import type {
  ChildSummary,
  ChildWithParentSummary,
  ListChildrenByParentResult,
  LookupChildByNameResult,
  CreateChildInput,
  CreateChildResult,
  UpdateChildInput,
  UpdateChildResult,
  SoftDeleteChildResult,
} from './children.types'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const CHILD_SUMMARY_FIELDS = 'id, parent_person_id, full_name, birth_date, gender'

// ── listChildrenByParent ─────────────────────────────────────────────────────

/**
 * S8-T2 child check-in "via parent": the parent is already resolved through
 * lookupByPhone / lookupByName, so this only lists that person's children.
 *
 * Auth posture mirrors impl_lookupByName: the caller's own user-session client,
 * RLS as the enforcement layer (children_organizer_select), no admin client.
 */
export async function impl_listChildrenByParent(
  parentPersonId: string,
  supabase: SupabaseClient,
): Promise<ListChildrenByParentResult> {
  if (!UUID_RE.test(parentPersonId)) {
    return { status: 'invalid_input', field: 'parentPersonId', message: 'Invalid parent person id' }
  }

  const { data, error } = await supabase
    .from('children')
    .select(CHILD_SUMMARY_FIELDS)
    .eq('parent_person_id', parentPersonId)
    .is('deleted_at', null)   // explicit: check-in never surfaces deleted children,
    .order('full_name', { ascending: true })  // even for admins who bypass RLS

  if (error) {
    console.error('[listChildrenByParent]', error)
    return { status: 'error', message: 'Lookup failed' }
  }

  const rows = (data ?? []) as unknown as ChildSummary[]
  if (rows.length === 0) return { status: 'none' }

  return { status: 'children', children: rows }
}

// ── lookupChildByName ────────────────────────────────────────────────────────

/** Rows returned to the caller. A 6th row is fetched only to set hasMore. */
const CHILD_NAME_MATCH_LIMIT = 5

/**
 * S8-T2 child check-in by name. Same posture and sanitization as the S7-T5
 * impl_lookupByName: user-session client, RLS as the enforcement layer, the
 * query whitelist-sanitized before it reaches the ILIKE pattern, and the
 * minimum length enforced server-side on the sanitized value.
 *
 * Children have no nickname, so only full_name is matched. The parent's name is
 * embedded as the disambiguator. people!inner drops children whose parent is
 * soft-deleted (organizer RLS hides those parents) — accepted. The explicit
 * people.deleted_at filter makes admins see the same result as organizers.
 */
export async function impl_lookupChildByName(
  query: string,
  supabase: SupabaseClient,
): Promise<LookupChildByNameResult> {
  const safe = sanitizeNameQuery(query)
  if (safe.length < NAME_QUERY_MIN_LENGTH) {
    return { status: 'query_too_short' }
  }

  // limit is LIMIT+1: the extra row is the hasMore probe and is never returned.
  const { data, error } = await supabase
    .from('children')
    .select(`${CHILD_SUMMARY_FIELDS}, people!inner(full_name)`)
    .ilike('full_name', `%${safe}%`)
    .is('deleted_at', null)
    .is('people.deleted_at', null)
    .order('full_name', { ascending: true })
    .limit(CHILD_NAME_MATCH_LIMIT + 1)

  if (error) {
    console.error('[lookupChildByName]', error)
    return { status: 'error', message: 'Lookup failed' }
  }

  const rows = (data ?? []) as unknown as Array<ChildSummary & { people: { full_name: string } }>
  if (rows.length === 0) return { status: 'none' }

  const children: ChildWithParentSummary[] = rows
    .slice(0, CHILD_NAME_MATCH_LIMIT)
    .map(({ people, ...child }) => ({ ...child, parent_full_name: people.full_name }))

  return {
    status:   'matches',
    children,
    hasMore:  rows.length > CHILD_NAME_MATCH_LIMIT,
  }
}

// ── Mutation helpers ─────────────────────────────────────────────────────────

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * True iff `s` is a well-formed, calendar-valid 'YYYY-MM-DD' (1900..2099).
 * Pure string/integer arithmetic — never routed through `Date`, which would
 * parse a date-only string as UTC midnight (see lib/utils/date-display.ts).
 */
function isValidIsoDate(s: string): boolean {
  const m = ISO_DATE_RE.exec(s)
  if (!m) return false
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3])
  if (y < 1900 || y > 2099 || mo < 1 || mo > 12 || d < 1) return false
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]
  return d <= dim
}

/**
 * Validates an optional child birth_date. Must be a calendar-valid YYYY-MM-DD
 * and not after TODAY IN ASIA/JAKARTA. The comparison is lexicographic on
 * 'YYYY-MM-DD' strings (valid because both are zero-padded); "today" is the
 * current instant formatted in the Jakarta zone — never toISOString(), which
 * would be the UTC date and lag Jakarta by a day between 00:00 and 07:00 WIB.
 */
function birthDateError(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null
  if (!isValidIsoDate(value)) return 'Invalid date (expected YYYY-MM-DD)'
  if (value > formatJakarta(new Date(), 'yyyy-MM-dd')) return 'Birth date cannot be in the future'
  return null
}

function genderError(value: unknown): string | null {
  if (value === undefined || value === null || value === 'male' || value === 'female') return null
  return 'Invalid gender'
}

/** Escapes LIKE metacharacters so ilike() is a case-insensitive EXACT match. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/** Trimmed text, or null when empty/absent-as-null. */
function trimOrNull(v: string | null | undefined): string | null {
  const t = v?.trim()
  return t ? t : null
}

// ── createChild ──────────────────────────────────────────────────────────────

/**
 * S8-T4b: create a child under an existing, non-deleted parent. Shared by the
 * admin manage-people UI and the organizer check-in child mode — both on the
 * caller's own session client; RLS (children_admin_insert /
 * children_organizer_insert) is the enforcement layer. No service-role client.
 *
 * Duplicate same-name siblings WARN, never block: the insert always proceeds and
 * the pre-existing matches are returned as 'duplicate_warning' for the UI.
 *
 * Audit is IDs-only (minors): child_id + parent_id, never name or birth date —
 * same convention as the S8-T4 parser, deliberately NOT impl_createPerson's.
 */
export async function impl_createChild(
  input: CreateChildInput,
  supabase: SupabaseClient,
): Promise<CreateChildResult> {
  const { data: authData } = await supabase.auth.getUser()
  const user = authData.user
  if (!user) return { status: 'forbidden', message: 'Not authenticated' }

  const fieldErrors: Record<string, string> = {}
  if (typeof input.parentPersonId !== 'string' || !UUID_RE.test(input.parentPersonId)) {
    fieldErrors.parentPersonId = 'Invalid parent person id'
  }
  const fullName = typeof input.full_name === 'string' ? input.full_name.trim() : ''
  if (!fullName) fieldErrors.full_name = 'Required'
  const dateErr = birthDateError(input.birth_date)
  if (dateErr) fieldErrors.birth_date = dateErr
  const gErr = genderError(input.gender)
  if (gErr) fieldErrors.gender = gErr

  if (Object.keys(fieldErrors).length > 0) {
    return { status: 'validation_error', field_errors: fieldErrors }
  }

  // Parent guard. The FK alone would allow attaching to a soft-deleted parent,
  // and admins bypass the organizer deleted_at filter — so filter explicitly.
  const { data: parent, error: parentError } = await supabase
    .from('people')
    .select('id')
    .eq('id', input.parentPersonId)
    .is('deleted_at', null)
    .maybeSingle()

  if (parentError) {
    console.error('[createChild] parent lookup', parentError)
    return { status: 'error', message: 'Parent lookup failed' }
  }
  if (!parent) return { status: 'parent_not_found' }

  // Same-parent, same-name (case-insensitive) siblings — captured BEFORE the
  // insert so the new row is never in its own warning.
  const { data: dupRows, error: dupError } = await supabase
    .from('children')
    .select(CHILD_SUMMARY_FIELDS)
    .eq('parent_person_id', input.parentPersonId)
    .ilike('full_name', escapeLike(fullName))
    .is('deleted_at', null)
    .order('full_name', { ascending: true })

  if (dupError) {
    console.error('[createChild] duplicate check', dupError)
    return { status: 'error', message: 'Duplicate check failed' }
  }
  const existing = (dupRows ?? []) as unknown as ChildSummary[]

  const { data: created, error: insertError } = await supabase
    .from('children')
    .insert({
      parent_person_id: input.parentPersonId,
      full_name:        fullName,
      birth_date:       input.birth_date ?? null,
      gender:           input.gender ?? null,
      notes:            trimOrNull(input.notes),
      updated_at:       new Date().toISOString(),  // APP-MANAGED: children has no trigger
    })
    .select(CHILD_SUMMARY_FIELDS)
    .single()

  if (insertError) {
    if (insertError.code === '42501') return { status: 'forbidden', message: 'Permission denied' }
    console.error('[createChild] insert', insertError)
    return { status: 'error', message: 'Failed to create child' }
  }

  const child = created as unknown as ChildSummary

  await logAudit({
    actorUserId: user.id,
    action:      AUDIT_ACTIONS.CHILD_CREATE,
    entityType:  'children',
    entityId:    child.id,
    // IDs ONLY — never a name or birth date.
    detailsJson: { child_id: child.id, parent_id: child.parent_person_id },
  }, supabase)

  if (existing.length > 0) return { status: 'duplicate_warning', child, existing }
  return { status: 'created', child }
}

// ── updateChild ──────────────────────────────────────────────────────────────

const UPDATABLE_CHILD_FIELDS = ['full_name', 'birth_date', 'gender', 'notes'] as const

/**
 * Mirrors impl_updatePerson (fetch-before → update), but the audit carries
 * changed field NAMES only — no before/after values (minors).
 *
 * Only whitelisted keys reach the UPDATE: a server action receives arbitrary
 * JSON, so parent_person_id / deleted_at in the payload are silently ignored
 * rather than spread into the write.
 */
export async function impl_updateChild(
  id: string,
  input: UpdateChildInput,
  supabase: SupabaseClient,
): Promise<UpdateChildResult> {
  const { data: authData } = await supabase.auth.getUser()
  const user = authData.user
  if (!user) return { status: 'forbidden', message: 'Not authenticated' }

  if (typeof id !== 'string' || !UUID_RE.test(id)) return { status: 'not_found' }

  const patch: Record<string, unknown> = {}
  const fieldErrors: Record<string, string> = {}

  for (const f of UPDATABLE_CHILD_FIELDS) {
    if (!(f in input)) continue
    const v = input[f]
    switch (f) {
      case 'full_name': {
        const t = typeof v === 'string' ? v.trim() : ''
        if (!t) fieldErrors.full_name = 'Required'
        else patch.full_name = t
        break
      }
      case 'birth_date': {
        const err = birthDateError(v as string | null)
        if (err) fieldErrors.birth_date = err
        else patch.birth_date = v ?? null
        break
      }
      case 'gender': {
        const err = genderError(v)
        if (err) fieldErrors.gender = err
        else patch.gender = v ?? null
        break
      }
      case 'notes':
        patch.notes = trimOrNull(v as string | null)
        break
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { status: 'validation_error', field_errors: fieldErrors }
  }
  const changedFields = Object.keys(patch)
  if (changedFields.length === 0) {
    return { status: 'validation_error', field_errors: { _form: 'No fields to update' } }
  }

  const { data: before, error: fetchError } = await supabase
    .from('children')
    .select(CHILD_SUMMARY_FIELDS)
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle()

  if (fetchError) {
    console.error('[updateChild] fetch', fetchError)
    return { status: 'error', message: 'Failed to fetch child' }
  }
  if (!before) return { status: 'not_found' }

  const { data: updated, error: updateError } = await supabase
    .from('children')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .is('deleted_at', null)
    .select(CHILD_SUMMARY_FIELDS)
    .maybeSingle()

  if (updateError) {
    if (updateError.code === '42501') return { status: 'forbidden', message: 'Permission denied' }
    console.error('[updateChild] update', updateError)
    return { status: 'error', message: 'Failed to update child' }
  }
  if (!updated) return { status: 'not_found' }  // soft-deleted between fetch and update

  const child = updated as unknown as ChildSummary

  await logAudit({
    actorUserId: user.id,
    action:      AUDIT_ACTIONS.CHILD_UPDATE,
    entityType:  'children',
    entityId:    id,
    // Field NAMES only — no before/after values.
    detailsJson: { child_id: id, parent_id: child.parent_person_id, changed_fields: changedFields },
  }, supabase)

  return { status: 'updated', child }
}

// ── softDeleteChild ──────────────────────────────────────────────────────────

/**
 * Admin-only by RLS, not by an impl role check: children_organizer_update's
 * WITH CHECK requires deleted_at IS NULL, so an organizer's soft-delete is
 * rejected by Postgres (42501) and surfaces here as 'forbidden'.
 */
export async function impl_softDeleteChild(
  id: string,
  supabase: SupabaseClient,
): Promise<SoftDeleteChildResult> {
  const { data: authData } = await supabase.auth.getUser()
  const user = authData.user
  if (!user) return { status: 'forbidden', message: 'Not authenticated' }

  if (typeof id !== 'string' || !UUID_RE.test(id)) return { status: 'not_found' }

  const { data: before, error: fetchError } = await supabase
    .from('children')
    .select('id, parent_person_id')
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle()

  if (fetchError) {
    console.error('[softDeleteChild] fetch', fetchError)
    return { status: 'error', message: 'Failed to fetch child' }
  }
  if (!before) return { status: 'not_found' }

  const now = new Date().toISOString()
  // No RETURNING: after the write the row is soft-deleted, and a RETURNING
  // would have to pass a SELECT policy too. Zero-row outcome is caught below.
  const { error: updateError, count } = await supabase
    .from('children')
    .update({ deleted_at: now, updated_at: now }, { count: 'exact' })
    .eq('id', id)
    .is('deleted_at', null)

  if (updateError) {
    if (updateError.code === '42501') return { status: 'forbidden', message: 'Permission denied' }
    console.error('[softDeleteChild] update', updateError)
    return { status: 'error', message: 'Failed to delete child' }
  }
  if (count === 0) return { status: 'not_found' }

  const parentId = (before as { parent_person_id: string }).parent_person_id

  await logAudit({
    actorUserId: user.id,
    action:      AUDIT_ACTIONS.CHILD_SOFT_DELETE,
    entityType:  'children',
    entityId:    id,
    detailsJson: { child_id: id, parent_id: parentId },
  }, supabase)

  return { status: 'soft_deleted', id }
}
