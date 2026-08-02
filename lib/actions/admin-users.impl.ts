// No 'use server' — imported by admin-users.ts (server actions) and by tests.
// Never import this file in Client Components.
//
// Privilege gate ordering (T6 plan B): every exported function's FIRST action
// is requireActiveAdmin(supabase) using the caller's own JWT-backed client.
// adminSupabase (service role, bypasses RLS) is only ever touched AFTER that
// gate returns 'ok'. The wrapper (admin-users.ts) constructs adminSupabase
// unconditionally before calling in — same established pattern as
// attendance.impl.ts's impl_createAttendance — but merely holding the client
// reference is inert; no privileged call is ever made on it before the gate.

import type { SupabaseClient } from '@supabase/supabase-js'
import { requireActiveAdmin } from '@/lib/auth/require-admin'
import { logAudit, AUDIT_ACTIONS } from '../audit'
import type {
  AppUserRole,
  AppUserSummary,
  ListAppUsersResult,
  InviteOrganizerResult,
  ChangeRoleResult,
  DeactivateUserResult,
  ReactivateUserResult,
} from './admin-users.types'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const LAST_ADMIN_BAN_DURATION = '876000h' // ~100 years — GoTrue has no literal "permanent"

const APP_USER_FIELDS = 'id, email, full_name, role, active, invited_by, created_at, last_login_at'

// ── listAppUsers ──────────────────────────────────────────────────────────────

export async function impl_listAppUsers({
  supabase,
  adminSupabase,
}: {
  supabase: SupabaseClient
  adminSupabase: SupabaseClient
}): Promise<ListAppUsersResult> {
  const guard = await requireActiveAdmin(supabase)
  if (guard.status !== 'ok') return { status: 'not_authorized' }

  const { data, error } = await adminSupabase
    .from('app_users')
    .select(APP_USER_FIELDS)
    .order('created_at', { ascending: true })

  if (error) {
    console.error('[listAppUsers]', error)
    return { status: 'error', message: 'Failed to list users' }
  }

  return { status: 'ok', users: (data ?? []) as unknown as AppUserSummary[] }
}

// ── inviteOrganizer ───────────────────────────────────────────────────────────

async function findAuthUserByEmail(adminSupabase: SupabaseClient, email: string) {
  // supabase-js 2.106.1's admin.listUsers() has no server-side email filter
  // param (confirmed empirically — docs/sprint-5-task-6-verify.md Phase B) —
  // linear scan is acceptable at this app's team scale (single digits of
  // admin/organizer accounts).
  const { data, error } = await adminSupabase.auth.admin.listUsers({ page: 1, perPage: 1000 })
  if (error) return { user: null, error }
  const user = data.users.find((u) => u.email?.toLowerCase() === email) ?? null
  return { user, error: null }
}

async function repairConfirmedOrphan({
  supabase,
  adminSupabase,
  email,
  actorId,
}: {
  supabase: SupabaseClient
  adminSupabase: SupabaseClient
  email: string
  actorId: string
}): Promise<InviteOrganizerResult> {
  const { user: existingAuthUser, error: listError } = await findAuthUserByEmail(adminSupabase, email)
  if (listError) return { status: 'error', message: listError.message }
  if (!existingAuthUser) {
    // Auth said this email is already registered (email_exists) but we can't
    // find it — surface loudly rather than silently treating it as fresh.
    return { status: 'error', message: 'Auth reports email registered but the user could not be located' }
  }

  // Re-check app_users for that id — closes the pre-check-to-here race.
  const { data: raceCheck } = await adminSupabase
    .from('app_users')
    .select('role, active')
    .eq('id', existingAuthUser.id)
    .maybeSingle()

  if (raceCheck) {
    return { status: 'already_exists', role: raceCheck.role as AppUserRole, active: raceCheck.active as boolean }
  }

  const { error: insertError } = await adminSupabase
    .from('app_users')
    .insert({ id: existingAuthUser.id, email, role: 'organizer', invited_by: actorId })

  if (insertError) {
    return { status: 'partial_failure', authUserId: existingAuthUser.id, message: insertError.message }
  }

  await logAudit(
    {
      actorUserId: actorId,
      action: AUDIT_ACTIONS.APP_USER_INVITE,
      entityType: 'app_users',
      entityId: existingAuthUser.id,
      detailsJson: { email, repaired: true, was_confirmed: true },
    },
    supabase,
  )

  return { status: 'invited', id: existingAuthUser.id, repaired: true }
}

/**
 * Auth-user-first, then app_users insert. Re-invite is the idempotent repair
 * path for both partial-failure shapes:
 *
 * - Auth user exists but is UNCONFIRMED (no app_users row): empirically,
 *   inviteUserByEmail succeeds silently and resends (same user id, refreshed
 *   invited_at/confirmation_sent_at) rather than erroring — confirmed against
 *   local Docker + the installed supabase-js 2.106.1, see
 *   docs/sprint-5-task-6-verify.md Phase B. This reaches the SAME success
 *   path as a brand-new invite below, no extra branching needed.
 * - Auth user exists and IS confirmed (no app_users row — e.g. a prior
 *   app_users insert failed after they'd already accepted): inviteUserByEmail
 *   errors with code 'email_exists'; repairConfirmedOrphan() looks them up by
 *   email and completes the app_users insert.
 */
export async function impl_inviteOrganizer({
  supabase,
  adminSupabase,
  input,
}: {
  supabase: SupabaseClient
  adminSupabase: SupabaseClient
  input: { email: string }
}): Promise<InviteOrganizerResult> {
  const guard = await requireActiveAdmin(supabase)
  if (guard.status !== 'ok') return { status: 'not_authorized' }
  const actorId = guard.actorId

  const email = input.email.trim().toLowerCase()
  if (!email || !EMAIL_RE.test(email)) {
    return { status: 'invalid_input', message: 'Invalid email address' }
  }

  const { data: existingAppUser, error: preCheckError } = await adminSupabase
    .from('app_users')
    .select('role, active')
    .eq('email', email)
    .maybeSingle()

  if (preCheckError) return { status: 'error', message: preCheckError.message }
  if (existingAppUser) {
    return {
      status: 'already_exists',
      role: existingAppUser.role as AppUserRole,
      active: existingAppUser.active as boolean,
    }
  }

  // Ground truth for the "brand new vs. resent to an existing unconfirmed
  // orphan" signal — checked BEFORE the invite call, not inferred from
  // timestamps afterward. A timestamp-diff heuristic (comparing created_at to
  // confirmation_sent_at) was tried and rejected: a resend that happens
  // quickly — a fast re-invite, or just a fast test — falls under any fixed
  // threshold and gets misreported as "not repaired" even though it clearly
  // was. This adds one extra listUsers() scan per invite call, acceptable at
  // this app's team scale (single digits of admin/organizer accounts).
  const { user: preExistingAuthUser } = await findAuthUserByEmail(adminSupabase, email)

  const { data: inviteData, error: inviteError } = await adminSupabase.auth.admin.inviteUserByEmail(email, {
    data: { invited_by: actorId },
  })

  if (inviteError) {
    if (inviteError.code === 'email_exists') {
      return repairConfirmedOrphan({ supabase, adminSupabase, email, actorId })
    }
    return { status: 'error', message: inviteError.message }
  }

  const authUser = inviteData.user
  if (!authUser) {
    return { status: 'error', message: 'inviteUserByEmail returned no user' }
  }

  // Informational only, for the audit trail / UI message — never branched on.
  const repaired = preExistingAuthUser !== null

  const { error: insertError } = await adminSupabase
    .from('app_users')
    .insert({ id: authUser.id, email, role: 'organizer', invited_by: actorId })

  if (insertError) {
    return { status: 'partial_failure', authUserId: authUser.id, message: insertError.message }
  }

  await logAudit(
    {
      actorUserId: actorId,
      action: AUDIT_ACTIONS.APP_USER_INVITE,
      entityType: 'app_users',
      entityId: authUser.id,
      detailsJson: { email, repaired },
    },
    supabase,
  )

  return { status: 'invited', id: authUser.id, repaired }
}

// ── changeRole ────────────────────────────────────────────────────────────────

export async function impl_changeRole({
  supabase,
  adminSupabase,
  input,
}: {
  supabase: SupabaseClient
  adminSupabase: SupabaseClient
  input: { targetId: string; newRole: AppUserRole }
}): Promise<ChangeRoleResult> {
  const guard = await requireActiveAdmin(supabase)
  if (guard.status !== 'ok') return { status: 'not_authorized' }
  const actorId = guard.actorId

  const { data: target, error: targetError } = await adminSupabase
    .from('app_users')
    .select('id, role, active')
    .eq('id', input.targetId)
    .maybeSingle()

  if (targetError) return { status: 'error', message: targetError.message }
  if (!target) return { status: 'not_found' }

  const isDemotingActiveAdmin = target.role === 'admin' && target.active && input.newRole !== 'admin'
  if (isDemotingActiveAdmin) {
    // Friendly pre-check only — the DB trigger (enforce_last_admin) is the
    // authority and re-checks under its own advisory lock regardless.
    const { count } = await adminSupabase
      .from('app_users')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'admin')
      .eq('active', true)
    if ((count ?? 0) <= 1) {
      return { status: 'not_allowed', reason: 'last_admin' }
    }
  }

  const { error: updateError } = await adminSupabase
    .from('app_users')
    .update({ role: input.newRole })
    .eq('id', input.targetId)

  if (updateError) {
    if (updateError.message.includes('last_admin')) {
      return { status: 'not_allowed', reason: 'last_admin' }
    }
    return { status: 'error', message: updateError.message }
  }

  await logAudit(
    {
      actorUserId: actorId,
      action: AUDIT_ACTIONS.APP_USER_ROLE_CHANGE,
      entityType: 'app_users',
      entityId: input.targetId,
      detailsJson: { from_role: target.role, to_role: input.newRole },
    },
    supabase,
  )

  return { status: 'ok', id: input.targetId, role: input.newRole }
}

// ── deactivateUser ────────────────────────────────────────────────────────────

export async function impl_deactivateUser({
  supabase,
  adminSupabase,
  input,
}: {
  supabase: SupabaseClient
  adminSupabase: SupabaseClient
  input: { targetId: string }
}): Promise<DeactivateUserResult> {
  const guard = await requireActiveAdmin(supabase)
  if (guard.status !== 'ok') return { status: 'not_authorized' }
  const actorId = guard.actorId

  // Block self-deactivation before any other work — prevents an admin
  // accidentally locking themselves out with no one else to undo it.
  if (input.targetId === actorId) {
    return { status: 'not_allowed', reason: 'self' }
  }

  const { data: target, error: targetError } = await adminSupabase
    .from('app_users')
    .select('id, role, active')
    .eq('id', input.targetId)
    .maybeSingle()

  if (targetError) return { status: 'error', message: targetError.message }
  if (!target) return { status: 'not_found' }

  if (target.role === 'admin' && target.active) {
    const { count } = await adminSupabase
      .from('app_users')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'admin')
      .eq('active', true)
    if ((count ?? 0) <= 1) {
      return { status: 'not_allowed', reason: 'last_admin' }
    }
  }

  const { error: updateError } = await adminSupabase
    .from('app_users')
    .update({ active: false })
    .eq('id', input.targetId)

  if (updateError) {
    if (updateError.message.includes('last_admin')) {
      return { status: 'not_allowed', reason: 'last_admin' }
    }
    return { status: 'error', message: updateError.message }
  }

  // Defense in depth, best-effort, fire-and-forget — never blocks the
  // response. Prevents future sign-in / token refresh. NOTE: the installed
  // supabase-js (2.106.1) admin API has no user-id-based "revoke all
  // sessions" call (auth.admin.signOut takes a JWT, not a user id — verified
  // against the actual type defs, see docs/sprint-5-task-6-verify.md Phase
  // B) so that part of the original plan is dropped, not implemented. The
  // real lockout guarantee is Phase A's per-request `active` check, which
  // takes effect on this user's very next request regardless of their JWT's
  // remaining validity — already proven in the Phase A verify report.
  adminSupabase.auth.admin
    .updateUserById(input.targetId, { ban_duration: LAST_ADMIN_BAN_DURATION })
    .catch((err) => console.error('[deactivateUser] ban_duration best-effort failed', err))

  await logAudit(
    {
      actorUserId: actorId,
      action: AUDIT_ACTIONS.APP_USER_DEACTIVATE,
      entityType: 'app_users',
      entityId: input.targetId,
    },
    supabase,
  )

  return { status: 'ok', id: input.targetId }
}

// ── reactivateUser ────────────────────────────────────────────────────────────

export async function impl_reactivateUser({
  supabase,
  adminSupabase,
  input,
}: {
  supabase: SupabaseClient
  adminSupabase: SupabaseClient
  input: { targetId: string }
}): Promise<ReactivateUserResult> {
  const guard = await requireActiveAdmin(supabase)
  if (guard.status !== 'ok') return { status: 'not_authorized' }
  const actorId = guard.actorId

  const { data: target, error: targetError } = await adminSupabase
    .from('app_users')
    .select('id')
    .eq('id', input.targetId)
    .maybeSingle()

  if (targetError) return { status: 'error', message: targetError.message }
  if (!target) return { status: 'not_found' }

  const { error: updateError } = await adminSupabase
    .from('app_users')
    .update({ active: true })
    .eq('id', input.targetId)

  if (updateError) return { status: 'error', message: updateError.message }

  // Reverses the deactivate-time ban — never blocks the response.
  adminSupabase.auth.admin
    .updateUserById(input.targetId, { ban_duration: 'none' })
    .catch((err) => console.error('[reactivateUser] unban best-effort failed', err))

  await logAudit(
    {
      actorUserId: actorId,
      action: AUDIT_ACTIONS.APP_USER_REACTIVATE,
      entityType: 'app_users',
      entityId: input.targetId,
    },
    supabase,
  )

  return { status: 'ok', id: input.targetId }
}
