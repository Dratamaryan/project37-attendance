// Pure functions for the T2 roster birth-date repair (G/1-G/5, G/3a). No I/O.
// Lives under scripts/, not lib/import/ — this is one-off roster-repair logic
// per G/2 and must never be imported by the import engine.

import * as XLSX from 'xlsx'

export interface DateParts {
  y: number
  m: number
  d: number
}

export type CellType = 'pre-converted' | 'text' | 'raw-serial' | 'blank'

export function classifyAbsensiCell(raw: unknown): CellType {
  if (raw === null || raw === undefined || raw === '') return 'blank'
  if (raw instanceof Date) return 'pre-converted'
  if (typeof raw === 'number') return 'raw-serial'
  return 'text'
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** Handles the three source encodings (Date object, raw Excel serial, M/D/YYYY
 *  text). Text is always parsed month-first per G/3 ("these are provably
 *  month-first"). Never throws — unparseable input returns null parts. */
export function coerceDateParts(raw: unknown): { parts: DateParts | null; kind: string } {
  if (raw === null || raw === undefined || raw === '') return { parts: null, kind: 'blank' }

  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return { parts: null, kind: 'unparseable' }
    return { parts: { y: raw.getUTCFullYear(), m: raw.getUTCMonth() + 1, d: raw.getUTCDate() }, kind: 'date-object' }
  }

  if (typeof raw === 'number') {
    const code = XLSX.SSF.parse_date_code(raw)
    if (!code) return { parts: null, kind: 'unparseable' }
    return { parts: { y: code.y, m: code.m, d: code.d }, kind: 'raw-serial' }
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    const match = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(trimmed)
    if (!match) return { parts: null, kind: 'unparseable-string' }
    const month = Number(match[1])
    const day = Number(match[2])
    let year = Number(match[3])
    if (year < 100) year += 2000
    if (month < 1 || month > 12 || day < 1 || day > 31) return { parts: null, kind: 'out-of-range-string' }
    return { parts: { y: year, m: month, d: day }, kind: 'text-string' }
  }

  return { parts: null, kind: 'unparseable-type' }
}

export function formatDateParts(p: DateParts | null): string | null {
  if (!p) return null
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`
}

export interface FormSubmission {
  parts: DateParts | null
  timestamp: Date | null
}

export interface ModeSelectionResult {
  chosen: DateParts | null
  discarded: number
  totalSubs: number
  genuinelyUnresolved: boolean
  voteCounts: Map<string, number>
}

/** G/3a: most-frequently-submitted birth_date wins; mode-tie broken by latest
 *  timestamp. Guard (this session's refinement over the locked doc's literal
 *  wording — see memory/feedback_collab.md "Sprint 4 Task 2" entry and the
 *  T2 plan-review reconciliation): a submission is discarded if its birth
 *  year is >= the year IT was submitted in (nobody's birth year can be the
 *  same as or after their own submission year) — re-run-safe, not pinned to
 *  2026. Submissions with no timestamp fall back to `runtimeYear` as the
 *  ceiling, since there's no submission-year anchor to check against.
 *  `genuinelyUnresolved` is true only when the vote-count tie ALSO survives
 *  the latest-timestamp break (e.g. identical or all-missing timestamps
 *  among the tied leaders) — an ordinary count-tie that the timestamp
 *  break resolves is NOT unresolved. */
export function selectModeWinner(submissions: FormSubmission[], runtimeYear: number): ModeSelectionResult {
  const valid = submissions.filter((s) => {
    if (!s.parts) return false
    const ceilingYear = s.timestamp ? s.timestamp.getUTCFullYear() : runtimeYear
    return s.parts.y < ceilingYear
  })
  const discarded = submissions.length - valid.length

  const votes = new Map<string, { count: number; parts: DateParts; latestTs: number }>()
  for (const s of valid) {
    const key = formatDateParts(s.parts)!
    const ts = s.timestamp ? s.timestamp.getTime() : -Infinity
    const existing = votes.get(key)
    if (existing) {
      existing.count++
      if (ts > existing.latestTs) existing.latestTs = ts
    } else {
      votes.set(key, { count: 1, parts: s.parts!, latestTs: ts })
    }
  }

  const voteCounts = new Map<string, number>()
  for (const [k, v] of votes) voteCounts.set(k, v.count)

  if (votes.size === 0) {
    return { chosen: null, discarded, totalSubs: submissions.length, genuinelyUnresolved: false, voteCounts }
  }

  let maxCount = 0
  for (const v of votes.values()) maxCount = Math.max(maxCount, v.count)
  const winners = [...votes.entries()].filter(([, v]) => v.count === maxCount)

  let maxTs = -Infinity
  for (const w of winners) maxTs = Math.max(maxTs, w[1].latestTs)
  const tsWinners = winners.filter((w) => w[1].latestTs === maxTs)

  const genuinelyUnresolved = winners.length > 1 && tsWinners.length > 1
  const best = tsWinners[0]

  return { chosen: best[1].parts, discarded, totalSubs: submissions.length, genuinelyUnresolved, voteCounts }
}

export type Decision = 'kept' | 'corrected' | 'null'

/** How the final value relates to the ORIGINAL Absensi cell — diagnostic
 *  only, does not affect `decision`. 'transposed' = a clean day/month swap. */
export type Agreement = 'exact' | 'transposed' | 'mismatch' | 'n/a'

export function classifyAgreement(finalParts: DateParts | null, absensiParts: DateParts | null): Agreement {
  if (!finalParts || !absensiParts) return 'n/a'
  if (finalParts.y === absensiParts.y && finalParts.m === absensiParts.m && finalParts.d === absensiParts.d) return 'exact'
  if (finalParts.y === absensiParts.y && finalParts.m === absensiParts.d && finalParts.d === absensiParts.m) return 'transposed'
  return 'mismatch'
}

export interface PrecedenceInput {
  absensiCellType: CellType
  absensiParts: DateParts | null
  hasFormMatch: boolean
  formSubmissions: FormSubmission[]
  runtimeYear: number
}

export interface PrecedenceResult {
  decision: Decision
  finalParts: DateParts | null
  ruleApplied: string
  flags: string[]
  modeResult: ModeSelectionResult | null
}

/** G/3 precedence resolver, extended per the T2 plan-review reconciliation:
 *  a phone match whose every submission gets guarded away (all-discarded, or
 *  a genuine mode-tie) is treated like "no match" for the cell-type fallback,
 *  and ANY final candidate (form-derived or Absensi-derived) carrying an
 *  impossible year is nulled rather than written — G/3's own "NULL beats a
 *  coin-flip" principle, generalized to the cases the locked table's binary
 *  has-match/no-match framing didn't anticipate. */
export function resolvePrecedence(input: PrecedenceInput): PrecedenceResult {
  const { absensiCellType, absensiParts, hasFormMatch, formSubmissions, runtimeYear } = input
  const flags: string[] = []

  if (hasFormMatch) {
    const modeResult = selectModeWinner(formSubmissions, runtimeYear)

    if (modeResult.chosen === null) {
      flags.push('impossible_final_year')
      return { decision: 'null', finalParts: null, ruleApplied: 'null-all-submissions-guarded', flags, modeResult }
    }
    if (modeResult.genuinelyUnresolved) {
      flags.push('mode_tie_unresolved')
      return { decision: 'null', finalParts: null, ruleApplied: 'null-mode-tie-unresolved', flags, modeResult }
    }
    if (modeResult.chosen.y >= runtimeYear) {
      flags.push('impossible_final_year')
      return { decision: 'null', finalParts: null, ruleApplied: 'null-impossible-final-year', flags, modeResult }
    }

    if (modeResult.voteCounts.size > 1) flags.push('multi_submission_conflict')
    if (absensiParts && modeResult.chosen.y !== absensiParts.y) flags.push('year_mismatch')
    const agreement = classifyAgreement(modeResult.chosen, absensiParts)
    if (agreement === 'mismatch') flags.push('absensi_mismatch_form_authoritative')

    return { decision: 'corrected', finalParts: modeResult.chosen, ruleApplied: 'form-verbatim-mode-wins', flags, modeResult }
  }

  flags.push('no_form_match')

  if (absensiCellType === 'text') {
    if (!absensiParts) return { decision: 'null', finalParts: null, ruleApplied: 'null-unparseable-text', flags, modeResult: null }
    if (absensiParts.y >= runtimeYear) {
      flags.push('impossible_final_year')
      return { decision: 'null', finalParts: null, ruleApplied: 'null-impossible-final-year', flags, modeResult: null }
    }
    return { decision: 'kept', finalParts: absensiParts, ruleApplied: 'text-parsed-month-first', flags, modeResult: null }
  }

  // pre-converted or raw-serial, no match: day > 12 -> keep as parsed; day <= 12 -> NULL
  if (absensiCellType === 'raw-serial') flags.push('raw_serial_coerced')

  if (!absensiParts) return { decision: 'null', finalParts: null, ruleApplied: 'null-unparseable', flags, modeResult: null }

  if (absensiParts.d > 12) {
    if (absensiParts.y >= runtimeYear) {
      flags.push('impossible_final_year')
      return { decision: 'null', finalParts: null, ruleApplied: 'null-impossible-final-year', flags, modeResult: null }
    }
    return { decision: 'kept', finalParts: absensiParts, ruleApplied: 'preconverted-keep-day-gt12', flags, modeResult: null }
  }

  return { decision: 'null', finalParts: null, ruleApplied: 'null-ambiguous-no-match', flags, modeResult: null }
}
