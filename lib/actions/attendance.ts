'use server'

import { createClient } from '../supabase/server'
import { createAdminClient } from '../supabase/admin'
import { impl_createAttendance } from './attendance.impl'
import type { CreateAttendanceInput, CreateAttendanceResult } from './attendance.types'

export async function createAttendance(
  input: CreateAttendanceInput,
): Promise<CreateAttendanceResult> {
  const supabase = await createClient()
  const adminSupabase = createAdminClient()
  return impl_createAttendance({ supabase, adminSupabase, input })
}
