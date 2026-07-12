// Column-mapping config + header detection + row extraction.
// No supabase, no SheetJS parsing here — this module operates on plain
// arrays-of-arrays (the shape `XLSX.utils.sheet_to_json(ws, { header: 1 })`
// produces), so it is unit-testable without a real workbook.

import type { ColumnMapping, RawDataRow, RawFieldKey } from './types'

/** Primary import target per the Sprint 6 import plan — the roster sheet.
 *  Sheet1/"Form responses 1" is transactional and must never be silently
 *  used as a substitute (wrong shape entirely). */
export const TARGET_SHEET_NAME = 'Absensi'

/** How many leading rows to scan for the header. The real Absensi sheet has
 *  one junk/totals row above the header; this gives headroom for a stray
 *  title row or two without false-negatives on well-formed files. */
const HEADER_SCAN_ROWS = 10

// Absensi headers as the primary target. headerAliases is an array so
// PEMBARUAN aliases can be appended later without restructuring this config.
export const COLUMN_MAPPINGS: ColumnMapping[] = [
  { target: 'full_name',          headerAliases: ['Nama Lengkap'],        required: true },
  { target: 'nickname',           headerAliases: ['Nama Panggilan'],      required: false },
  { target: 'phone_raw',          headerAliases: ['Nomor HP'],            required: true },
  { target: 'kepanitiaan',        headerAliases: ['Kepanitiaan'],         required: false },
  { target: 'tribe',              headerAliases: ['Tribe'],               required: false },
  { target: 'birth_place',        headerAliases: ['Tempat Lahir'],        required: false },
  { target: 'birth_date_raw',     headerAliases: ['Tanggal Lahir'],       required: false },
  { target: 'origin_parish',      headerAliases: ['Asal Paroki'],         required: false },
  { target: 'marital_status_raw', headerAliases: ['Status Pernikahan'],   required: false },
  { target: 'gender_raw',         headerAliases: ['Jenis Kelamin'],       required: false },
]

export type SelectSheetResult =
  | { ok: true; sheetName: string }
  | { ok: false; error: 'sheet_not_found'; availableSheets: string[] }

/** Absensi-by-name for multi-sheet workbooks (.xlsx); the sole sheet for
 *  single-sheet workbooks (.csv always parses to exactly one sheet, whose
 *  name carries no meaning). Never falls back to "first sheet" when there
 *  are multiple — the real file's first sheet is a different, wrong shape. */
export function selectSheet(sheetNames: string[]): SelectSheetResult {
  if (sheetNames.length === 1) {
    return { ok: true, sheetName: sheetNames[0] }
  }
  if (sheetNames.includes(TARGET_SHEET_NAME)) {
    return { ok: true, sheetName: TARGET_SHEET_NAME }
  }
  return { ok: false, error: 'sheet_not_found', availableSheets: sheetNames }
}

function normalizeHeaderCell(cell: unknown): string {
  return String(cell ?? '').trim().toLowerCase()
}

export type DetectHeaderRowResult =
  | { ok: true; headerRowIndex: number; columnIndexByField: Partial<Record<RawFieldKey, number>> }
  | { ok: false; error: 'missing_required_columns'; missingFields: string[] }

/** Scans the first HEADER_SCAN_ROWS rows for the one that matches every
 *  required column mapping (case-insensitive, trimmed). Does not assume the
 *  header is row 0 — the real Absensi sheet has a junk totals row above it. */
export function detectHeaderRow(rawRows: unknown[][]): DetectHeaderRowResult {
  const requiredMappings = COLUMN_MAPPINGS.filter((m) => m.required)

  let bestColumnIndexByField: Partial<Record<RawFieldKey, number>> = {}
  let bestRequiredMatchCount = -1

  const scanLimit = Math.min(HEADER_SCAN_ROWS, rawRows.length)
  for (let rowIndex = 0; rowIndex < scanLimit; rowIndex++) {
    const row = rawRows[rowIndex]
    if (!row) continue

    const normalizedCells = row.map(normalizeHeaderCell)
    const columnIndexByField: Partial<Record<RawFieldKey, number>> = {}

    for (const mapping of COLUMN_MAPPINGS) {
      const aliasSet = new Set(mapping.headerAliases.map((a) => a.trim().toLowerCase()))
      const matchIndex = normalizedCells.findIndex((cell) => cell !== '' && aliasSet.has(cell))
      if (matchIndex >= 0) columnIndexByField[mapping.target] = matchIndex
    }

    const requiredMatchCount = requiredMappings.filter((m) => m.target in columnIndexByField).length

    if (requiredMatchCount > bestRequiredMatchCount) {
      bestRequiredMatchCount = requiredMatchCount
      bestColumnIndexByField = columnIndexByField
    }

    if (requiredMatchCount === requiredMappings.length) {
      return { ok: true, headerRowIndex: rowIndex, columnIndexByField }
    }
  }

  const missingFields = requiredMappings
    .filter((m) => !(m.target in bestColumnIndexByField))
    .map((m) => m.headerAliases[0])

  return { ok: false, error: 'missing_required_columns', missingFields }
}

/** Extracts data rows after the header, tagging each with its 1-based Excel
 *  row number (array index + 1 — true regardless of header position).
 *  Fully-empty rows (common trailing blanks in Excel exports) are skipped
 *  rather than emitted as spurious error rows. */
export function extractDataRows(
  rawRows: unknown[][],
  headerRowIndex: number,
  columnIndexByField: Partial<Record<RawFieldKey, number>>,
): RawDataRow[] {
  const result: RawDataRow[] = []

  for (let i = headerRowIndex + 1; i < rawRows.length; i++) {
    const row = rawRows[i]
    if (!row) continue

    const isEmpty = row.every((cell) => cell === null || cell === undefined || cell === '')
    if (isEmpty) continue

    const cellsByField: Partial<Record<RawFieldKey, unknown>> = {}
    for (const [field, colIndex] of Object.entries(columnIndexByField) as [RawFieldKey, number][]) {
      cellsByField[field] = row[colIndex] ?? null
    }

    result.push({ sourceRowNumber: i + 1, cellsByField })
  }

  return result
}
