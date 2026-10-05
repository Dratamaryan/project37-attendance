// No 'use server' — imported by children.ts (server actions) and by tests.
// Never import this file in Client Components.

import type { SupabaseClient } from '@supabase/supabase-js'
import { sanitizeNameQuery, NAME_QUERY_MIN_LENGTH } from '../utils/name-query'
import type {
  ChildSummary,
  ChildWithParentSummary,
  ListChildrenByParentResult,
  LookupChildByNameResult,
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
