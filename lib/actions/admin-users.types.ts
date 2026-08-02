import type { AppUserRole } from '@/lib/auth/require-admin'

export type { AppUserRole }

export type AppUserSummary = {
  id: string
  email: string
  full_name: string | null
  role: AppUserRole
  active: boolean
  invited_by: string | null
  created_at: string
  last_login_at: string | null
}

// ── listAppUsers ────────────────────────────────────────────────────────────

export type ListAppUsersResult =
  | { status: 'not_authorized' }
  | { status: 'ok'; users: AppUserSummary[] }
  | { status: 'error'; message: string }

// ── inviteOrganizer ──────────────────────────────────────────────────────────
//
// `repaired: true` means this call completed a previously-interrupted invite
// (an auth user already existed for this email with no app_users row) rather
// than creating a brand-new account. Best-effort signal (see impl comment on
// the created_at/confirmation_sent_at heuristic) — informational only, never
// branched on by the caller.

export type InviteOrganizerResult =
  | { status: 'not_authorized' }
  | { status: 'invalid_input'; message: string }
  | { status: 'already_exists'; role: AppUserRole; active: boolean }
  | { status: 'invited'; id: string; repaired: boolean }
  | { status: 'partial_failure'; authUserId: string; message: string }
  | { status: 'error'; message: string }

// ── changeRole ───────────────────────────────────────────────────────────────

export type ChangeRoleResult =
  | { status: 'not_authorized' }
  | { status: 'not_found' }
  | { status: 'not_allowed'; reason: 'last_admin' }
  | { status: 'ok'; id: string; role: AppUserRole }
  | { status: 'error'; message: string }

// ── deactivateUser ───────────────────────────────────────────────────────────

export type DeactivateUserResult =
  | { status: 'not_authorized' }
  | { status: 'not_found' }
  | { status: 'not_allowed'; reason: 'last_admin' | 'self' }
  | { status: 'ok'; id: string }
  | { status: 'error'; message: string }

// ── reactivateUser ───────────────────────────────────────────────────────────

export type ReactivateUserResult =
  | { status: 'not_authorized' }
  | { status: 'not_found' }
  | { status: 'ok'; id: string }
  | { status: 'error'; message: string }
