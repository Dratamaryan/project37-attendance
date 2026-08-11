// Field-level normalizers: phone -> E.164, date coercion (3 source encodings),
// categorical maps, nickname fallback. Combined into normalizeRow(), which
// turns one RawDataRow into one ParsedPersonRow. No supabase here — pure and
// synchronous throughout, safe to unit-test with plain objects.

import * as XLSX from 'xlsx'
import { normalizePhone } from '../utils/phone'
import type { ParsedPersonRow, RawDataRow } from './types'

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function cellToTrimmedString(raw: unknown): string {
  if (raw === null || raw === undefined) return ''
  return String(raw).trim()
}

function normalizePhoneField(raw: unknown): { phone_e164: string | null; phone_error: string | null } {
  const str = cellToTrimmedString(raw)
  if (!str) return { phone_e164: null, phone_error: 'empty' }

  const result = normalizePhone(str, 'ID')
  if (result.ok) return { phone_e164: result.e164, phone_error: null }
  return { phone_e164: null, phone_error: result.reason }
}

interface DateCoercionResult {
  value: string | null
  warning?: string
}

/** Handles the three real-world encodings found in the source data:
 *  - Date object (from XLSX.read(..., { cellDates: true }) on a date-formatted cell)
 *  - MM/DD/YYYY string (US month-first order — confirmed by real data: day=15
 *    values exist, which is impossible as a month, proving month-first order)
 *  - raw Excel serial number (cell has a date VALUE but no date FORMAT applied,
 *    so cellDates:true leaves it as a plain number) — converted via SheetJS's
 *    own XLSX.SSF.parse_date_code rather than hand-rolled epoch math.
 *  Out-of-range or unparseable input never throws — always null + warning. */
function coerceDate(raw: unknown): DateCoercionResult {
  if (raw === null || raw === undefined || raw === '') return { value: null }

  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return { value: null, warning: 'unparseable_date' }
    const y = raw.getUTCFullYear()
    const m = raw.getUTCMonth() + 1
    const d = raw.getUTCDate()
    return { value: `${y}-${pad2(m)}-${pad2(d)}` }
  }

  if (typeof raw === 'number') {
    const code = XLSX.SSF.parse_date_code(raw)
    if (!code) return { value: null, warning: 'unparseable_date' }
    return { value: `${code.y}-${pad2(code.m)}-${pad2(code.d)}` }
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed)
    if (!match) return { value: null, warning: 'unparseable_date' }

    const month = Number(match[1])
    const day = Number(match[2])
    const year = Number(match[3])
    if (month < 1 || month > 12 || day < 1 || day > 31) {
      return { value: null, warning: 'out_of_range_date' }
    }
    return { value: `${year}-${pad2(month)}-${pad2(day)}` }
  }

  return { value: null, warning: 'unparseable_date' }
}

const MARITAL_STATUS_MAP: Record<string, 'single' | 'married'> = {
  'belum menikah': 'single',
  'sudah menikah': 'married',
}

function mapMaritalStatus(raw: unknown): { value: 'single' | 'married' | null; warning?: string } {
  const str = cellToTrimmedString(raw)
  if (!str) return { value: null }
  const mapped = MARITAL_STATUS_MAP[str.toLowerCase()]
  if (mapped) return { value: mapped }
  return { value: null, warning: `unmapped_marital_status:${str}` }
}

const GENDER_MAP: Record<string, 'male' | 'female'> = {
  perempuan: 'female',
  'laki-laki': 'male',
}

function mapGender(raw: unknown): { value: 'male' | 'female' | null; warning?: string } {
  const str = cellToTrimmedString(raw)
  if (!str) return { value: null }
  const mapped = GENDER_MAP[str.toLowerCase()]
  if (mapped) return { value: mapped }
  return { value: null, warning: `unmapped_gender:${str}` }
}

const CONSENT_STATE_MAP: Record<string, 'granted' | 'refused'> = {
  ya: 'granted',
  tidak: 'refused',
}

/** Same shape as mapMaritalStatus/mapGender but with the key inversion those
 *  can't use: photo_consent_state is NOT NULL at the DB level, so an unmapped
 *  token can't fall back to null the way marital_status/gender do -- it falls
 *  back to the safe 'unknown' (no affirmative grant recorded), same as a
 *  blank cell or '?', but WITH a warning since a real, non-blank, unrecognized
 *  token is a data-quality signal that blank/'?' are not. */
function mapConsentState(raw: unknown): { value: 'granted' | 'refused' | 'unknown'; warning?: string } {
  const str = cellToTrimmedString(raw)
  if (!str || str === '?') return { value: 'unknown' }
  const mapped = CONSENT_STATE_MAP[str.toLowerCase()]
  if (mapped) return { value: mapped }
  return { value: 'unknown', warning: `unmapped_consent_value:${str}` }
}

/** nicknameRaw wins if present; otherwise falls back to the first token of
 *  fullNameTrimmed. Only called with a non-blank fullNameTrimmed (the
 *  hard-required full_name check happens before this in normalizeRow), so
 *  the fallback can never produce an empty string. */
function deriveNickname(fullNameTrimmed: string, nicknameRaw: unknown): { value: string; fallbackApplied: boolean } {
  const nicknameStr = cellToTrimmedString(nicknameRaw)
  if (nicknameStr) return { value: nicknameStr, fallbackApplied: false }
  return { value: fullNameTrimmed.split(/\s+/)[0], fallbackApplied: true }
}

export function normalizeRow(row: RawDataRow): ParsedPersonRow {
  const warnings: string[] = []

  const fullNameStr = cellToTrimmedString(row.cellsByField.full_name)
  const full_name = fullNameStr.length > 0 ? fullNameStr : null

  const { phone_e164, phone_error } = normalizePhoneField(row.cellsByField.phone_raw)

  let nickname: string | null = null
  let nicknameFallbackApplied = false
  if (full_name) {
    const derived = deriveNickname(full_name, row.cellsByField.nickname)
    nickname = derived.value
    nicknameFallbackApplied = derived.fallbackApplied
  }

  const birthPlaceStr = cellToTrimmedString(row.cellsByField.birth_place)
  const originParishStr = cellToTrimmedString(row.cellsByField.origin_parish)
  const kepanitiaanStr = cellToTrimmedString(row.cellsByField.kepanitiaan)
  const tribeStr = cellToTrimmedString(row.cellsByField.tribe)

  const dateResult = coerceDate(row.cellsByField.birth_date_raw)
  if (dateResult.warning) warnings.push(dateResult.warning)

  const maritalResult = mapMaritalStatus(row.cellsByField.marital_status_raw)
  if (maritalResult.warning) warnings.push(maritalResult.warning)

  const genderResult = mapGender(row.cellsByField.gender_raw)
  if (genderResult.warning) warnings.push(genderResult.warning)

  const consentResult = mapConsentState(row.cellsByField.photo_consent_raw)
  if (consentResult.warning) warnings.push(consentResult.warning)

  return {
    sourceRowNumber: row.sourceRowNumber,
    phone_e164,
    phone_error,
    full_name,
    nickname,
    nicknameFallbackApplied,
    birth_place: birthPlaceStr || null,
    birth_date: dateResult.value,
    gender: genderResult.value,
    origin_parish: originParishStr || null,
    marital_status: maritalResult.value,
    kepanitiaan: kepanitiaanStr || null,
    tribe: tribeStr || null,
    photo_consent_state: consentResult.value,
    photo_publish_consent: consentResult.value === 'granted',
    warnings,
  }
}
