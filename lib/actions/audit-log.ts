'use server'

import { createClient } from '../supabase/server'
import { impl_listAuditLog } from './audit-log.impl'
import type { ListAuditLogInput, ListAuditLogResult } from './audit-log.types'

export async function listAuditLog(input: ListAuditLogInput): Promise<ListAuditLogResult> {
  const supabase = await createClient()
  return impl_listAuditLog(input, supabase)
}
