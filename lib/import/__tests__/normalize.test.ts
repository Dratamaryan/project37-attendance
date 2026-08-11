import { describe, it, expect } from 'vitest'
import { normalizeRow } from '../normalize'
import type { RawDataRow } from '../types'

function row(cellsByField: RawDataRow['cellsByField'], sourceRowNumber = 3): RawDataRow {
  return { sourceRowNumber, cellsByField }
}

describe('normalizeRow — phone', () => {
  it('legacy 11-digit ID without country code -> E.164', () => {
    const result = normalizeRow(row({ phone_raw: '81808247576' }))
    expect(result.phone_e164).toBe('+6281808247576')
    expect(result.phone_error).toBeNull()
  })

  it('legacy 10-digit ID without country code -> E.164', () => {
    const result = normalizeRow(row({ phone_raw: '8118053197' }))
    expect(result.phone_e164).toBe('+628118053197')
  })

  it('legacy 9-digit ID without country code -> E.164 (real data has zero invalid phones this length)', () => {
    const result = normalizeRow(row({ phone_raw: '818962281' }))
    expect(result.phone_e164).toBe('+62818962281')
  })

  it('garbled phone "abc" -> phone_error set, phone_e164 null', () => {
    const result = normalizeRow(row({ phone_raw: 'abc' }))
    expect(result.phone_e164).toBeNull()
    expect(result.phone_error).toBeTruthy()
  })

  it('too-short phone "123" -> phone_error set', () => {
    const result = normalizeRow(row({ phone_raw: '123' }))
    expect(result.phone_e164).toBeNull()
    expect(result.phone_error).toBeTruthy()
  })

  it('empty phone -> phone_error "empty"', () => {
    const result = normalizeRow(row({ phone_raw: '' }))
    expect(result.phone_error).toBe('empty')
  })

  it('numeric-typed cell (leading zero lost) still resolves via ID default', () => {
    const result = normalizeRow(row({ phone_raw: 82185352609 }))
    expect(result.phone_e164).toBe('+6282185352609')
  })

  it('different raw formats normalize to the same E.164 (proves dedup keys on normalized value)', () => {
    const a = normalizeRow(row({ phone_raw: '0818962281' }))
    const b = normalizeRow(row({ phone_raw: '+62818962281' }))
    expect(a.phone_e164).toBe(b.phone_e164)
    expect(a.phone_e164).toBe('+62818962281')
  })
})

describe('normalizeRow — birth_date coercion', () => {
  it('Date object (cellDates:true datetime cell) -> ISO date preserved', () => {
    const result = normalizeRow(row({ birth_date_raw: new Date(Date.UTC(1988, 6, 8)) }))
    expect(result.birth_date).toBe('1988-07-08')
    expect(result.warnings).toEqual([])
  })

  it('MM/DD/YYYY string -> parsed month-first', () => {
    const result = normalizeRow(row({ birth_date_raw: '12/15/1986' }))
    expect(result.birth_date).toBe('1986-12-15')
  })

  it('ambiguous M/D lock-in: 05/08/1990 -> May 8, 1990 (month-first, not day-first)', () => {
    const result = normalizeRow(row({ birth_date_raw: '05/08/1990' }))
    expect(result.birth_date).toBe('1990-05-08')
  })

  it('raw Excel serial (non-date-formatted number, e.g. 35684) -> correct calendar date via XLSX.SSF', () => {
    const result = normalizeRow(row({ birth_date_raw: 35684 }))
    // Cross-checked directly against XLSX.SSF.parse_date_code(35684) during planning: {y:1997,m:9,d:11}
    expect(result.birth_date).toBe('1997-09-11')
    expect(result.warnings).toEqual([])
  })

  it('out-of-range string (month>12) -> null + warning, not a row error', () => {
    const result = normalizeRow(row({ birth_date_raw: '13/40/2020' }))
    expect(result.birth_date).toBeNull()
    expect(result.warnings).toContain('out_of_range_date')
  })

  it('unparseable garbage string -> null + warning', () => {
    const result = normalizeRow(row({ birth_date_raw: 'not-a-date' }))
    expect(result.birth_date).toBeNull()
    expect(result.warnings).toContain('unparseable_date')
  })

  it('blank cell -> null, no warning (best-effort field, blank is not an error)', () => {
    const result = normalizeRow(row({ birth_date_raw: null }))
    expect(result.birth_date).toBeNull()
    expect(result.warnings).toEqual([])
  })
})

describe('normalizeRow — categorical maps', () => {
  it('marital_status: Belum Menikah -> single', () => {
    expect(normalizeRow(row({ marital_status_raw: 'Belum Menikah' })).marital_status).toBe('single')
  })

  it('marital_status: Sudah Menikah -> married', () => {
    expect(normalizeRow(row({ marital_status_raw: 'Sudah Menikah' })).marital_status).toBe('married')
  })

  it('marital_status: unmapped value -> null + warning naming the raw value', () => {
    const result = normalizeRow(row({ marital_status_raw: 'Cerai' }))
    expect(result.marital_status).toBeNull()
    expect(result.warnings).toContain('unmapped_marital_status:Cerai')
  })

  it('gender: Perempuan -> female, Laki-laki -> male', () => {
    expect(normalizeRow(row({ gender_raw: 'Perempuan' })).gender).toBe('female')
    expect(normalizeRow(row({ gender_raw: 'Laki-laki' })).gender).toBe('male')
  })

  it('gender: unmapped value -> null + warning', () => {
    const result = normalizeRow(row({ gender_raw: 'Lainnya' }))
    expect(result.gender).toBeNull()
    expect(result.warnings).toContain('unmapped_gender:Lainnya')
  })

  it('gender: absent column (Absensi sheet has no Jenis Kelamin) -> null, no warning', () => {
    const result = normalizeRow(row({}))
    expect(result.gender).toBeNull()
    expect(result.warnings).toEqual([])
  })
})

describe('normalizeRow — full_name / nickname', () => {
  it('nickname column blank -> falls back to first token of full_name', () => {
    const result = normalizeRow(row({ full_name: 'Bernadet Amelia', nickname: null }))
    expect(result.nickname).toBe('Bernadet')
    expect(result.nicknameFallbackApplied).toBe(true)
  })

  it('nickname column present -> used as-is, no fallback', () => {
    const result = normalizeRow(row({ full_name: 'Adhitya wilnanda', nickname: 'Adhit' }))
    expect(result.nickname).toBe('Adhit')
    expect(result.nicknameFallbackApplied).toBe(false)
  })

  it('whitespace-only full_name -> treated as blank (null), fallback never runs', () => {
    const result = normalizeRow(row({ full_name: '   ', nickname: null }))
    expect(result.full_name).toBeNull()
    expect(result.nickname).toBeNull()
    expect(result.nicknameFallbackApplied).toBe(false)
  })

  it('missing full_name -> null, nickname stays null (no fallback source)', () => {
    const result = normalizeRow(row({}))
    expect(result.full_name).toBeNull()
    expect(result.nickname).toBeNull()
  })
})

describe('normalizeRow — photo consent (S6-T5a, col-16)', () => {
  it('"Ya" -> granted, photo_publish_consent true, no warning', () => {
    const result = normalizeRow(row({ photo_consent_raw: 'Ya' }))
    expect(result.photo_consent_state).toBe('granted')
    expect(result.photo_publish_consent).toBe(true)
    expect(result.warnings).toEqual([])
  })

  it('"Tidak" -> refused, photo_publish_consent false, no warning', () => {
    const result = normalizeRow(row({ photo_consent_raw: 'Tidak' }))
    expect(result.photo_consent_state).toBe('refused')
    expect(result.photo_publish_consent).toBe(false)
    expect(result.warnings).toEqual([])
  })

  it('blank cell -> unknown, photo_publish_consent false, NO warning (expected, per B/3)', () => {
    const result = normalizeRow(row({ photo_consent_raw: null }))
    expect(result.photo_consent_state).toBe('unknown')
    expect(result.photo_publish_consent).toBe(false)
    expect(result.warnings).toEqual([])
  })

  it('"?" -> unknown, photo_publish_consent false, NO warning (expected, per B/3)', () => {
    const result = normalizeRow(row({ photo_consent_raw: '?' }))
    expect(result.photo_consent_state).toBe('unknown')
    expect(result.photo_publish_consent).toBe(false)
    expect(result.warnings).toEqual([])
  })

  it('column entirely absent from the row -> unknown, no warning (same as blank)', () => {
    const result = normalizeRow(row({}))
    expect(result.photo_consent_state).toBe('unknown')
    expect(result.photo_publish_consent).toBe(false)
    expect(result.warnings).toEqual([])
  })

  it('unexpected non-blank token -> unknown, photo_publish_consent false, WITH a visible warning (data-quality signal, non-fatal)', () => {
    const result = normalizeRow(row({ photo_consent_raw: 'Maybe' }))
    expect(result.photo_consent_state).toBe('unknown')
    expect(result.photo_publish_consent).toBe(false)
    expect(result.warnings).toContain('unmapped_consent_value:Maybe')
  })

  it('case-insensitive: "ya"/"YA"/"tidak" all map correctly', () => {
    expect(normalizeRow(row({ photo_consent_raw: 'ya' })).photo_consent_state).toBe('granted')
    expect(normalizeRow(row({ photo_consent_raw: 'YA' })).photo_consent_state).toBe('granted')
    expect(normalizeRow(row({ photo_consent_raw: 'tidak' })).photo_consent_state).toBe('refused')
  })
})
