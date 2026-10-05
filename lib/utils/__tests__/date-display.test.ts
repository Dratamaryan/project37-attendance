import { describe, it, expect } from 'vitest'
import { formatDateOnly, formatDayMonth } from '../date-display'

const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

describe('formatDateOnly', () => {
  it('returns empty string for null', () => {
    expect(formatDateOnly(null)).toBe('')
  })

  it('returns the YYYY-MM-DD slice unchanged', () => {
    expect(formatDateOnly('2014-03-01')).toBe('2014-03-01')
  })
})

describe('formatDayMonth', () => {
  it('returns an em dash for null', () => {
    expect(formatDayMonth(null, EN_MONTHS)).toBe('—')
  })

  it('formats day and month name', () => {
    expect(formatDayMonth('2014-03-14', EN_MONTHS)).toBe('14 Mar')
  })

  it('+1-day guard: the 1st of a month stays the 1st (never shifts to the previous month)', () => {
    expect(formatDayMonth('2014-03-01', EN_MONTHS)).toBe('1 Mar')
    expect(formatDayMonth('2014-03-01', EN_MONTHS)).not.toBe('28 Feb')
  })

  it('+1-day guard: 31 Dec stays in December (never rolls to January)', () => {
    expect(formatDayMonth('2014-12-31', EN_MONTHS)).toBe('31 Dec')
  })

  it('strips the leading zero from the day', () => {
    expect(formatDayMonth('2020-01-05', EN_MONTHS)).toBe('5 Jan')
  })

  it('uses the caller-supplied month names (locale-agnostic)', () => {
    const ID_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des']
    expect(formatDayMonth('2014-05-14', ID_MONTHS)).toBe('14 Mei')
  })
})
