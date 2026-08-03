// No 'use server' — imported by audit-log.ts (server action) and by tests.
// Never import this file in Client Components.
//
// Read-only viewer: no mutations, no row actions. requireActiveAdmin() runs
// FIRST, before any query, so a denied caller triggers zero DB round-trips —
// same ordering as digest-triggers.impl.ts / parishes.impl.ts.

import type { SupabaseClient } from '@supabase/supabase-js'
import { requireActiveAdmin } from '@/lib/auth/require-admin'
import type {
  AuditLogFilters,
  AuditLogCursor,
  AuditLogListItem,
  AuditLogActor,
  ListAuditLogInput,
  ListAuditLogResult,
} from './audit-log.types'

// Prod PostgREST max_rows = 1000 (confirmed 2026-07-01, see export.impl.ts).
// Kept safely below the cap for the same reason export.impl.ts is: a fixed
// ceiling risks silently truncating if the server limit ever drops.
const DEFAULT_PAGE_SIZE = 500

const SELECT_FIELDS =
  'id, action, entity_type, entity_id, details_json, created_at, actor_user_id, actor:app_users(full_name, email)'

type RowFromDb = {
  id: number
  action: string
  entity_type: string
  entity_id: string
  details_json: Record<string, unknown> | null
  created_at: string
  actor_user_id: string | null
  // PostgREST returns the embedded to-one relation as an object (or null when
  // actor_user_id is null, or when the referenced app_users row doesn't exist —
  // the FK is NO ACTION with no ON DELETE, so a dangling reference is possible
  // in principle even though today's data has zero orphans).
  actor: { full_name: string | null; email: string } | null
}

/**
 * Returns the calendar day immediately after dateStr (YYYY-MM-DD).
 * Same helper as export.impl.ts's nextDay — duplicated rather than imported
 * to keep the two modules independently readable (it's 4 lines).
 */
function nextDay(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number]
  const dt = new Date(Date.UTC(y, m - 1, d + 1))
  return dt.toISOString().slice(0, 10)
}

function resolveActor(row: RowFromDb): AuditLogActor {
  if (row.actor_user_id === null) return { kind: 'system' }
  if (row.actor === null) return { kind: 'unresolved', actorUserId: row.actor_user_id }
  return { kind: 'resolved', fullName: row.actor.full_name, email: row.actor.email }
}

function toListItem(row: RowFromDb): AuditLogListItem {
  return {
    id: row.id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    detailsJson: row.details_json,
    createdAt: row.created_at,
    actor: resolveActor(row),
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyFilters(query: any, filters: AuditLogFilters): any {
  if (filters.actorUserId !== undefined) {
    query = query.eq('actor_user_id', filters.actorUserId)
  }
  if (filters.action !== undefined) {
    query = query.eq('action', filters.action)
  }
  if (filters.entityType !== undefined) {
    query = query.eq('entity_type', filters.entityType)
  }
  if (filters.from !== undefined) {
    query = query.gte('created_at', filters.from)
  }
  if (filters.to !== undefined) {
    query = query.lt('created_at', nextDay(filters.to))
  }

  return query
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildFilteredQuery(supabase: SupabaseClient, filters: AuditLogFilters): any {
  return applyFilters(supabase.from('audit_log').select(SELECT_FIELDS), filters)
}

// ── impl_listAuditLog ────────────────────────────────────────────────────────

/**
 * Keyset-paginates audit_log by (created_at DESC, id DESC) — id breaks ties
 * on identical timestamps, so page boundaries are deterministic even when
 * multiple rows share a created_at value (no gap, no dupe, no skip).
 *
 * Fetches pageSize + 1 rows and trims to pageSize: this determines whether a
 * next page exists from a single round-trip, without the boundary edge case
 * where a page landing exactly on pageSize needs a follow-up "empty next
 * page" fetch just to learn there's nothing left.
 *
 * Cursor.createdAt is passed through VERBATIM into the `.or()` filter — no
 * `new Date(...).toISOString()` round-trip. Postgres timestamptz carries
 * microsecond precision but JS Date only carries milliseconds, so reparsing
 * silently truncates (e.g. `.494419` -> `.494`) and can floor the cursor
 * below the true boundary, skipping any row whose timestamp falls in the
 * truncated gap — confirmed by reproducing it locally against real audit_log
 * timestamps. supabase-js's `.or()` appends via `URLSearchParams`, which
 * correctly percent-encodes a literal `+` in the offset (`%2B`) — verified
 * against local Docker: the raw string round-trips page boundaries exactly,
 * including a forced tie on `created_at`, with no gap/dupe/skip.
 *
 * `total` comes from a SEPARATE count-only query scoped to `filters` alone
 * (no cursor). Attaching `{ count: 'exact' }` to the paginated query itself
 * would count only rows matching the CURSOR bound too, so `total` would
 * shrink on every subsequent page instead of reflecting the true filtered
 * total — wrong for both the UI ("42 results" flickering downward) and for
 * T5-09's row-count proof, which needs a total independent of page position.
 */
export async function impl_listAuditLog(
  input: ListAuditLogInput,
  supabase: SupabaseClient,
): Promise<ListAuditLogResult> {
  const guard = await requireActiveAdmin(supabase)
  if (guard.status !== 'ok') return { status: 'not_authorized' }

  const filters = input.filters ?? {}
  const pageSize = Math.min(input.pageSize ?? DEFAULT_PAGE_SIZE, DEFAULT_PAGE_SIZE)
  const cursor = input.cursor ?? null

  let query = buildFilteredQuery(supabase, filters)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(pageSize + 1)

  if (cursor) {
    const c = cursor.createdAt
    query = query.or(`created_at.lt.${c},and(created_at.eq.${c},id.lt.${cursor.id})`)
  }

  const countQuery = applyFilters(
    supabase.from('audit_log').select('id', { count: 'exact', head: true }),
    filters,
  )

  const [{ data, error }, { count, error: countError }] = await Promise.all([query, countQuery])

  if (error) {
    console.error('[listAuditLog]', error)
    return { status: 'error', message: 'Failed to fetch audit log' }
  }
  if (countError) {
    console.error('[listAuditLog] count', countError)
    return { status: 'error', message: 'Failed to count audit log' }
  }

  const page = (data ?? []) as unknown as RowFromDb[]
  const hasMore = page.length > pageSize
  const trimmed = hasMore ? page.slice(0, pageSize) : page

  const last = trimmed[trimmed.length - 1]
  const nextCursor: AuditLogCursor | null =
    hasMore && last ? { createdAt: last.created_at, id: last.id } : null

  return {
    status: 'ok',
    rows: trimmed.map(toListItem),
    total: count ?? 0,
    nextCursor,
  }
}
