import type { SupabaseClient } from '@supabase/supabase-js'

export type AppUserRole = 'admin' | 'organizer'

export type RequireRoleResult =
  | { status: 'unauthenticated' }
  | { status: 'denied' }
  | { status: 'ok'; actorId: string; role: AppUserRole }

/**
 * Resolves the caller's app_users row via getClaims() (JWT-verified, never
 * getSession()). Distinguishes "not authenticated at all" from "authenticated
 * but role/active check failed" so callers can redirect vs. render
 * NotAuthorized as appropriate — collapsing both into one bucket would lose
 * that distinction for page-level guards.
 */
async function resolveActiveAppUser(
  supabase: SupabaseClient,
): Promise<RequireRoleResult> {
  const { data: claims } = await supabase.auth.getClaims()
  if (!claims) return { status: 'unauthenticated' }

  const actorId = claims.claims.sub

  const { data: appUser } = await supabase
    .from('app_users')
    .select('role, active')
    .eq('id', actorId)
    .single()

  if (!appUser || appUser.active !== true) return { status: 'denied' }

  return { status: 'ok', actorId, role: appUser.role as AppUserRole }
}

/** Caller must be an active admin. */
export async function requireActiveAdmin(supabase: SupabaseClient): Promise<RequireRoleResult> {
  const result = await resolveActiveAppUser(supabase)
  if (result.status !== 'ok') return result
  if (result.role !== 'admin') return { status: 'denied' }
  return result
}

/** Caller must be an active user with one of the given roles. */
export async function requireActiveRole(
  supabase: SupabaseClient,
  roles: AppUserRole[],
): Promise<RequireRoleResult> {
  const result = await resolveActiveAppUser(supabase)
  if (result.status !== 'ok') return result
  if (!roles.includes(result.role)) return { status: 'denied' }
  return result
}
