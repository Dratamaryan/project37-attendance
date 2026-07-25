// Sprint 4 T2 — one-off roster birth-date repair (G/1-G/5, G/3a). Data tooling,
// not app code: reads the legacy roster xlsx, cross-references the Google Form
// sheet by phone, and emits a corrected copy + reconciliation CSV. No database
// access. Never mutates the input file.
//
// RUNTIME WARNING — do not run this with `tsx`. `normalizePhone` (via
// libphonenumber-js's `/min` subpath) FAILS SILENT under tsx/esbuild's ESM
// loader: it returns `invalid_for_country` for every valid phone number, with
// no thrown error, no crash — every phone match would silently fail and every
// row would fall through to the "no match" branch, corrupting the output with
// no signal anything went wrong. Root cause + full writeup:
// memory/feedback_collab.md, "Sprint 4 Task 2 — normalizePhone fails SILENT
// under tsx/node's ESM loader".
//
// Run it like this (compile to CommonJS, execute with plain node):
//   npx tsc -p scripts/tsconfig.repair.json
//   node scripts/.build/repair-roster-birthdates.js
//
// The script also self-asserts a known-good phone number at startup and
// hard-exits before touching the input file if normalizePhone misbehaves —
// see assertPhoneUtilTrustworthy() below. That assertion is the backstop;
// the correct invocation above is still required.

import * as XLSX from 'xlsx'
import fs from 'node:fs'
import path from 'node:path'
import { normalizePhone } from '../lib/utils/phone'
import {
  classifyAbsensiCell,
  coerceDateParts,
  formatDateParts,
  resolvePrecedence,
  type CellType,
  type FormSubmission,
} from './lib/repair-rules'

// Resolved relative to process.cwd() (run from the repo root), not __dirname —
// __dirname's location depends on where tsc emits the compiled output and
// shouldn't affect where the script looks for repo-relative data files.
const INPUT_PATH = path.resolve(process.cwd(), 'docs/data-samples/legacy-roster-sample.xlsx')
const OUTPUT_DIR = path.resolve(process.cwd(), 'docs/data-samples/roster-repair')
const OUTPUT_XLSX_PATH = path.join(OUTPUT_DIR, 'legacy-roster-corrected.xlsx')
const OUTPUT_CSV_PATH = path.join(OUTPUT_DIR, 'birthdate-reconciliation.csv')

const RUNTIME_YEAR = new Date().getFullYear()

// Absensi sheet layout (header row = Excel row 2, data starts Excel row 3).
const ABSENSI_DATA_START = 2 // 0-indexed
const COL_NAME = 1
const COL_PHONE = 3
const COL_BIRTH_DATE = 7

// Form responses 1 sheet layout (header row = Excel row 1, data starts row 2).
const FORM_DATA_START = 1 // 0-indexed
const FORM_COL_TIMESTAMP = 0
const FORM_COL_NAME_1 = 3
const FORM_COL_BIRTH_1 = 5
const FORM_COL_PHONE_1 = 6
const FORM_COL_NAME_2 = 8
const FORM_COL_BIRTH_2 = 9
const FORM_COL_PHONE_2 = 10

/** Hard-fails before any file I/O if normalizePhone is misbehaving under the
 *  current runtime (see the file-header warning). Known-good pair confirmed
 *  live against the real roster during T2 planning. */
function assertPhoneUtilTrustworthy(): void {
  const KNOWN_PHONE = '081808247576'
  const EXPECTED_E164 = '+6281808247576'
  const result = normalizePhone(KNOWN_PHONE, 'ID')
  if (!result.ok || result.e164 !== EXPECTED_E164) {
    console.error(
      `[repair-roster-birthdates] FATAL: normalizePhone('${KNOWN_PHONE}', 'ID') returned ` +
        `${JSON.stringify(result)}, expected { ok: true, e164: '${EXPECTED_E164}' }. ` +
        `This runtime cannot be trusted for phone matching (likely running under tsx — ` +
        `see the RUNTIME WARNING at the top of this file). Refusing to read or write any file.`,
    )
    process.exit(1)
  }
}

function excelCell(sheet: XLSX.WorkSheet, r: number, c: number): unknown {
  const cell = sheet[XLSX.utils.encode_cell({ r, c })]
  return cell ? cell.v : null
}

function normalizeOrNull(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  const str = String(raw).trim()
  if (!str) return null
  const result = normalizePhone(str, 'ID')
  return result.ok ? result.e164 : null
}

interface FormEntry extends FormSubmission {
  name: string | null
}

function buildPhoneSubmissionsMap(form: XLSX.WorkSheet): Map<string, FormEntry[]> {
  const range = XLSX.utils.decode_range(form['!ref']!)
  const map = new Map<string, FormEntry[]>()

  for (let r = FORM_DATA_START; r <= range.e.r; r++) {
    const hasAnyContent = Array.from({ length: 16 }, (_, c) => excelCell(form, r, c)).some(
      (v) => v !== null && v !== undefined && v !== '',
    )
    if (!hasAnyContent) continue

    const timestampRaw = excelCell(form, r, FORM_COL_TIMESTAMP)
    const timestamp = timestampRaw instanceof Date ? timestampRaw : null

    const pairs: Array<{ phoneCol: number; dateCol: number; nameCol: number }> = [
      { phoneCol: FORM_COL_PHONE_1, dateCol: FORM_COL_BIRTH_1, nameCol: FORM_COL_NAME_1 },
      { phoneCol: FORM_COL_PHONE_2, dateCol: FORM_COL_BIRTH_2, nameCol: FORM_COL_NAME_2 },
    ]

    for (const pair of pairs) {
      const phoneE164 = normalizeOrNull(excelCell(form, r, pair.phoneCol))
      if (!phoneE164) continue
      const { parts } = coerceDateParts(excelCell(form, r, pair.dateCol))
      const nameRaw = excelCell(form, r, pair.nameCol)
      const name = nameRaw !== null && nameRaw !== undefined && String(nameRaw).trim() !== '' ? String(nameRaw).trim() : null

      const list = map.get(phoneE164) ?? []
      list.push({ parts, timestamp, name })
      map.set(phoneE164, list)
    }
  }

  return map
}

interface ReconciliationRow {
  source_row_number: number
  normalized_phone: string
  absensi_raw_cell: string
  absensi_cell_type: CellType
  form_value_chosen: string
  form_timestamp: string
  n_form_submissions: number
  n_distinct_birthdates: number
  rule_applied: string
  decision: 'kept' | 'corrected' | 'null'
  flags: string
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

function rowsToCsv(rows: ReconciliationRow[]): string {
  const headers: (keyof ReconciliationRow)[] = [
    'source_row_number',
    'normalized_phone',
    'absensi_raw_cell',
    'absensi_cell_type',
    'form_value_chosen',
    'form_timestamp',
    'n_form_submissions',
    'n_distinct_birthdates',
    'rule_applied',
    'decision',
    'flags',
  ]
  const lines = [headers.join(',')]
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(String(row[h]))).join(','))
  }
  return lines.join('\n')
}

function absensiRawCellDisplay(raw: unknown): string {
  if (raw === null || raw === undefined) return ''
  if (raw instanceof Date) return raw.toISOString().slice(0, 10)
  return String(raw)
}

function main(): void {
  assertPhoneUtilTrustworthy()

  console.log(`[repair-roster-birthdates] reading ${INPUT_PATH}`)
  const inputBuf = fs.readFileSync(INPUT_PATH)
  const workbook = XLSX.read(inputBuf, { type: 'buffer', cellDates: true })

  const absensi = workbook.Sheets['Absensi']
  const form = workbook.Sheets['Form responses 1']
  if (!absensi || !form) {
    console.error('[repair-roster-birthdates] FATAL: expected sheets "Absensi" and "Form responses 1" not found.')
    process.exit(1)
  }

  const submissionsByPhone = buildPhoneSubmissionsMap(form)

  const absensiRange = XLSX.utils.decode_range(absensi['!ref']!)
  const reconciliation: ReconciliationRow[] = []

  let nKept = 0
  let nCorrected = 0
  let nNulled = 0

  for (let r = ABSENSI_DATA_START; r <= absensiRange.e.r; r++) {
    const nameRaw = excelCell(absensi, r, COL_NAME)
    if (nameRaw === null || nameRaw === undefined || String(nameRaw).trim() === '') continue // trailer/blank rows

    const excelRowNumber = r + 1
    const phoneRaw = excelCell(absensi, r, COL_PHONE)
    const birthDateRaw = excelCell(absensi, r, COL_BIRTH_DATE)

    const phoneE164 = normalizeOrNull(phoneRaw)
    const absensiCellType = classifyAbsensiCell(birthDateRaw)
    const { parts: absensiParts } = coerceDateParts(birthDateRaw)

    const formSubmissions: FormEntry[] = phoneE164 ? (submissionsByPhone.get(phoneE164) ?? []) : []
    const hasFormMatch = phoneE164 !== null && formSubmissions.length > 0

    const result = resolvePrecedence({
      absensiCellType,
      absensiParts,
      hasFormMatch,
      formSubmissions,
      runtimeYear: RUNTIME_YEAR,
    })

    // Write the resolved value back into the workbook (in memory only).
    const cellAddr = XLSX.utils.encode_cell({ r, c: COL_BIRTH_DATE })
    if (result.finalParts) {
      absensi[cellAddr] = {
        t: 'd',
        v: new Date(Date.UTC(result.finalParts.y, result.finalParts.m - 1, result.finalParts.d)),
        z: 'yyyy-mm-dd',
      }
    } else {
      delete absensi[cellAddr]
    }

    if (result.decision === 'kept') nKept++
    else if (result.decision === 'corrected') nCorrected++
    else nNulled++

    const distinctBirthdates = new Set(formSubmissions.map((s) => formatDateParts(s.parts)).filter((v): v is string => v !== null))
    const latestSubmissionTimestamp = formSubmissions
      .map((s) => s.timestamp)
      .filter((t): t is Date => t !== null)
      .sort((a, b) => b.getTime() - a.getTime())[0]

    reconciliation.push({
      source_row_number: excelRowNumber,
      normalized_phone: phoneE164 ?? '',
      absensi_raw_cell: absensiRawCellDisplay(birthDateRaw),
      absensi_cell_type: absensiCellType,
      form_value_chosen: formatDateParts(result.finalParts) ?? '',
      form_timestamp: latestSubmissionTimestamp ? latestSubmissionTimestamp.toISOString().slice(0, 10) : '',
      n_form_submissions: formSubmissions.length,
      n_distinct_birthdates: distinctBirthdates.size,
      rule_applied: result.ruleApplied,
      decision: result.decision,
      flags: result.flags.join(';'),
    })
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  const outputBuf = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', cellDates: true })
  fs.writeFileSync(OUTPUT_XLSX_PATH, outputBuf)
  console.log(`[repair-roster-birthdates] wrote ${OUTPUT_XLSX_PATH}`)

  fs.writeFileSync(OUTPUT_CSV_PATH, rowsToCsv(reconciliation))
  console.log(`[repair-roster-birthdates] wrote ${OUTPUT_CSV_PATH}`)

  const followUp = reconciliation.filter((r) => r.decision === 'null')
  console.log('[repair-roster-birthdates] summary:')
  console.log(`  total rows: ${reconciliation.length}`)
  console.log(`  kept: ${nKept}`)
  console.log(`  corrected: ${nCorrected}`)
  console.log(`  null (human follow-up): ${nNulled}`)
  console.log(`  follow-up rows: ${followUp.map((r) => r.source_row_number).join(', ')}`)
}

main()
