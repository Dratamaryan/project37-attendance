export const SUPPORTED_SETTINGS_LANGUAGES = ['id', 'en'] as const
export type SettingsLanguage = typeof SUPPORTED_SETTINGS_LANGUAGES[number]

export const MIN_HORIZON_MONTHS = 1
export const MAX_HORIZON_MONTHS = 24

/** Full app_settings row as read for display (includes non-editable fields). */
export type AppSettingsRow = {
  default_country_code: string | null
  default_language: string
  materialization_horizon_mo: number
  birthday_notify_time: string
  birthday_notify_timezone: string
  birthday_notify_email: string | null
  telegram_admin_chat_id: string | null
  consent_policy_version: string | null
  retention_archive_years: number | null
  retention_aggregate_years: number | null
  updated_at: string
}

/** Fields T7 exposes as editable — see docs/sprint-5-task-7-verify.md for the excluded-column log. */
export type UpdateSettingsInput = Partial<{
  default_language: string
  materialization_horizon_mo: number
  birthday_notify_time: string
  birthday_notify_timezone: string
}>

export type GetSettingsResult =
  | { status: 'ok'; settings: AppSettingsRow }
  | { status: 'not_authorized' }
  | { status: 'error'; message: string }

export type ChangedField = { from: unknown; to: unknown }

export type UpdateSettingsResult =
  | { status: 'ok'; settings: AppSettingsRow; changed: Record<string, ChangedField> }
  | { status: 'validation_error'; field_errors: Record<string, string> }
  | { status: 'not_authorized' }
  | { status: 'error'; message: string }

export type HorizonImpactResult =
  | { status: 'ok'; estimated_count: number; horizon_end: string }
  | { status: 'validation_error'; message: string }
  | { status: 'not_authorized' }
  | { status: 'error'; message: string }
