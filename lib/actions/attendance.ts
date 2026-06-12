'use server'

import { createClient } from '../supabase/server'
import { createAdminClient } from '../supabase/admin'
import { impl_createAttendance, impl_listRecentAttendanceForInstance } from './attendance.impl'
import type {
  CreateAttendanceInput,
  CreateAttendanceResult,
  ListRecentAttendanceInput,
  ListRecentAttendanceResult,
} from './attendance.types'

export async function createAttendance(
  input: CreateAttendanceInput,
): Promise<CreateAttendanceResult> {
  const supabase = await createClient()
  const adminSupabase = createAdminClient()
  return impl_createAttendance({ supabase, adminSupabase, input })
}

export async function listRecentAttendanceForInstance(
  input: ListRecentAttendanceInput,
): Promise<ListRecentAttendanceResult> {
  const supabase = await createClient()
  const adminSupabase = createAdminClient()
  return impl_listRecentAttendanceForInstance({ supabase, adminSupabase, input })
}
