// PURE classification: (parsed rows + existing-phone map) -> ClassifiedRow[].
// No supabase import anywhere in this file — the existing-phone lookup is
// injected as a plain Map so this unit-tests with plain arrays. T8's commit
// path calls this verbatim after re-parsing + re-normalizing statelessly.

import type { ClassificationCounts, ClassifiedRow, ParsedPersonRow, RowErrorReason } from './types'
import { emptyClassificationCounts } from './types'

export interface ExistingPhoneRecord {
  id: string
  deletedAt: string | null
}

function hardRequiredError(row: ParsedPersonRow): RowErrorReason | null {
  if (row.phone_error !== null) {
    return row.phone_error === 'empty' ? 'missing_phone' : 'invalid_phone'
  }
  if (row.full_name === null) return 'missing_full_name'
  // nickname is not independently checked: once full_name passes, the
  // fallback in normalizeRow guarantees nickname is non-blank by
  // construction — a standalone 'missing_nickname' error is unreachable.
  return null
}

/** Dedup semantics (highest-risk logic in the import engine):
 *  - A match against `existingPhones` is checked per-row, position-agnostic.
 *    A soft-deleted match -> EVERY occurrence of that phone in the file is
 *    'dup_soft_deleted' (none of them are being created; there is no
 *    "first wins" concept for a DB match, unlike file-internal dedup).
 *  - An active DB match -> EVERY occurrence is 'dup_in_db', same reasoning.
 *  - Only phones with NO DB match are file-order-dependent: first occurrence
 *    in file order -> 'new', subsequent occurrences -> 'dup_in_file'. */
export function classifyRows(
  rows: ParsedPersonRow[],
  existingPhones: Map<string, ExistingPhoneRecord>,
): ClassifiedRow[] {
  const seenInFile = new Set<string>()
  const result: ClassifiedRow[] = []

  for (const row of rows) {
    const errorReason = hardRequiredError(row)

    if (errorReason) {
      result.push({
        sourceRowNumber: row.sourceRowNumber,
        rowClass: 'error',
        phone_e164: row.phone_e164,
        full_name: row.full_name,
        nickname: row.nickname,
        reason: errorReason,
        warnings: row.warnings,
        matchedPersonId: null,
        data: row,
      })
      continue
    }

    // Hard-required check passed -> phone_e164 is guaranteed non-null here.
    const phone = row.phone_e164 as string
    const existing = existingPhones.get(phone)

    if (existing) {
      result.push({
        sourceRowNumber: row.sourceRowNumber,
        rowClass: existing.deletedAt !== null ? 'dup_soft_deleted' : 'dup_in_db',
        phone_e164: row.phone_e164,
        full_name: row.full_name,
        nickname: row.nickname,
        reason: null,
        warnings: row.warnings,
        matchedPersonId: existing.id,
        data: row,
      })
      continue
    }

    const isDupInFile = seenInFile.has(phone)
    if (!isDupInFile) seenInFile.add(phone)

    result.push({
      sourceRowNumber: row.sourceRowNumber,
      rowClass: isDupInFile ? 'dup_in_file' : 'new',
      phone_e164: row.phone_e164,
      full_name: row.full_name,
      nickname: row.nickname,
      reason: null,
      warnings: row.warnings,
      matchedPersonId: null,
      data: row,
    })
  }

  return result
}

export function tallyClassificationCounts(rows: ClassifiedRow[]): ClassificationCounts {
  const counts = emptyClassificationCounts()
  for (const row of rows) counts[row.rowClass]++
  return counts
}
