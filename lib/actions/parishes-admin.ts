'use server'

// Deliberately a SEPARATE file from parishes.ts: parishes.ts is imported by
// the public check-in flow (app/checkin/parish-autocomplete.tsx), which has
// no admin session and must never pull in the service-role client. This file
// imports createAdminClient (lib/supabase/admin.ts, `import 'server-only'`)
// for the admin-only parish curation actions — keeping that dependency out
// of parishes.ts avoids a `server-only` load failure for any check-in-flow
// test that doesn't explicitly mock lib/actions/parishes.

import { createClient } from '../supabase/server'
import { createAdminClient } from '../supabase/admin'
import { impl_listPendingParishes, impl_approveParish } from './parishes.impl'
import type { ListPendingParishesResult, ApproveParishResult } from './parishes.types'

export async function listPendingParishes(): Promise<ListPendingParishesResult> {
  const supabase = await createClient()
  const adminSupabase = createAdminClient()
  return impl_listPendingParishes({ supabase, adminSupabase })
}

export async function approveParish(parishId: string): Promise<ApproveParishResult> {
  const supabase = await createClient()
  const adminSupabase = createAdminClient()
  return impl_approveParish({ supabase, adminSupabase, input: { parishId } })
}
