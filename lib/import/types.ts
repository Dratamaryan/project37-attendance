// Shared types for the import dry-run/commit engine. T8's commit path reuses
// every type here verbatim — do not fork a parallel set of types for commit.

export type RowClass = 'new' | 'dup_in_db' | 'dup_in_file' | 'dup_soft_deleted' | 'error'

export type RowErrorReason = 'missing_phone' | 'invalid_phone' | 'missing_full_name'

/** One column-mapping entry. `headerAliases` starts with the Absensi header;
 *  future PEMBARUAN aliases append to this array without restructuring. */
export interface ColumnMapping {
  target: RawFieldKey
  headerAliases: string[]
  required: boolean
}

export type RawFieldKey =
  | 'full_name'
  | 'nickname'
  | 'phone_raw'
  | 'kepanitiaan'
  | 'tribe'
  | 'birth_place'
  | 'birth_date_raw'
  | 'origin_parish'
  | 'marital_status_raw'
  | 'gender_raw'
  | 'photo_consent_raw'

/** One physical spreadsheet row, still holding raw cell values keyed by
 *  RawFieldKey, plus the 1-based Excel row number it came from. */
export interface RawDataRow {
  sourceRowNumber: number
  cellsByField: Partial<Record<RawFieldKey, unknown>>
}

/** Output of normalizeRow(): every field coerced/mapped, with per-field
 *  warnings for best-effort fields that failed to coerce (never fatal). */
export interface ParsedPersonRow {
  sourceRowNumber: number
  phone_e164: string | null
  phone_error: string | null
  full_name: string | null
  nickname: string | null
  nicknameFallbackApplied: boolean
  birth_place: string | null
  birth_date: string | null // ISO yyyy-mm-dd
  gender: 'male' | 'female' | null
  origin_parish: string | null
  marital_status: 'married' | 'single' | null
  kepanitiaan: string | null
  tribe: string | null
  photo_consent_state: 'granted' | 'refused' | 'unknown'
  photo_publish_consent: boolean
  warnings: string[]
}

/** Final per-row classification result. Flattens the fields T8's error CSV
 *  needs (row #, phone, name, reason) to the top level; `data` carries the
 *  full normalized record for T8's preview table. */
export interface ClassifiedRow {
  sourceRowNumber: number
  rowClass: RowClass
  phone_e164: string | null
  full_name: string | null
  nickname: string | null
  reason: RowErrorReason | null
  warnings: string[]
  matchedPersonId: string | null
  data: ParsedPersonRow
}

export type ClassificationCounts = Record<RowClass, number>

export interface DryRunResult {
  filename: string
  totalRows: number
  classificationCounts: ClassificationCounts
  rows: ClassifiedRow[]
}

export function emptyClassificationCounts(): ClassificationCounts {
  return { new: 0, dup_in_db: 0, dup_in_file: 0, dup_soft_deleted: 0, error: 0 }
}
