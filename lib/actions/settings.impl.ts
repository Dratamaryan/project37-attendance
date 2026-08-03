// No 'use server' — imported by settings.ts (server actions) and by tests.
// Never import this file in Client Components.
//
// Privilege gate ordering (T6 plan B, reused per T7 plan): every exported
// function's FIRST action is requireActiveAdmin(supabase) using the caller's
// own JWT-backed client. adminSupabase (service role, bypasses RLS) is only
// ever touched AFTER that gate returns 'ok' — same pattern as
// admin-users.impl.ts.

import type { SupabaseClient } from '@supabase/supabase-js'
import { addMonths } from 'date-fns'
import { revalidateTag } from 'next/cache'
import { requireActiveAdmin } from '@/lib/auth/require-admin'
import { DEFAULT_LANGUAGE_CACHE_TAG } from '@/lib/settings/constants'
import { logAudit, AUDIT_ACTIONS } from '../audit'
import {
  SUPPORTED_SETTINGS_LANGUAGES,
  MIN_HORIZON_MONTHS,
  MAX_HORIZON_MONTHS,
} from './settings.types'
import type {
  AppSettingsRow,
  UpdateSettingsInput,
  GetSettingsResult,
  UpdateSettingsResult,
  HorizonImpactResult,
  ChangedField,
} from './settings.types'

const SETTINGS_FIELDS =
  'default_country_code, default_language, materialization_horizon_mo, ' +
  'birthday_notify_time, birthday_notify_timezone, birthday_notify_email, ' +
  'telegram_admin_chat_id, consent_policy_version, retention_archive_years, ' +
  'retention_aggregate_years, updated_at'

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/

let cachedTimezones: Set<string> | null = null
function isValidTimezone(tz: string): boolean {
  if (!cachedTimezones) {
    cachedTimezones = new Set(Intl.supportedValuesOf('timeZone'))
  }
  return cachedTimezones.has(tz)
}

// ── getSettings ──────────────────────────────────────────────────────────────

export async function impl_getSettings({
  supabase,
  adminSupabase,
}: {
  supabase: SupabaseClient
  adminSupabase: SupabaseClient
}): Promise<GetSettingsResult> {
  const guard = await requireActiveAdmin(supabase)
  if (guard.status !== 'ok') return { status: 'not_authorized' }

  const { data, error } = await adminSupabase
    .from('app_settings')
    .select(SETTINGS_FIELDS)
    .eq('id', 1)
    .single()

  if (error) {
    console.error('[getSettings]', error)
    return { status: 'error', message: 'Failed to read settings' }
  }

  return { status: 'ok', settings: data as unknown as AppSettingsRow }
}

// ── updateSettings ───────────────────────────────────────────────────────────

export async function impl_updateSettings({
  supabase,
  adminSupabase,
  input,
}: {
  supabase: SupabaseClient
  adminSupabase: SupabaseClient
  input: UpdateSettingsInput
}): Promise<UpdateSettingsResult> {
  const guard = await requireActiveAdmin(supabase)
  if (guard.status !== 'ok') return { status: 'not_authorized' }
  const actorId = guard.actorId

  const fieldErrors: Record<string, string> = {}
  const patch: Record<string, unknown> = {}

  if ('default_language' in input) {
    const v = input.default_language
    if (!v || !(SUPPORTED_SETTINGS_LANGUAGES as readonly string[]).includes(v)) {
      fieldErrors.default_language = `Must be one of: ${SUPPORTED_SETTINGS_LANGUAGES.join(', ')}`
    } else {
      patch.default_language = v
    }
  }

  if ('materialization_horizon_mo' in input) {
    const v = input.materialization_horizon_mo
    if (
      v === undefined ||
      !Number.isInteger(v) ||
      v < MIN_HORIZON_MONTHS ||
      v > MAX_HORIZON_MONTHS
    ) {
      fieldErrors.materialization_horizon_mo =
        `Must be an integer between ${MIN_HORIZON_MONTHS} and ${MAX_HORIZON_MONTHS}`
    } else {
      patch.materialization_horizon_mo = v
    }
  }

  if ('birthday_notify_time' in input) {
    const v = input.birthday_notify_time
    if (!v || !TIME_RE.test(v)) {
      fieldErrors.birthday_notify_time = 'Must be a valid HH:mm time'
    } else {
      patch.birthday_notify_time = v
    }
  }

  if ('birthday_notify_timezone' in input) {
    const v = input.birthday_notify_timezone
    if (!v || !isValidTimezone(v)) {
      fieldErrors.birthday_notify_timezone = 'Must be a valid IANA timezone'
    } else {
      patch.birthday_notify_timezone = v
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { status: 'validation_error', field_errors: fieldErrors }
  }

  if (Object.keys(patch).length === 0) {
    return { status: 'error', message: 'No changes provided' }
  }

  const { data: before, error: beforeError } = await adminSupabase
    .from('app_settings')
    .select(SETTINGS_FIELDS)
    .eq('id', 1)
    .single()

  if (beforeError || !before) {
    console.error('[updateSettings] read-before-write failed', beforeError)
    return { status: 'error', message: 'Failed to read current settings' }
  }

  patch.updated_at = new Date().toISOString()

  const { data: after, error: updateError } = await adminSupabase
    .from('app_settings')
    .update(patch)
    .eq('id', 1)
    .select(SETTINGS_FIELDS)
    .single()

  if (updateError || !after) {
    console.error('[updateSettings] update failed', updateError)
    return { status: 'error', message: updateError?.message ?? 'Update failed' }
  }

  const beforeRow = before as unknown as Record<string, unknown>
  const afterRow = after as unknown as Record<string, unknown>

  const changed: Record<string, ChangedField> = {}
  for (const key of Object.keys(patch)) {
    if (key === 'updated_at') continue
    if (beforeRow[key] !== afterRow[key]) {
      changed[key] = { from: beforeRow[key], to: afterRow[key] }
    }
  }

  if (Object.keys(changed).length > 0) {
    await logAudit(
      {
        actorUserId: actorId,
        action: AUDIT_ACTIONS.SETTINGS_UPDATE,
        entityType: 'app_settings',
        entityId: '1',
        detailsJson: changed,
      },
      supabase,
    )
  }

  // Immediate-effect: an admin changing default_language must not have to
  // wait out the cache's revalidate window for a fresh cookie-less session
  // to see it (T7 plan refinement 2). Proven live — see verify report.
  //
  // Next 16 changed revalidateTag's semantics: profile 'max' (the new
  // recommended default) is stale-while-revalidate — the NEXT visitor still
  // gets the OLD cached value while fresh data loads in the background, which
  // would silently fail the "immediate" requirement here. { expire: 0 } is
  // Next 16's actual immediate-expiration profile (next request anywhere is a
  // blocking cache-miss re-fetch) — confirmed against the installed Next
  // 16.2.6 docs, not assumed. updateTag() was considered and rejected: its
  // docstring scopes it to "read-your-own-writes" for the SAME Server Action
  // caller, but this must be visible to OTHER, unrelated cookie-less
  // visitors, not just the admin who made the change.
  if ('default_language' in changed) {
    revalidateTag(DEFAULT_LANGUAGE_CACHE_TAG, { expire: 0 })
  }

  return { status: 'ok', settings: after as unknown as AppSettingsRow, changed }
}

// ── getHorizonImpact ──────────────────────────────────────────────────────────

/**
 * Estimates how many currently-scheduled event_instances would be pruned on
 * the NEXT nightly materialize run if the horizon were changed to
 * newHorizonMonths right now. This is deliberately an ESTIMATE, not a
 * guarantee: the check, the eventual write, and the cron's own prune step are
 * three separate, non-atomic moments — events can be added/changed between
 * confirm and the next nightly run, and the cron's own `now()` will differ
 * slightly from this read's `now()`. Callers must not present this number as
 * exact (see settings-client.tsx copy).
 */
export async function impl_getHorizonImpact({
  supabase,
  adminSupabase,
  input,
}: {
  supabase: SupabaseClient
  adminSupabase: SupabaseClient
  input: { newHorizonMonths: number }
}): Promise<HorizonImpactResult> {
  const guard = await requireActiveAdmin(supabase)
  if (guard.status !== 'ok') return { status: 'not_authorized' }

  const { newHorizonMonths } = input
  if (
    !Number.isInteger(newHorizonMonths) ||
    newHorizonMonths < MIN_HORIZON_MONTHS ||
    newHorizonMonths > MAX_HORIZON_MONTHS
  ) {
    return { status: 'validation_error', message: 'Invalid horizon value' }
  }

  const horizonEnd = addMonths(new Date(), newHorizonMonths)

  const { count, error } = await adminSupabase
    .from('event_instances')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'scheduled')
    .gt('scheduled_at', horizonEnd.toISOString())

  if (error) {
    console.error('[getHorizonImpact]', error)
    return { status: 'error', message: 'Failed to estimate impact' }
  }

  return { status: 'ok', estimated_count: count ?? 0, horizon_end: horizonEnd.toISOString() }
}
