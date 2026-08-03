'use server'

import { createClient } from '../supabase/server'
import { createAdminClient } from '../supabase/admin'
import { impl_runBirthdayDigestNow, impl_runAttendanceSummaryNow } from './digest-triggers.impl'
import type { RunBirthdayDigestNowResult, RunAttendanceSummaryNowResult } from './digest-triggers.types'

export async function runBirthdayDigestNow(): Promise<RunBirthdayDigestNowResult> {
  const supabase = await createClient()
  const adminSupabase = createAdminClient()
  return impl_runBirthdayDigestNow({ supabase, adminSupabase })
}

export async function runAttendanceSummaryNow(): Promise<RunAttendanceSummaryNowResult> {
  const supabase = await createClient()
  const adminSupabase = createAdminClient()
  return impl_runAttendanceSummaryNow({ supabase, adminSupabase })
}
