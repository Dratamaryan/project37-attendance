import { describe, it, expect } from 'vitest'
import { normalizePhone, formatPhoneForDisplay } from '../phone'

describe('normalizePhone', () => {
  // ── Sprint 1 acceptance cases (T1-01, T1-02, T1-03, T1-06) ─────────────────

  it('T1-01: already E.164 ID number passes through', () => {
    expect(normalizePhone('+6282185352609', 'ID')).toEqual({ ok: true, e164: '+6282185352609' })
  })

  it('T1-02: Indonesian national with leading 0', () => {
    expect(normalizePhone('082185352609', 'ID')).toEqual({ ok: true, e164: '+6282185352609' })
  })

  it('T1-03: Indonesian national with leading 0 and spaces', () => {
    expect(normalizePhone('0821 8535 2609', 'ID')).toEqual({ ok: true, e164: '+6282185352609' })
  })

  it('dashes stripped — Indonesian national', () => {
    expect(normalizePhone('0821-8535-2609', 'ID')).toEqual({ ok: true, e164: '+6282185352609' })
  })

  it('national format without leading 0 (ID)', () => {
    expect(normalizePhone('82185352609', 'ID')).toEqual({ ok: true, e164: '+6282185352609' })
  })

  it('T1-06: already E.164 SG number passes through', () => {
    expect(normalizePhone('+6591234567', 'SG')).toEqual({ ok: true, e164: '+6591234567' })
  })

  it('SG national format (no country code)', () => {
    expect(normalizePhone('91234567', 'SG')).toEqual({ ok: true, e164: '+6591234567' })
  })

  // ── Legacy roster patterns — Sprint 6 import gate ───────────────────────────
  // Source: legacy REGISTRASI_PROJECT_DAY_Responses.xlsx
  // 153×11-digit, 29×10-digit, 9×9-digit values; all stored without country code.

  it('legacy: 11-digit ID without country code', () => {
    expect(normalizePhone('81808247576', 'ID')).toEqual({ ok: true, e164: '+6281808247576' })
  })

  it('legacy: 10-digit ID without country code', () => {
    expect(normalizePhone('8118053197', 'ID')).toEqual({ ok: true, e164: '+628118053197' })
  })

  it('legacy: 9-digit ID without country code', () => {
    expect(normalizePhone('818962281', 'ID')).toEqual({ ok: true, e164: '+62818962281' })
  })

  // ── Error cases ─────────────────────────────────────────────────────────────

  it('empty string → empty', () => {
    const r = normalizePhone('', 'ID')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('empty')
  })

  it('whitespace only → empty', () => {
    const r = normalizePhone('   ', 'ID')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('empty')
  })

  it('too short → too_short or invalid_for_country', () => {
    const r = normalizePhone('123', 'ID')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(['too_short', 'invalid_for_country']).toContain(r.reason)
  })

  it('non-numeric letters → invalid_for_country', () => {
    const r = normalizePhone('abcdefgh', 'ID')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('invalid_for_country')
  })

  it('+1 prefix with ID selector — invalid number returns error', () => {
    // +1234567890 is 9 digits after CC — not a valid US number (needs 10)
    // The '+' prefix causes country='ID' to be ignored; +1234567890 is still invalid
    const r = normalizePhone('+1234567890', 'ID')
    expect(r.ok).toBe(false)
  })

  // ── Edge case: + prefix overrides country selector ───────────────────────────
  // Rule: when input starts with '+', country argument is a hint, not a constraint.
  // Paste-from-WhatsApp behavior — user pastes full E.164 without touching the selector.

  it('typed +62 (ID) with SG selector → trusts + prefix, returns ID number', () => {
    expect(normalizePhone('+6282185352609', 'SG')).toEqual({ ok: true, e164: '+6282185352609' })
  })

  it('typed +65 (SG) with ID selector → trusts + prefix, returns SG number', () => {
    expect(normalizePhone('+6591234567', 'ID')).toEqual({ ok: true, e164: '+6591234567' })
  })
})

describe('formatPhoneForDisplay', () => {
  it('formats E.164 ID number in international format', () => {
    const result = formatPhoneForDisplay('+6282185352609')
    expect(result).toMatch(/^\+62/)
    // Confirm it's reformatted (spaces/separators added vs raw E.164)
    expect(result).not.toBe('+6282185352609')
  })

  it('formats E.164 SG number', () => {
    const result = formatPhoneForDisplay('+6591234567')
    expect(result).toMatch(/^\+65/)
  })

  it('returns input unchanged for unparseable string', () => {
    expect(formatPhoneForDisplay('not-a-phone')).toBe('not-a-phone')
  })
})
