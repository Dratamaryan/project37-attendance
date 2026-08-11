// Orchestrates the shared import engine for mode=commit: parse -> normalize
// -> lookup -> classify -> insert -> audit. Mirrors dry-run.impl.ts's shape
// exactly and reuses columns/normalize/classify/lookup verbatim. NEVER trusts
// a dry-run result sent from the client -- the DB may have changed since the
// dry run, so this re-parses and re-classifies the re-uploaded file
// statelessly, same as the dry-run path.

import { randomUUID } from 'node:crypto'
import * as XLSX from 'xlsx'
import type { SupabaseClient } from '@supabase/supabase-js'

import { AUDIT_ACTIONS, logAudit } from '../audit'
import { selectSheet, detectHeaderRow, extractDataRows } from './columns'
import { normalizeRow } from './normalize'
import { classifyRows, tallyClassificationCounts } from './classify'
import { fetchExistingPhonesByE164 } from './lookup'
import type { ClassificationCounts, ClassifiedRow } from './types'

export interface CommitResult {
  filename: string
  classificationCounts: ClassificationCounts
  attempted: number
  inserted: number
  raced: number
  skippedDup: number
  skippedError: number
}

export interface RunImportCommitInput {
  fileBuffer: Buffer
  filename: string
  actorUserId: string
  ipAddress: string | null
  userAgent: string | null
}

export type RunImportCommitResult =
  | { ok: true; result: CommitResult; importId: string }
  | { ok: false; error: 'parse_failed'; message: string }
  | { ok: false; error: 'sheet_not_found'; availableSheets: string[] }
  | { ok: false; error: 'missing_required_columns'; missingFields: string[] }

/** One field per real `people` column the import engine populates. Built
 *  directly off the live information_schema audit (T8 schema gates) -- do
 *  not add a key here that isn't a real column; a phantom key fails the
 *  WHOLE batch, not just one row. id/created_at/updated_at have DB defaults
 *  and are intentionally omitted. photo_consent_state and
 *  photo_publish_consent are written EXPLICITLY (S6-T5a) -- NOT left to their
 *  DB defaults ('unknown'/false) -- because the import is the only place that
 *  carries the roster's actual consent answer; relying on the default here
 *  would silently collapse every 'granted'/'refused' row to 'unknown'/false. */
function toInsertPayload(row: ClassifiedRow) {
  const data = row.data
  return {
    phone_e164: data.phone_e164 as string,
    full_name: data.full_name as string,
    nickname: data.nickname as string,
    birth_place: data.birth_place,
    birth_date: data.birth_date,
    gender: data.gender,
    origin_parish: data.origin_parish,
    marital_status: data.marital_status,
    kepanitiaan: data.kepanitiaan,
    tribe: data.tribe,
    photo_consent_state: data.photo_consent_state,
    photo_publish_consent: data.photo_publish_consent,
  }
}

/** The only DB-writing step. Split out from runImportCommit so it's directly
 *  integration-testable against a real DB without needing a full workbook --
 *  the ON CONFLICT DO NOTHING / RETURNING semantics of ignoreDuplicates:true
 *  can only be proven against real Postgres, never a mock. */
export async function insertNewPeople(
  supabase: SupabaseClient,
  rows: ClassifiedRow[],
): Promise<{ insertedIds: string[] }> {
  if (rows.length === 0) return { insertedIds: [] }

  const payload = rows.map(toInsertPayload)

  const { data, error } = await supabase
    .from('people')
    .upsert(payload, { onConflict: 'phone_e164', ignoreDuplicates: true })
    .select('id')

  if (error) throw error

  return { insertedIds: (data ?? []).map((r) => r.id as string) }
}

export async function runImportCommit(
  input: RunImportCommitInput,
  supabase: SupabaseClient,
): Promise<RunImportCommitResult> {
  let workbook: XLSX.WorkBook
  try {
    workbook = XLSX.read(input.fileBuffer, { type: 'buffer', cellDates: true })
  } catch (err) {
    return { ok: false, error: 'parse_failed', message: err instanceof Error ? err.message : String(err) }
  }

  const sheetResult = selectSheet(workbook.SheetNames)
  if (!sheetResult.ok) {
    return { ok: false, error: 'sheet_not_found', availableSheets: sheetResult.availableSheets }
  }

  const worksheet = workbook.Sheets[sheetResult.sheetName]
  const rawRows = XLSX.utils.sheet_to_json(worksheet, { header: 1, raw: true, defval: null }) as unknown[][]

  const headerResult = detectHeaderRow(rawRows)
  if (!headerResult.ok) {
    return { ok: false, error: 'missing_required_columns', missingFields: headerResult.missingFields }
  }

  const dataRows = extractDataRows(rawRows, headerResult.headerRowIndex, headerResult.columnIndexByField)
  const parsedRows = dataRows.map(normalizeRow)

  const uniquePhones = [...new Set(parsedRows.map((r) => r.phone_e164).filter((p): p is string => p !== null))]
  const existingPhones = await fetchExistingPhonesByE164(supabase, uniquePhones)

  const classified = classifyRows(parsedRows, existingPhones)
  const classificationCounts = tallyClassificationCounts(classified)

  const newRows = classified.filter((r) => r.rowClass === 'new')
  const { insertedIds } = await insertNewPeople(supabase, newRows)

  const attempted = classificationCounts.new
  const inserted = insertedIds.length
  const raced = attempted - inserted
  const skippedDup = classificationCounts.dup_in_db + classificationCounts.dup_in_file + classificationCounts.dup_soft_deleted
  const skippedError = classificationCounts.error

  const importId = randomUUID()
  await logAudit(
    {
      actorUserId: input.actorUserId,
      action: AUDIT_ACTIONS.IMPORT_COMMIT,
      entityType: 'import',
      entityId: importId,
      detailsJson: {
        filename: input.filename,
        classification_counts: classificationCounts,
        attempted,
        inserted,
        raced,
        skipped_dup: skippedDup,
        skipped_error: skippedError,
        inserted_ids: insertedIds, // deviation from "counts only" spec: kept intentionally for rollback/provenance on the first bulk prod write
      },
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    },
    supabase,
  )

  return {
    ok: true,
    importId,
    result: {
      filename: input.filename,
      classificationCounts,
      attempted,
      inserted,
      raced,
      skippedDup,
      skippedError,
    },
  }
}
