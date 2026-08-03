import type { AuditAction } from '../audit'

// ── listAuditLog ──────────────────────────────────────────────────────────────

export type AuditLogFilters = {
  actorUserId?: string   // exact match on actor_user_id
  action?: AuditAction
  entityType?: string
  from?: string          // ISO date (YYYY-MM-DD), inclusive — created_at >= from
  to?: string             // ISO date (YYYY-MM-DD), inclusive — created_at < to+1day
}

// Composite (created_at, id) cursor — id breaks ties when created_at values
// collide, so page boundaries are deterministic regardless of timestamp
// collisions. Opaque to callers: always round-tripped from a previous
// AuditLogListItem, never hand-constructed.
export type AuditLogCursor = {
  createdAt: string
  id: number
}

export type AuditLogActor =
  | { kind: 'resolved'; fullName: string | null; email: string }
  | { kind: 'system' }       // actor_user_id IS NULL — cron/system-originated row
  | { kind: 'unresolved'; actorUserId: string }  // actor_user_id set but no matching app_users row

export type AuditLogListItem = {
  id: number
  action: string
  entityType: string
  entityId: string
  detailsJson: Record<string, unknown> | null
  createdAt: string
  actor: AuditLogActor
}

export type ListAuditLogInput = {
  filters?: AuditLogFilters
  cursor?: AuditLogCursor | null   // omit/null for the first page
  pageSize?: number                 // default DEFAULT_PAGE_SIZE, capped at it
}

export type ListAuditLogResult =
  | {
      status: 'ok'
      rows: AuditLogListItem[]
      total: number
      nextCursor: AuditLogCursor | null   // null when this was the last page
    }
  | { status: 'not_authorized' }
  | { status: 'error'; message: string }
