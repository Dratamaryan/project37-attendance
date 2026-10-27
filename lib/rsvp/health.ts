'use server'

import { createClient } from '@/lib/supabase/server'
import { requireActiveAdmin } from '@/lib/auth/require-admin'
import { impl_runRsvpHealthCheck, type RsvpHealthResult } from './health.impl'

export type RunRsvpHealthCheckResult =
  | { status: 'ok'; result: RsvpHealthResult }
  | { status: 'not_authorized' }

/**
 * S9-R6 A2 admin RSVP health check. Active admins only — organizers are
 * rejected. Read-only, so not audited. Returns the RsvpHealthResult object and
 * nothing else; no secret value ever crosses to the client.
 */
export async function runRsvpHealthCheck(): Promise<RunRsvpHealthCheckResult> {
  const supabase = await createClient()
  const guard = await requireActiveAdmin(supabase)
  // requireActiveAdmin already enforces role 'admin'; the explicit role check
  // keeps "organizers rejected" true even if that helper is ever loosened.
  if (guard.status !== 'ok' || guard.role !== 'admin') return { status: 'not_authorized' }
  return { status: 'ok', result: await impl_runRsvpHealthCheck() }
}
