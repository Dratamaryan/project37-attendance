import { parsePhoneNumber, type PhoneNumber } from 'libphonenumber-js/min'

export const SUPPORTED_COUNTRIES = ['ID', 'SG', 'MY', 'AU', 'NZ'] as const
export type SupportedCountry = typeof SUPPORTED_COUNTRIES[number]

/** Discriminated error reasons returned by normalizePhone. */
export type PhoneNormalizationError =
  | 'empty'
  | 'too_short'
  | 'too_long'
  | 'invalid_for_country'
  | 'unsupported_country'

export const COUNTRY_DIAL_CODES: Record<SupportedCountry, { code: string; label: string }> = {
  ID: { code: '+62', label: 'Indonesia (+62)' },
  SG: { code: '+65', label: 'Singapore (+65)' },
  MY: { code: '+60', label: 'Malaysia (+60)' },
  AU: { code: '+61', label: 'Australia (+61)' },
  NZ: { code: '+64', label: 'New Zealand (+64)' },
}

export const DEFAULT_COUNTRY: SupportedCountry = 'ID'

export type NormalizeResult =
  | { ok: true; e164: string }
  | { ok: false; reason: PhoneNormalizationError }

/**
 * Normalizes phone input to E.164 format for storage and lookup.
 *
 * Country-prefix precedence rule:
 *   - Input starting with `+`: the `country` argument is treated as a **hint** and
 *     may be overridden by the dialing prefix in the input. This matches
 *     paste-from-WhatsApp behavior where users copy full E.164 numbers without
 *     adjusting the country selector.
 *   - Input without `+`: the `country` argument is **authoritative**. Used to
 *     resolve local formats — leading 0, national number, or the 9–11-digit
 *     legacy values from the imported roster (e.g. '81808247576' → '+6281808247576').
 *
 * @example
 *   normalizePhone('082185352609', 'ID')   // { ok: true, e164: '+6282185352609' }
 *   normalizePhone('+6591234567', 'ID')    // { ok: true, e164: '+6591234567' } — '+' overrides
 *   normalizePhone('', 'ID')              // { ok: false, reason: 'empty' }
 */
export function normalizePhone(
  input: string,
  country: SupportedCountry = DEFAULT_COUNTRY,
): NormalizeResult {
  const trimmed = input.trim()
  if (!trimmed) return { ok: false, reason: 'empty' }

  // Strip visual separators (spaces, dashes, dots, parens, non-breaking space).
  // Intentionally does NOT strip letters — 'abcdefgh' stays invalid rather than silently becoming empty.
  const cleaned = trimmed.replace(/[\s\-.()– ]+/g, '')
  if (!cleaned) return { ok: false, reason: 'empty' }

  // When '+' present: parse without a country hint (trust the typed prefix).
  // When absent: pass country so the library can interpret leading 0 / national format.
  const parseCountry = cleaned.startsWith('+') ? undefined : country

  let parsed: PhoneNumber | undefined
  try {
    parsed = parsePhoneNumber(cleaned, parseCountry)
  } catch {
    // parsePhoneNumber throws ParseError on completely un-parseable input
  }

  if (!parsed?.isValid()) {
    const digits = cleaned.replace(/\D/g, '')
    if (digits.length === 0) return { ok: false, reason: 'invalid_for_country' }
    if (digits.length < 5) return { ok: false, reason: 'too_short' }
    if (digits.length > 15) return { ok: false, reason: 'too_long' }
    return { ok: false, reason: 'invalid_for_country' }
  }

  return { ok: true, e164: parsed.format('E.164') }
}

/**
 * Pretty-prints an E.164 number for display (e.g. "+62 821 8535 2609").
 * Uses INTERNATIONAL format from libphonenumber-js/min.
 * Returns the input unchanged if it cannot be parsed.
 */
export function formatPhoneForDisplay(e164: string): string {
  try {
    return parsePhoneNumber(e164).formatInternational()
  } catch {
    return e164
  }
}
