export type ChatIdKind = 'dm' | 'group' | 'supergroup' | 'channel_username'

export type ResolveChatIdResult =
  | { status: 'valid'; kind: ChatIdKind; value: string }
  | { status: 'invalid'; reason: 'empty' | 'invalid_format' | 'phone_number_shaped'; value: string }

const DM_RE = /^[1-9]\d*$/
const SUPERGROUP_RE = /^-100\d+$/
const GROUP_RE = /^-[1-9]\d*$/
const CHANNEL_USERNAME_RE = /^@[A-Za-z][A-Za-z0-9_]{4,31}$/

// Indonesian mobile prefix without the leading '+' (e.g. a pasted "6281808247576").
const ID_MOBILE_62_RE = /^628\d{7,11}$/
// Indonesian local format (e.g. a pasted "081808247576").
const LEADING_ZERO_RE = /^0\d+$/

/**
 * Classifies a raw `app_settings.telegram_admin_chat_id` string by structure only —
 * never numifies it (a supergroup ID overflows a 32-bit int). Validate once at
 * config-read time, not per-message.
 */
export function resolveChatId(raw: string): ResolveChatIdResult {
  if (raw.trim() === '') {
    return { status: 'invalid', reason: 'empty', value: raw }
  }

  // Unambiguous phone signals only — never gate on the bare positive-integer
  // shape a real DM ID also has (e.g. the stored ID `8922952648`).
  if (raw.startsWith('+') || LEADING_ZERO_RE.test(raw) || ID_MOBILE_62_RE.test(raw)) {
    return { status: 'invalid', reason: 'phone_number_shaped', value: raw }
  }

  if (DM_RE.test(raw)) {
    return { status: 'valid', kind: 'dm', value: raw }
  }
  if (SUPERGROUP_RE.test(raw)) {
    return { status: 'valid', kind: 'supergroup', value: raw }
  }
  if (GROUP_RE.test(raw)) {
    return { status: 'valid', kind: 'group', value: raw }
  }
  if (CHANNEL_USERNAME_RE.test(raw)) {
    return { status: 'valid', kind: 'channel_username', value: raw }
  }

  return { status: 'invalid', reason: 'invalid_format', value: raw }
}
