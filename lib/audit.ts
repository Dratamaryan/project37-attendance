import type { SupabaseClient } from '@supabase/supabase-js'

export const AUDIT_ACTIONS = {
  PEOPLE_CREATE:           'people.create',
  PEOPLE_UPDATE:           'people.update',
  PEOPLE_SOFT_DELETE:      'people.soft_delete',
  PEOPLE_RESTORE:          'people.restore',
  CONSENT_GRANT:           'consent.grant',
  CONSENT_REVOKE:          'consent.revoke',
  CHECKIN_CREATE:          'checkin.create',
  CHECKIN_CANCEL:          'checkin.cancel',
  SETTINGS_UPDATE:         'settings.update',
  PARISH_CREATE:           'parish.create',
  PARISH_APPROVE:          'parish.approve',
  PHOTO_UPLOAD:            'photo.upload',
  PHOTO_DELETE:            'photo.delete',
  EVENT_CREATE:            'event.create',
  EVENT_UPDATE:            'event.update',
  EVENT_INSTANCE_CANCEL:   'event_instance.cancel',
  ATTENDANCE_CREATE:       'attendance.create',
  EXPORT_CREATE:           'export.create',
  IMPORT_DRY_RUN:          'import.dry_run',
  IMPORT_COMMIT:           'import.commit',
} as const

export type AuditAction = typeof AUDIT_ACTIONS[keyof typeof AUDIT_ACTIONS]

export interface LogAuditParams {
  /** UUID of the acting user. Pass null for cron/system callers. */
  actorUserId: string | null
  action: AuditAction
  entityType: string
  entityId: string
  detailsJson?: Record<string, unknown> | null
  /**
   * X-Forwarded-For leftmost value. Advisory only — can be spoofed by clients.
   * Do not use for security decisions; use for audit trail context.
   */
  ipAddress?: string | null
  userAgent?: string | null
}

/**
 * Writes one row to audit_log via the log_audit() SECURITY DEFINER function.
 * Throws if the RPC call fails (e.g., missing session, DB error).
 */
export async function logAudit(
  params: LogAuditParams,
  supabase: SupabaseClient,
): Promise<void> {
  const { error } = await supabase.rpc('log_audit', {
    p_actor_user_id: params.actorUserId,
    p_action:        params.action,
    p_entity_type:   params.entityType,
    p_entity_id:     params.entityId,
    p_details_json:  params.detailsJson ?? null,
    p_ip_address:    params.ipAddress ?? null,
    p_user_agent:    params.userAgent ?? null,
  })

  if (error) throw error
}
