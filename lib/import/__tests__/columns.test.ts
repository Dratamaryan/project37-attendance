import { describe, it, expect } from 'vitest'
import { selectSheet, detectHeaderRow, extractDataRows, TARGET_SHEET_NAME, COLUMN_MAPPINGS } from '../columns'

const CONSENT_HEADER = COLUMN_MAPPINGS.find((m) => m.target === 'photo_consent_raw')!.headerAliases[0]

describe('selectSheet', () => {
  it('multi-sheet workbook with Absensi present -> picks it', () => {
    const result = selectSheet(['Form responses 1', 'Absensi'])
    expect(result).toEqual({ ok: true, sheetName: 'Absensi' })
  })

  it('multi-sheet workbook without Absensi -> loud-fail listing available sheets', () => {
    const result = selectSheet(['Sheet1', 'Sheet2'])
    expect(result).toEqual({ ok: false, error: 'sheet_not_found', availableSheets: ['Sheet1', 'Sheet2'] })
  })

  it('single-sheet workbook (CSV shape) -> picks the sole sheet regardless of name', () => {
    const result = selectSheet(['Sheet1'])
    expect(result).toEqual({ ok: true, sheetName: 'Sheet1' })
  })

  it('never silently falls back to first-of-many when Absensi is absent', () => {
    const result = selectSheet(['Not Absensi', 'Also Not Absensi'])
    expect(result.ok).toBe(false)
  })

  it('TARGET_SHEET_NAME is Absensi', () => {
    expect(TARGET_SHEET_NAME).toBe('Absensi')
  })
})

describe('detectHeaderRow', () => {
  const HEADER_ROW = ['No', 'Nama Lengkap', 'Nama Panggilan', 'Nomor HP', 'Kepanitiaan', 'Tribe', CONSENT_HEADER]

  it('finds header at row index 1 with a junk totals row above it (mirrors real Absensi structure)', () => {
    const rawRows = [
      [null, null, null, null, 55, 43], // junk totals row — Excel row 1
      HEADER_ROW,                        // Excel row 2
      [1, 'Adhitya wilnanda', 'Adhit', '081808247576', 'Shepherd/Servant', 'Bethlehem', 'Ya'],
    ]
    const result = detectHeaderRow(rawRows)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.headerRowIndex).toBe(1)
      expect(result.columnIndexByField.full_name).toBe(1)
      expect(result.columnIndexByField.phone_raw).toBe(3)
      expect(result.columnIndexByField.nickname).toBe(2)
      expect(result.columnIndexByField.photo_consent_raw).toBe(6)
    }
  })

  it('finds header at row 0 when there is no junk row', () => {
    const rawRows = [HEADER_ROW, [1, 'A Name', 'Nick', '081234567890']]
    const result = detectHeaderRow(rawRows)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.headerRowIndex).toBe(0)
  })

  it('required column Nomor HP missing from every scanned row -> loud-fail naming it', () => {
    const rawRows = [['No', 'Nama Lengkap', 'Nama Panggilan', CONSENT_HEADER]]
    const result = detectHeaderRow(rawRows)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.missingFields).toEqual(['Nomor HP'])
  })

  it('required consent column missing from every scanned row -> loud-fail naming it (anti-silent-drop guard, S6-T5a)', () => {
    const rawRows = [['No', 'Nama Lengkap', 'Nomor HP']]
    const result = detectHeaderRow(rawRows)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.missingFields).toEqual([CONSENT_HEADER])
  })

  it('consent header renamed/typo\'d (not an exact alias match) is indistinguishable from absent -> still loud-fails', () => {
    // Proves the hazard the S6-T5a plan called out: detectHeaderRow does no
    // internal-whitespace normalization, so a header that's even slightly
    // different from the pinned alias does not match, and required:true
    // turns that into the same loud missing_required_columns failure as a
    // fully absent column — never a silent all-'unknown' import.
    const rawRows = [['Nama Lengkap', 'Nomor HP', 'Apakah kamu setuju untuk foto/data di publish?']]
    const result = detectHeaderRow(rawRows)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.missingFields).toEqual([CONSENT_HEADER])
  })

  it('case- and whitespace-insensitive alias matching', () => {
    const rawRows = [[' nama lengkap ', 'NOMOR HP', CONSENT_HEADER.toUpperCase()]]
    const result = detectHeaderRow(rawRows)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.columnIndexByField.full_name).toBe(0)
      expect(result.columnIndexByField.phone_raw).toBe(1)
      expect(result.columnIndexByField.photo_consent_raw).toBe(2)
    }
  })

  it('nickname column absent entirely is not fatal (optional; consent still required and present here)', () => {
    const rawRows = [['Nama Lengkap', 'Nomor HP', CONSENT_HEADER]]
    const result = detectHeaderRow(rawRows)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.columnIndexByField.nickname).toBeUndefined()
  })
})

describe('extractDataRows', () => {
  it('junk+header-offset fixture: error at known Excel row N -> reported row# == N', () => {
    // Row layout (0-based array index -> Excel row):
    //  0 -> Excel row 1: junk totals row
    //  1 -> Excel row 2: header
    //  2 -> Excel row 3: data row 1
    //  3 -> Excel row 4: data row 2 (the one we assert on)
    const rawRows: unknown[][] = [
      [null, null, 55, 43],
      ['No', 'Nama Lengkap', 'Nomor HP', 'Nama Panggilan', CONSENT_HEADER],
      [1, 'Adhitya wilnanda', '081808247576', 'Adhit', 'Ya'],
      [2, 'Second Person', '081234567890', null, 'Tidak'],
    ]
    const headerResult = detectHeaderRow(rawRows)
    expect(headerResult.ok).toBe(true)
    if (!headerResult.ok) return

    const dataRows = extractDataRows(rawRows, headerResult.headerRowIndex, headerResult.columnIndexByField)
    expect(dataRows).toHaveLength(2)
    expect(dataRows[0].sourceRowNumber).toBe(3)
    expect(dataRows[1].sourceRowNumber).toBe(4)
    expect(dataRows[1].cellsByField.full_name).toBe('Second Person')
  })

  it('matches the real Absensi file offset exactly (header at index 1 -> first data row is Excel row 3)', () => {
    const rawRows: unknown[][] = [
      [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 55, 43, 57, 42, 48, 0, 0, 0, 0, 0, 0, 0, null],
      ['No', 'Nama Lengkap', 'Nama Panggilan', 'Nomor HP', 'Kepanitiaan', 'Tribe', 'Tempat Lahir', 'Tanggal Lahir', 'Usia', 'Asal Paroki', 'Status Pernikahan', 'Tanggal Wedding Anniversary', 'Nama Pasangan', 'Apakah memiliki Anak?', 'Nama & Tanggal Lahir Anak', CONSENT_HEADER],
      [1, 'Adhitya wilnanda', 'Adhit', '081808247576', null, null, null, null, null, null, null, null, null, null, null, 'Ya'],
    ]
    const headerResult = detectHeaderRow(rawRows)
    expect(headerResult.ok).toBe(true)
    if (!headerResult.ok) return
    const dataRows = extractDataRows(rawRows, headerResult.headerRowIndex, headerResult.columnIndexByField)
    expect(dataRows[0].sourceRowNumber).toBe(3)
  })

  it('skips fully-empty trailing rows (no spurious error rows)', () => {
    const rawRows: unknown[][] = [
      ['Nama Lengkap', 'Nomor HP', CONSENT_HEADER],
      ['A Name', '081234567890', 'Ya'],
      [null, null, null],
      ['', '', ''],
    ]
    const headerResult = detectHeaderRow(rawRows)
    expect(headerResult.ok).toBe(true)
    if (!headerResult.ok) return
    const dataRows = extractDataRows(rawRows, headerResult.headerRowIndex, headerResult.columnIndexByField)
    expect(dataRows).toHaveLength(1)
  })
})
