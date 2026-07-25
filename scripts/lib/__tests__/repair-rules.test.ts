import { describe, it, expect } from 'vitest'
import {
  classifyAbsensiCell,
  coerceDateParts,
  formatDateParts,
  selectModeWinner,
  resolvePrecedence,
  classifyAgreement,
  type FormSubmission,
} from '../repair-rules'

describe('classifyAbsensiCell', () => {
  it('Date instance -> pre-converted', () => {
    expect(classifyAbsensiCell(new Date())).toBe('pre-converted')
  })
  it('number -> raw-serial', () => {
    expect(classifyAbsensiCell(35684)).toBe('raw-serial')
  })
  it('string -> text', () => {
    expect(classifyAbsensiCell('12/15/1986')).toBe('text')
  })
  it('null/undefined/empty -> blank', () => {
    expect(classifyAbsensiCell(null)).toBe('blank')
    expect(classifyAbsensiCell(undefined)).toBe('blank')
    expect(classifyAbsensiCell('')).toBe('blank')
  })
})

describe('coerceDateParts', () => {
  it('Date object -> UTC y/m/d', () => {
    const { parts } = coerceDateParts(new Date(Date.UTC(1986, 11, 15)))
    expect(parts).toEqual({ y: 1986, m: 12, d: 15 })
  })

  it('raw Excel serial 35684 -> 1997-09-11 (confirmed against real T1/T2 file)', () => {
    const { parts, kind } = coerceDateParts(35684)
    expect(parts).toEqual({ y: 1997, m: 9, d: 11 })
    expect(kind).toBe('raw-serial')
  })

  it('text M/D/YYYY parses month-first', () => {
    const { parts } = coerceDateParts('12/15/1986')
    expect(parts).toEqual({ y: 1986, m: 12, d: 15 })
  })

  it('text 2-digit year normalizes to 20xx', () => {
    const { parts } = coerceDateParts('6/25/25')
    expect(parts).toEqual({ y: 2025, m: 6, d: 25 })
  })

  it('text with month > 12 is out-of-range, not silently reinterpreted as day-first', () => {
    const { parts, kind } = coerceDateParts('25/6/2026')
    expect(parts).toBeNull()
    expect(kind).toBe('out-of-range-string')
  })

  it('blank -> null parts', () => {
    expect(coerceDateParts(null).parts).toBeNull()
    expect(coerceDateParts('').parts).toBeNull()
  })

  it('unparseable string -> null parts, not a throw', () => {
    expect(coerceDateParts('not a date').parts).toBeNull()
  })
})

describe('formatDateParts', () => {
  it('pads month/day to 2 digits', () => {
    expect(formatDateParts({ y: 1997, m: 9, d: 1 })).toBe('1997-09-01')
  })
  it('null -> null', () => {
    expect(formatDateParts(null)).toBeNull()
  })
})

describe('selectModeWinner — G/3a mode-wins with year-junk guard', () => {
  const RUNTIME_YEAR = 2026

  it('single submission wins trivially', () => {
    const subs: FormSubmission[] = [{ parts: { y: 1990, m: 1, d: 1 }, timestamp: new Date('2026-01-01') }]
    const result = selectModeWinner(subs, RUNTIME_YEAR)
    expect(result.chosen).toEqual({ y: 1990, m: 1, d: 1 })
    expect(result.discarded).toBe(0)
  })

  it('majority wins over a single outlier (T2 row 58 pattern: 4 vs 1)', () => {
    const subs: FormSubmission[] = [
      { parts: { y: 1985, m: 7, d: 1 }, timestamp: new Date('2026-01-06') },
      { parts: { y: 1988, m: 7, d: 1 }, timestamp: new Date('2026-02-02') },
      { parts: { y: 1988, m: 7, d: 1 }, timestamp: new Date('2026-03-01') },
      { parts: { y: 1988, m: 7, d: 1 }, timestamp: new Date('2026-04-03') },
      { parts: { y: 1988, m: 7, d: 1 }, timestamp: new Date('2026-04-25') },
    ]
    const result = selectModeWinner(subs, RUNTIME_YEAR)
    expect(result.chosen).toEqual({ y: 1988, m: 7, d: 1 })
  })

  it('guard discards a submission whose birth year >= its own submission year (T2 row 118 pattern)', () => {
    const subs: FormSubmission[] = [
      { parts: { y: 1997, m: 11, d: 5 }, timestamp: new Date('2026-01-05') },
      { parts: { y: 1997, m: 11, d: 6 }, timestamp: new Date('2026-02-09') },
      { parts: { y: 2026, m: 11, d: 6 }, timestamp: new Date('2026-03-05') },
      { parts: { y: 1997, m: 11, d: 6 }, timestamp: new Date('2026-04-01') },
      { parts: { y: 2026, m: 11, d: 6 }, timestamp: new Date('2026-05-06') },
    ]
    const result = selectModeWinner(subs, RUNTIME_YEAR)
    expect(result.chosen).toEqual({ y: 1997, m: 11, d: 6 })
    expect(result.discarded).toBe(2)
    expect(result.genuinelyUnresolved).toBe(false)
  })

  it('guard uses the SUBMISSION\'s own year as ceiling, not a hardcoded current year (re-run-safe)', () => {
    // Submitted in 2020 claiming birth year 2020 — impossible regardless of what year the script runs in.
    const subs: FormSubmission[] = [
      { parts: { y: 2020, m: 3, d: 1 }, timestamp: new Date('2020-03-01') },
      { parts: { y: 1995, m: 3, d: 1 }, timestamp: new Date('2020-04-01') },
    ]
    const result = selectModeWinner(subs, 2099) // even with a far-future runtime year, the 2020 entry must still be caught
    expect(result.chosen).toEqual({ y: 1995, m: 3, d: 1 })
    expect(result.discarded).toBe(1)
  })

  it('untimed submissions fall back to runtimeYear as the guard ceiling', () => {
    const subs: FormSubmission[] = [
      { parts: { y: 2026, m: 1, d: 1 }, timestamp: null },
      { parts: { y: 1990, m: 1, d: 1 }, timestamp: null },
    ]
    const result = selectModeWinner(subs, 2026)
    expect(result.chosen).toEqual({ y: 1990, m: 1, d: 1 })
    expect(result.discarded).toBe(1)
  })

  it('a real count-tie resolves via latest timestamp, and is NOT genuinelyUnresolved (T2 row 128 pattern)', () => {
    const subs: FormSubmission[] = [
      { parts: { y: 1992, m: 7, d: 9 }, timestamp: new Date('2026-01-09') },
      { parts: { y: 1992, m: 7, d: 9 }, timestamp: new Date('2026-02-13') },
      { parts: { y: 1992, m: 7, d: 11 }, timestamp: new Date('2026-04-09') },
      { parts: { y: 1992, m: 7, d: 11 }, timestamp: new Date('2026-05-06') },
    ]
    const result = selectModeWinner(subs, RUNTIME_YEAR)
    expect(result.chosen).toEqual({ y: 1992, m: 7, d: 11 })
    expect(result.genuinelyUnresolved).toBe(false)
  })

  it('a tie where the timestamp break ALSO ties is genuinely unresolved (chosen holds an arbitrary pick for diagnostics — callers must check genuinelyUnresolved, not just chosen)', () => {
    const subs: FormSubmission[] = [
      { parts: { y: 1990, m: 1, d: 1 }, timestamp: null },
      { parts: { y: 1991, m: 1, d: 1 }, timestamp: null },
    ]
    const result = selectModeWinner(subs, RUNTIME_YEAR)
    expect(result.genuinelyUnresolved).toBe(true)
  })

  it('all submissions guarded away leaves no usable value (T2 rows 133/173 pattern)', () => {
    const subs: FormSubmission[] = [{ parts: { y: 2026, m: 8, d: 2 }, timestamp: new Date('2026-02-08') }]
    const result = selectModeWinner(subs, RUNTIME_YEAR)
    expect(result.chosen).toBeNull()
    expect(result.discarded).toBe(1)
    expect(result.genuinelyUnresolved).toBe(false)
  })

  it('SYNTHETIC — two different people sharing one phone: submissions are pooled and voted as one bag per G/5 ("dedupe form responses by phone"); this is documented spec\'d behavior, not a bug', () => {
    // A household phone: person A (self, field 1) submits their own birthday twice;
    // person B (spouse, field 2) submits a different birthday once. G/5 does not
    // disambiguate by name — the phone alone is the match key, so the mode is
    // computed across BOTH people's answers pooled together.
    const subs: FormSubmission[] = [
      { parts: { y: 1980, m: 5, d: 20 }, timestamp: new Date('2026-01-01') }, // person A
      { parts: { y: 1980, m: 5, d: 20 }, timestamp: new Date('2026-02-01') }, // person A
      { parts: { y: 1975, m: 3, d: 10 }, timestamp: new Date('2026-03-01') }, // person B
    ]
    const result = selectModeWinner(subs, RUNTIME_YEAR)
    // Person A's repeated answer wins the pooled vote — this is what G/5's phone-only
    // matching mechanically produces. If a future roster ever has genuinely mixed
    // households sharing one number, this is the behavior to expect and review.
    expect(result.chosen).toEqual({ y: 1980, m: 5, d: 20 })
    expect(result.voteCounts.size).toBe(2)
  })
})

describe('classifyAgreement', () => {
  it('exact match', () => {
    expect(classifyAgreement({ y: 1990, m: 5, d: 3 }, { y: 1990, m: 5, d: 3 })).toBe('exact')
  })
  it('clean day/month swap -> transposed', () => {
    expect(classifyAgreement({ y: 1982, m: 6, d: 5 }, { y: 1982, m: 5, d: 6 })).toBe('transposed')
  })
  it('neither exact nor swap -> mismatch', () => {
    expect(classifyAgreement({ y: 1997, m: 8, d: 24 }, { y: 1997, m: 11, d: 8 })).toBe('mismatch')
  })
  it('either side null -> n/a', () => {
    expect(classifyAgreement(null, { y: 1990, m: 1, d: 1 })).toBe('n/a')
    expect(classifyAgreement({ y: 1990, m: 1, d: 1 }, null)).toBe('n/a')
  })
})

describe('resolvePrecedence — G/3 precedence table + T2 extensions', () => {
  const RUNTIME_YEAR = 2026

  it('has form match -> takes mode-wins verbatim, flags year_mismatch when years differ', () => {
    const result = resolvePrecedence({
      absensiCellType: 'pre-converted',
      absensiParts: { y: 1982, m: 5, d: 6 },
      hasFormMatch: true,
      formSubmissions: [
        { parts: { y: 1982, m: 6, d: 5 }, timestamp: new Date('2026-04-04') },
        { parts: { y: 1982, m: 6, d: 5 }, timestamp: new Date('2026-05-04') },
      ],
      runtimeYear: RUNTIME_YEAR,
    })
    expect(result.decision).toBe('corrected')
    expect(result.finalParts).toEqual({ y: 1982, m: 6, d: 5 })
    expect(result.ruleApplied).toBe('form-verbatim-mode-wins')
    expect(result.flags).not.toContain('year_mismatch') // same year, day/month transposed only
  })

  it('form match resolves to a non-swap mismatch -> flags absensi_mismatch_form_authoritative (row 66 / 128 pattern)', () => {
    const result = resolvePrecedence({
      absensiCellType: 'pre-converted',
      absensiParts: { y: 1997, m: 11, d: 8 },
      hasFormMatch: true,
      formSubmissions: [
        { parts: { y: 1997, m: 8, d: 24 }, timestamp: new Date('2026-02-10') },
        { parts: { y: 1997, m: 8, d: 24 }, timestamp: new Date('2026-03-09') },
        { parts: { y: 1997, m: 8, d: 24 }, timestamp: new Date('2026-05-06') },
      ],
      runtimeYear: RUNTIME_YEAR,
    })
    expect(result.decision).toBe('corrected')
    expect(result.finalParts).toEqual({ y: 1997, m: 8, d: 24 })
    expect(result.flags).toContain('absensi_mismatch_form_authoritative')
  })

  it('text cell, no match -> parsed month-first, decision kept', () => {
    const result = resolvePrecedence({
      absensiCellType: 'text',
      absensiParts: { y: 1986, m: 12, d: 15 },
      hasFormMatch: false,
      formSubmissions: [],
      runtimeYear: RUNTIME_YEAR,
    })
    expect(result.decision).toBe('kept')
    expect(result.finalParts).toEqual({ y: 1986, m: 12, d: 15 })
    expect(result.ruleApplied).toBe('text-parsed-month-first')
    expect(result.flags).toContain('no_form_match')
  })

  it('text cell, no match, impossible year in the text itself -> NULL (row 57 pattern)', () => {
    const result = resolvePrecedence({
      absensiCellType: 'text',
      absensiParts: { y: 2026, m: 3, d: 19 },
      hasFormMatch: false,
      formSubmissions: [],
      runtimeYear: RUNTIME_YEAR,
    })
    expect(result.decision).toBe('null')
    expect(result.flags).toContain('impossible_final_year')
  })

  it('pre-converted, day > 12, no match -> kept as parsed', () => {
    const result = resolvePrecedence({
      absensiCellType: 'pre-converted',
      absensiParts: { y: 1990, m: 3, d: 20 },
      hasFormMatch: false,
      formSubmissions: [],
      runtimeYear: RUNTIME_YEAR,
    })
    expect(result.decision).toBe('kept')
    expect(result.ruleApplied).toBe('preconverted-keep-day-gt12')
  })

  it('pre-converted, day <= 12, no match -> NULL (the original 8-row human-follow-up case)', () => {
    const result = resolvePrecedence({
      absensiCellType: 'pre-converted',
      absensiParts: { y: 1990, m: 3, d: 8 },
      hasFormMatch: false,
      formSubmissions: [],
      runtimeYear: RUNTIME_YEAR,
    })
    expect(result.decision).toBe('null')
    expect(result.ruleApplied).toBe('null-ambiguous-no-match')
  })

  it('has match but every submission guarded away -> NULL, not a silent fallback to Absensi (rows 133/173 pattern)', () => {
    const result = resolvePrecedence({
      absensiCellType: 'pre-converted',
      absensiParts: { y: 2026, m: 1, d: 25 },
      hasFormMatch: true,
      formSubmissions: [
        { parts: { y: 2026, m: 1, d: 25 }, timestamp: new Date('2026-01-05') },
        { parts: { y: 2026, m: 1, d: 25 }, timestamp: new Date('2026-02-09') },
      ],
      runtimeYear: RUNTIME_YEAR,
    })
    expect(result.decision).toBe('null')
    expect(result.flags).toContain('impossible_final_year')
  })

  it('raw-serial cell type flags raw_serial_coerced when falling through to the no-match branch', () => {
    const result = resolvePrecedence({
      absensiCellType: 'raw-serial',
      absensiParts: { y: 1990, m: 3, d: 20 },
      hasFormMatch: false,
      formSubmissions: [],
      runtimeYear: RUNTIME_YEAR,
    })
    expect(result.flags).toContain('raw_serial_coerced')
    expect(result.decision).toBe('kept')
  })
})
