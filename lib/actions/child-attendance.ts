'use server'

import { createClient } from '../supabase/server'
import { createAdminClient } from '../supabase/admin'
import { impl_createChildAttendance } from './child-attendance.impl'
import type {
  CreateChildAttendanceInput,
  CreateChildAttendanceResult,
} from './child-attendance.types'

export async function createChildAttendance(
  input: CreateChildAttendanceInput,
): Promise<CreateChildAttendanceResult> {
  const supabase = await createClient()
  const adminSupabase = createAdminClient()
  return impl_createChildAttendance({ supabase, adminSupabase, input })
}
