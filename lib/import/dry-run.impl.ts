// Orchestrates the shared import engine for mode=dry_run: parse -> normalize
// -> lookup -> classify -> audit. T8's commit.impl.ts mirrors this shape,
// reusing columns/normalize/classify/lookup verbatim and adding the actual
// people INSERT after classify. No 'use server' — imported by the route
// handler and by integration tests directly (impl_* / route split pattern).

import { randomUUID } from 'node:crypto'
import * as XLSX from 'xlsx'
import type { SupabaseClient } from '@supabase/supabase-js'

import { AUDIT_ACTIONS, logAudit } from '../audit'
import { selectSheet, detectHeaderRow, extractDataRows } from './columns'
import { normalizeRow } from './normalize'
import { classifyRows, tallyClassificationCounts } from './classify'
import { fetchExistingPhonesByE164 } from './lookup'
import type { DryRunResult } from './types'

export interface RunImportDryRunInput {
  fileBuffer: Buffer
  filename: string
  actorUserId: string
  ipAddress: string | null
  userAgent: string | null
}

export type RunImportDryRunResult =
  | { ok: true; result: DryRunResult; importId: string }
  | { ok: false; error: 'parse_failed'; message: string }
  | { ok: false; error: 'sheet_not_found'; availableSheets: string[] }
  | { ok: false; error: 'missing_required_columns'; missingFields: string[] }

export async function runImportDryRun(
  input: RunImportDryRunInput,
  supabase: SupabaseClient,
): Promise<RunImportDryRunResult> {
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

  const importId = randomUUID()
  await logAudit(
    {
      actorUserId: input.actorUserId,
      action: AUDIT_ACTIONS.IMPORT_DRY_RUN,
      entityType: 'import',
      entityId: importId,
      detailsJson: { filename: input.filename, classification_counts: classificationCounts },
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
      totalRows: classified.length,
      classificationCounts,
      rows: classified,
    },
  }
}
