import { describe, it, expect } from 'vitest'
import { nameKey, nameMatchQueries, mergeMatches } from '../name-matches'
import type { LookupByNameResult, PersonSummary } from '@/lib/actions/people.types'

function person(id: string, full_name: string): PersonSummary {
  return {
    id,
    phone_e164: `+62999${id.padStart(8, '0')}`,
    full_name,
    nickname: full_name.split(' ')[0],
    email: null,
    birth_date: null,
    gender: null,
    origin_parish: null,
    marital_status: null,
    photo_url: null,
    photo_publish_consent: false,
    created_at: '2026-10-17T00:00:00Z',
  }
}

describe('nameMatchQueries', () => {
  it('returns the full name and its first token', () => {
    expect(nameMatchQueries('Budi Santoso')).toEqual(['Budi Santoso', 'Budi'])
  })

  it('returns only the full name for a single word', () => {
    expect(nameMatchQueries('Budi')).toEqual(['Budi'])
  })

  it('skips a first token shorter than 3 characters', () => {
    expect(nameMatchQueries('Jo Santoso')).toEqual(['Jo Santoso'])
  })

  it('returns nothing when the sanitized name is shorter than 3 characters', () => {
    expect(nameMatchQueries('Jo')).toEqual([])
    expect(nameMatchQueries('  ')).toEqual([])
    expect(nameMatchQueries('A1%')).toEqual([])
  })

  it('sanitizes before splitting (symbols dropped, whitespace collapsed)', () => {
    expect(nameMatchQueries('  Budi,   Santoso!% ')).toEqual(['Budi Santoso', 'Budi'])
  })
})

describe('nameKey', () => {
  it('is the sanitized name, so cosmetic edits share a key', () => {
    expect(nameKey(' Budi  Santoso ')).toBe(nameKey('Budi Santoso'))
  })
})

describe('mergeMatches', () => {
  it('dedupes by id and keeps full-name matches first', () => {
    const results: LookupByNameResult[] = [
      { status: 'matches', people: [person('2', 'Budi Santoso')], hasMore: false },
      { status: 'matches', people: [person('1', 'Budi Hartono'), person('2', 'Budi Santoso')], hasMore: false },
    ]
    expect(mergeMatches(results).map(m => m.id)).toEqual(['2', '1'])
  })

  it('ignores none / error / query_too_short results', () => {
    const results: LookupByNameResult[] = [
      { status: 'none' },
      { status: 'error', message: 'Lookup failed' },
      { status: 'query_too_short' },
    ]
    expect(mergeMatches(results)).toEqual([])
  })

  it('keeps only the fields the warning needs', () => {
    const [m] = mergeMatches([{ status: 'matches', people: [person('1', 'Budi Hartono')], hasMore: false }])
    expect(Object.keys(m).sort()).toEqual(['full_name', 'id', 'nickname', 'phone_e164'])
  })
})
