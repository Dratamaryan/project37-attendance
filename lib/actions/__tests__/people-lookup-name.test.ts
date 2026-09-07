import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { impl_lookupByName } from '../people.impl'
import { sanitizeNameQuery, NAME_QUERY_MIN_LENGTH } from '@/lib/utils/name-query'

// ── Mock builder ──────────────────────────────────────────────────────────────
// impl_lookupByName has no .single() terminal — the builder itself is awaited,
// so it must be thenable (same shape as makePaginatedBuilder in people-list.test).

function makeQueryBuilder(response: { data: unknown; error: unknown }) {
  const promise = Promise.resolve(response)
  return Object.assign(promise, {
    select: vi.fn().mockReturnThis(),
    or:     vi.fn().mockReturnThis(),
    is:     vi.fn().mockReturnThis(),
    order:  vi.fn().mockReturnThis(),
    limit:  vi.fn().mockReturnThis(),
  })
}

function makeSupabase(response: { data: unknown; error: unknown } = { data: [], error: null }) {
  const builder = makeQueryBuilder(response)
  const supabase = {
    // Present so a test can prove the impl never reaches for an auth/role gate.
    auth: {
      getUser:   vi.fn(),
      getClaims: vi.fn(),
    },
    from: vi.fn().mockReturnValue(builder),
  }
  return { supabase, builder }
}

function call(supabase: { from: unknown }, query: string) {
  return impl_lookupByName(query, supabase as unknown as SupabaseClient)
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

function person(id: string, full_name: string, nickname = 'Nick') {
  return {
    id,
    phone_e164: '+6281234567890',
    full_name,
    nickname,
    email: null,
    birth_date: null,
    gender: null,
    origin_parish: null,
    marital_status: null,
    photo_url: null,
    photo_publish_consent: false,
    created_at: '2026-01-01T00:00:00Z',
  }
}

// ── impl_lookupByName ─────────────────────────────────────────────────────────

describe('impl_lookupByName', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns a single match', async () => {
    const { supabase } = makeSupabase({ data: [person('p1', 'Budi Santoso')], error: null })
    const result = await call(supabase, 'Budi')
    expect(result.status).toBe('matches')
    if (result.status !== 'matches') return
    expect(result.people).toHaveLength(1)
    expect(result.people[0].full_name).toBe('Budi Santoso')
    expect(result.hasMore).toBe(false)
  })

  it('builds the OR filter on full_name + nickname, ordered by full_name, limit 6', async () => {
    const { supabase, builder } = makeSupabase({ data: [person('p1', 'Budi')], error: null })
    await call(supabase, 'Budi')
    expect(supabase.from).toHaveBeenCalledWith('people')
    expect(builder.or).toHaveBeenCalledWith('full_name.ilike.%Budi%,nickname.ilike.%Budi%')
    expect(builder.order).toHaveBeenCalledWith('full_name', { ascending: true })
    // LIMIT+1: the 6th row is the hasMore probe and is never returned
    expect(builder.limit).toHaveBeenCalledWith(6)
  })

  it('returns 5 people and hasMore=true when a 6th row exists', async () => {
    const six = Array.from({ length: 6 }, (_, i) => person(`p${i}`, `Budi ${i}`))
    const { supabase } = makeSupabase({ data: six, error: null })
    const result = await call(supabase, 'Budi')
    expect(result.status).toBe('matches')
    if (result.status !== 'matches') return
    expect(result.people).toHaveLength(5)
    expect(result.hasMore).toBe(true)
    // The probe row is dropped, not surfaced
    expect(result.people.map(p => p.id)).not.toContain('p5')
  })

  it('returns exactly 5 with hasMore=false when the 5th is the last row', async () => {
    const five = Array.from({ length: 5 }, (_, i) => person(`p${i}`, `Budi ${i}`))
    const { supabase } = makeSupabase({ data: five, error: null })
    const result = await call(supabase, 'Budi')
    expect(result.status).toBe('matches')
    if (result.status !== 'matches') return
    expect(result.people).toHaveLength(5)
    expect(result.hasMore).toBe(false)
  })

  it('returns none when no rows match', async () => {
    const { supabase } = makeSupabase({ data: [], error: null })
    const result = await call(supabase, 'Zzzz')
    expect(result.status).toBe('none')
  })

  it('filters out soft-deleted people via deleted_at IS NULL', async () => {
    const { supabase, builder } = makeSupabase({ data: [person('p1', 'Budi')], error: null })
    await call(supabase, 'Budi')
    expect(builder.is).toHaveBeenCalledWith('deleted_at', null)
  })

  it('returns error when the query fails', async () => {
    const { supabase } = makeSupabase({ data: null, error: { code: 'PGRST000', message: 'boom' } })
    const result = await call(supabase, 'Budi')
    expect(result.status).toBe('error')
  })

  // ── Auth posture (mirrors impl_lookupByPhone) ───────────────────────────────

  it('uses the caller session client only — no role/admin gate, no admin client', async () => {
    const { supabase } = makeSupabase({ data: [person('p1', 'Budi')], error: null })
    const result = await call(supabase, 'Budi')

    expect(result.status).toBe('matches')
    // No application-layer auth lookup: RLS on the passed-in session client is
    // the enforcement layer, exactly as in impl_lookupByPhone.
    expect(supabase.auth.getUser).not.toHaveBeenCalled()
    expect(supabase.auth.getClaims).not.toHaveBeenCalled()
    // Never reads app_users to check role — that gate belongs to impl_listPeople.
    expect(supabase.from).not.toHaveBeenCalledWith('app_users')
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })
})

// ── Minimum length (server-side enforcement) ──────────────────────────────────

describe('impl_lookupByName — query_too_short', () => {
  beforeEach(() => vi.clearAllMocks())

  it.each(['', ' ', 'a', 'ab', '  ab  '])(
    'returns query_too_short for %o without touching the DB',
    async (query) => {
      const { supabase } = makeSupabase()
      const result = await call(supabase, query)
      expect(result.status).toBe('query_too_short')
      expect(supabase.from).not.toHaveBeenCalled()
    },
  )

  it('enforces the minimum on the SANITIZED value, not the raw one', async () => {
    // 8 raw characters, but only 2 survive sanitization → still too short.
    const { supabase } = makeSupabase()
    const result = await call(supabase, 'a1234567b')
    expect(result.status).toBe('query_too_short')
    expect(supabase.from).not.toHaveBeenCalled()
  })
})

// ── Sanitization ──────────────────────────────────────────────────────────────

describe('sanitizeNameQuery', () => {
  it('keeps letters, space, hyphen and apostrophe', () => {
    expect(sanitizeNameQuery("Anna-Maria O'Brien")).toBe("Anna-Maria O'Brien")
  })

  it('keeps non-ASCII letters', () => {
    expect(sanitizeNameQuery('José Müller')).toBe('José Müller')
  })

  it('strips ILIKE wildcards, PostgREST separators and punctuation', () => {
    expect(sanitizeNameQuery('%Bu_di%')).toBe('Budi')
    expect(sanitizeNameQuery('Budi,Ani')).toBe('BudiAni')
    expect(sanitizeNameQuery('Budi.Ani')).toBe('BudiAni')
    expect(sanitizeNameQuery('Budi)')).toBe('Budi')
    expect(sanitizeNameQuery('Budi(Ani):*')).toBe('BudiAni')
    expect(sanitizeNameQuery('Budi123')).toBe('Budi')
  })

  it('collapses whitespace runs and trims', () => {
    expect(sanitizeNameQuery('  Budi   Santoso  ')).toBe('Budi Santoso')
  })

  it('NAME_QUERY_MIN_LENGTH is 3', () => {
    expect(NAME_QUERY_MIN_LENGTH).toBe(3)
  })
})

describe('impl_lookupByName — sanitization is applied before the filter', () => {
  beforeEach(() => vi.clearAllMocks())

  // Each input is long enough post-sanitization to reach the DB, so the assertion
  // is on the emitted filter string rather than on an early return.
  const cases: Array<[string, string]> = [
    ['%Budi%',        'Budi'],
    ['Budi,Ani',      'BudiAni'],
    ['Budi.Ani',      'BudiAni'],
    ['Budi)',         'Budi'],
    ['Bu_di',         'Budi'],
    ['Budi*(Ani):',   'BudiAni'],
  ]

  it.each(cases)('input %o produces exactly one clean OR filter (%s)', async (raw, safe) => {
    const { supabase, builder } = makeSupabase({ data: [person('p1', 'Budi')], error: null })
    const result = await call(supabase, raw)

    // Neither errors nor early-returns...
    expect(result.status).toBe('matches')

    const filter = builder.or.mock.calls[0][0] as string
    // ...and the emitted filter is exactly the two intended conditions.
    expect(filter).toBe(`full_name.ilike.%${safe}%,nickname.ilike.%${safe}%`)

    // Structural proof that nothing was injected: a PostgREST or() filter
    // separates conditions with ',' and a condition's parts with '.', so an
    // unsanitized value would inflate these counts beyond the 2-condition shape.
    const conditions = filter.split(',')
    expect(conditions).toHaveLength(2)
    expect(conditions.map(c => c.split('.')[0])).toEqual(['full_name', 'nickname'])

    for (const condition of conditions) {
      // column.operator.pattern — exactly 3 dot-separated parts
      const parts = condition.split('.')
      expect(parts).toHaveLength(3)
      expect(parts[1]).toBe('ilike')
      // The pattern is exactly our own two wildcards around the sanitized value —
      // no caller-supplied '%' or '_' survives inside it. (Asserted on the
      // pattern, not the whole filter: the column names legitimately contain '_'.)
      const pattern = parts[2]
      expect(pattern).toBe(`%${safe}%`)
      expect(pattern.slice(1, -1)).not.toMatch(/[%_]/)
    }
  })
})

// ── Masked phone tail (name-list disambiguator) ───────────────────────────────

describe('maskPhoneTail', () => {
  it('masks all but the last four digits', async () => {
    const { maskPhoneTail } = await import('@/lib/utils/phone')
    expect(maskPhoneTail('+6282185352609')).toBe('…2609')
    expect(maskPhoneTail('+6281234567890')).toBe('…7890')
  })

  it('never leaks a short or malformed value', async () => {
    const { maskPhoneTail } = await import('@/lib/utils/phone')
    expect(maskPhoneTail('+62')).toBe('…')
    expect(maskPhoneTail('')).toBe('…')
  })
})
