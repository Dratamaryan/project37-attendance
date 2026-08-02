'use server'

import { createClient } from '../supabase/server'
import { createAdminClient } from '../supabase/admin'
import {
  impl_listAppUsers,
  impl_inviteOrganizer,
  impl_changeRole,
  impl_deactivateUser,
  impl_reactivateUser,
} from './admin-users.impl'
import type {
  AppUserRole,
  ListAppUsersResult,
  InviteOrganizerResult,
  ChangeRoleResult,
  DeactivateUserResult,
  ReactivateUserResult,
} from './admin-users.types'

export async function listAppUsers(): Promise<ListAppUsersResult> {
  const supabase = await createClient()
  const adminSupabase = createAdminClient()
  return impl_listAppUsers({ supabase, adminSupabase })
}

export async function inviteOrganizer(email: string): Promise<InviteOrganizerResult> {
  const supabase = await createClient()
  const adminSupabase = createAdminClient()
  return impl_inviteOrganizer({ supabase, adminSupabase, input: { email } })
}

export async function changeRole(targetId: string, newRole: AppUserRole): Promise<ChangeRoleResult> {
  const supabase = await createClient()
  const adminSupabase = createAdminClient()
  return impl_changeRole({ supabase, adminSupabase, input: { targetId, newRole } })
}

export async function deactivateUser(targetId: string): Promise<DeactivateUserResult> {
  const supabase = await createClient()
  const adminSupabase = createAdminClient()
  return impl_deactivateUser({ supabase, adminSupabase, input: { targetId } })
}

export async function reactivateUser(targetId: string): Promise<ReactivateUserResult> {
  const supabase = await createClient()
  const adminSupabase = createAdminClient()
  return impl_reactivateUser({ supabase, adminSupabase, input: { targetId } })
}
