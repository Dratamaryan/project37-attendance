import { describe, it, expect } from 'vitest'
import { sheetSafe, sheetSafeRow } from '../sheet-safe'

describe('sheetSafe', () => {
  it.each(['=', '+', '-', '@', '\t', '\r'])('prefixes a string starting with %j', leader => {
    expect(sheetSafe(`${leader}SUM(1,2)`)).toBe(`'${leader}SUM(1,2)`)
  })

  it('leaves safe strings untouched', () => {
    expect(sheetSafe('Budi Santoso')).toBe('Budi Santoso')
    expect(sheetSafe('2026-07-10T11:00:00+00:00')).toBe('2026-07-10T11:00:00+00:00')
    expect(sheetSafe('•••• 1234')).toBe('•••• 1234')
  })

  it('only the first character matters', () => {
    expect(sheetSafe('a=b')).toBe('a=b')
    expect(sheetSafe(' =1+1')).toBe(' =1+1')
  })

  it('leaves the empty string untouched', () => {
    expect(sheetSafe('')).toBe('')
  })

  it('does not double-prefix an already-quoted value', () => {
    expect(sheetSafe("'=x")).toBe("'=x")
  })

  it('exempts strict E.164 phone numbers (D1)', () => {
    expect(sheetSafe('+6281234567890')).toBe('+6281234567890')
    expect(sheetSafe('+14155550123')).toBe('+14155550123')
  })

  it('still prefixes +-leading values that are not strict E.164', () => {
    expect(sheetSafe('+SUM(1)')).toBe("'+SUM(1)")
    expect(sheetSafe('+62 812')).toBe("'+62 812")
    expect(sheetSafe('+0812345678')).toBe("'+0812345678")
    expect(sheetSafe('+62812345678901234')).toBe("'+62812345678901234")
  })
})

describe('sheetSafeRow', () => {
  it('sanitises string values and passes non-strings through', () => {
    const row = { Name: '=HYPERLINK("http://x","y")', Count: -3, Active: true, Note: null, Phone: '+6281234567890' }
    expect(sheetSafeRow(row)).toEqual({
      Name: `'=HYPERLINK("http://x","y")`,
      Count: -3,
      Active: true,
      Note: null,
      Phone: '+6281234567890',
    })
  })

  it('keeps header keys (and their order) unchanged', () => {
    const row = { '=Header': '@x', Other: 'ok' }
    expect(Object.keys(sheetSafeRow(row))).toEqual(['=Header', 'Other'])
  })

  it('does not mutate its input', () => {
    const row = { Name: '-1' }
    sheetSafeRow(row)
    expect(row.Name).toBe('-1')
  })
})
