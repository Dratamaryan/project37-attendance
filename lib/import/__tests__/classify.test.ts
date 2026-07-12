import { describe, it, expect } from 'vitest'
import { classifyRows, tallyClassificationCounts, type ExistingPhoneRecord } from '../classify'
import { normalizeRow } from '../normalize'
import type { ParsedPersonRow } from '../types'

function parsed(sourceRowNumber: number, cellsByField: Record<string, unknown>): ParsedPersonRow {
  return normalizeRow({ sourceRowNumber, cellsByField })
}

describe('classifyRows — one fixture per class', () => {
  it('new: no DB match, first-in-file', () => {
    const rows = [parsed(3, { full_name: 'A', phone_raw: '81234567890' })]
    const result = classifyRows(rows, new Map())
    expect(result[0].rowClass).toBe('new')
    expect(result[0].matchedPersonId).toBeNull()
  })

  it('dup_in_db: DB match with deletedAt null', () => {
    const rows = [parsed(3, { full_name: 'A', phone_raw: '81234567890' })]
    const existing = new Map<string, ExistingPhoneRecord>([['+6281234567890', { id: 'p1', deletedAt: null }]])
    const result = classifyRows(rows, existing)
    expect(result[0].rowClass).toBe('dup_in_db')
    expect(result[0].matchedPersonId).toBe('p1')
  })

  it('dup_in_file: same phone twice, neither in DB -> row1 new, row2 dup_in_file', () => {
    const rows = [
      parsed(3, { full_name: 'A', phone_raw: '81234567890' }),
      parsed(4, { full_name: 'B', phone_raw: '81234567890' }),
    ]
    const result = classifyRows(rows, new Map())
    expect(result[0].rowClass).toBe('new')
    expect(result[1].rowClass).toBe('dup_in_file')
  })

  it('dup_in_file order-dependence: reversed input flips the winner (proves true order-dependence)', () => {
    const rows = [
      parsed(3, { full_name: 'A', phone_raw: '81234567890' }),
      parsed(4, { full_name: 'B', phone_raw: '81234567890' }),
    ]
    const reversed = [...rows].reverse()
    const result = classifyRows(reversed, new Map())
    // reversed[0] was originally row 4 ("B") -> now wins as 'new'
    expect(result[0].full_name).toBe('B')
    expect(result[0].rowClass).toBe('new')
    expect(result[1].full_name).toBe('A')
    expect(result[1].rowClass).toBe('dup_in_file')
  })

  it('dup_soft_deleted: DB match with deletedAt set -> never new, never resurrected', () => {
    const rows = [parsed(3, { full_name: 'A', phone_raw: '81234567890' })]
    const existing = new Map<string, ExistingPhoneRecord>([
      ['+6281234567890', { id: 'p1', deletedAt: '2026-01-01T00:00:00Z' }],
    ])
    const result = classifyRows(rows, existing)
    expect(result[0].rowClass).toBe('dup_soft_deleted')
    expect(result[0].matchedPersonId).toBe('p1')
  })

  it('dup_soft_deleted phone appears twice in file -> BOTH rows dup_soft_deleted (DB match wins over file position)', () => {
    const rows = [
      parsed(3, { full_name: 'A', phone_raw: '81234567890' }),
      parsed(4, { full_name: 'B', phone_raw: '81234567890' }),
    ]
    const existing = new Map<string, ExistingPhoneRecord>([
      ['+6281234567890', { id: 'p1', deletedAt: '2026-01-01T00:00:00Z' }],
    ])
    const result = classifyRows(rows, existing)
    expect(result[0].rowClass).toBe('dup_soft_deleted')
    expect(result[1].rowClass).toBe('dup_soft_deleted')
  })

  it('active DB match phone appears twice in file -> BOTH rows dup_in_db (same DB-match-wins reasoning)', () => {
    const rows = [
      parsed(3, { full_name: 'A', phone_raw: '81234567890' }),
      parsed(4, { full_name: 'B', phone_raw: '81234567890' }),
    ]
    const existing = new Map<string, ExistingPhoneRecord>([['+6281234567890', { id: 'p1', deletedAt: null }]])
    const result = classifyRows(rows, existing)
    expect(result[0].rowClass).toBe('dup_in_db')
    expect(result[1].rowClass).toBe('dup_in_db')
  })

  it('error: missing phone', () => {
    const rows = [parsed(3, { full_name: 'A' })]
    const result = classifyRows(rows, new Map())
    expect(result[0].rowClass).toBe('error')
    expect(result[0].reason).toBe('missing_phone')
  })

  it('error: invalid phone', () => {
    const rows = [parsed(3, { full_name: 'A', phone_raw: 'not-a-phone' })]
    const result = classifyRows(rows, new Map())
    expect(result[0].rowClass).toBe('error')
    expect(result[0].reason).toBe('invalid_phone')
  })

  it('error: missing full_name (whitespace-only counts as missing)', () => {
    const rows = [parsed(3, { full_name: '   ', phone_raw: '81234567890' })]
    const result = classifyRows(rows, new Map())
    expect(result[0].rowClass).toBe('error')
    expect(result[0].reason).toBe('missing_full_name')
  })

  it('error rows are never added to the in-file seen-set (do not affect later dedup)', () => {
    const rows = [
      parsed(3, { full_name: 'A' }), // missing phone -> error
      parsed(4, { full_name: 'B', phone_raw: '81234567890' }),
    ]
    const result = classifyRows(rows, new Map())
    expect(result[0].rowClass).toBe('error')
    expect(result[1].rowClass).toBe('new')
  })
})

describe('classifyRows — normalized-phone-collision dedup', () => {
  it('two different raw formats normalizing to the same E.164 -> dup_in_file (dedup keys on normalized phone, not raw)', () => {
    const rows = [
      parsed(3, { full_name: 'A', phone_raw: '0818962281' }),
      parsed(4, { full_name: 'B', phone_raw: '+62818962281' }),
    ]
    const result = classifyRows(rows, new Map())
    expect(result[0].phone_e164).toBe(result[1].phone_e164)
    expect(result[0].rowClass).toBe('new')
    expect(result[1].rowClass).toBe('dup_in_file')
  })
})

describe('tallyClassificationCounts', () => {
  it('counts match the returned rows breakdown exactly', () => {
    const rows = [
      parsed(3, { full_name: 'A', phone_raw: '81234567890' }),
      parsed(4, { full_name: 'B', phone_raw: '81234567890' }),
      parsed(5, { full_name: 'C' }),
    ]
    const classified = classifyRows(rows, new Map())
    const counts = tallyClassificationCounts(classified)
    expect(counts).toEqual({ new: 1, dup_in_db: 0, dup_in_file: 1, dup_soft_deleted: 0, error: 1 })
    expect(counts.new + counts.dup_in_db + counts.dup_in_file + counts.dup_soft_deleted + counts.error).toBe(
      classified.length,
    )
  })
})
