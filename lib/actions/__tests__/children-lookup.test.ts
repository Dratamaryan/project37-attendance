import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { impl_listChildrenByParent, impl_lookupChildByName } from '../children.impl'

// ── Mock builder ──────────────────────────────────────────────────────────────
// Neither child lookup has a .single() terminal — the builder itself is awaited,
// so it must be thenable (same shape as people-lookup-name.test).

function makeQueryBuilder(response: { data: unknown; error: unknown }) {
  const promise = Promise.resolve(response)
  return Object.assign(promise, {
    select: vi.fn().mockReturnThis(),
    eq:     vi.fn().mockReturnThis(),
    ilike:  vi.fn().mockReturnThis(),
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

const PARENT_ID = '11111111-2222-4333-8444-555555555555'

// ── Fixtures (synthetic) ──────────────────────────────────────────────────────

function child(id: string, full_name: string) {
  return {
    id,
    parent_person_id: PARENT_ID,
    full_name,
    birth_date: '2018-03-01',
    gender: null,
  }
}

function childWithParent(id: string, full_name: string, parent_full_name = 'Test Parent') {
  return { ...child(id, full_name), people: { full_name: parent_full_name } }
}

// ── impl_listChildrenByParent ─────────────────────────────────────────────────

describe('impl_listChildrenByParent', () => {
  beforeEach(() => vi.clearAllMocks())

  function call(supabase: { from: unknown }, parentId: string) {
    return impl_listChildrenByParent(parentId, supabase as unknown as SupabaseClient)
  }

  it('returns the parent’s children', async () => {
    const { supabase } = makeSupabase({
      data: [child('c1', 'Test Child A'), child('c2', 'Test Child B')],
      error: null,
    })
    const result = await call(supabase, PARENT_ID)
    expect(result.status).toBe('children')
    if (result.status !== 'children') return
    expect(result.children.map(c => c.id)).toEqual(['c1', 'c2'])
  })

  it('queries children by parent, excludes soft-deleted, ordered by full_name', async () => {
    const { supabase, builder } = makeSupabase({ data: [child('c1', 'Test Child A')], error: null })
    await call(supabase, PARENT_ID)
    expect(supabase.from).toHaveBeenCalledWith('children')
    expect(builder.select).toHaveBeenCalledWith('id, parent_person_id, full_name, birth_date, gender')
    expect(builder.eq).toHaveBeenCalledWith('parent_person_id', PARENT_ID)
    expect(builder.is).toHaveBeenCalledWith('deleted_at', null)
    expect(builder.order).toHaveBeenCalledWith('full_name', { ascending: true })
  })

  it('returns none when the parent has no children', async () => {
    const { supabase } = makeSupabase({ data: [], error: null })
    const result = await call(supabase, PARENT_ID)
    expect(result.status).toBe('none')
  })

  it.each(['', 'not-a-uuid', `${PARENT_ID}x`])(
    'returns invalid_input for %o without touching the DB',
    async (bad) => {
      const { supabase } = makeSupabase()
      const result = await call(supabase, bad)
      expect(result).toMatchObject({ status: 'invalid_input', field: 'parentPersonId' })
      expect(supabase.from).not.toHaveBeenCalled()
    },
  )

  it('returns error when the query fails', async () => {
    const { supabase } = makeSupabase({ data: null, error: { code: 'PGRST000', message: 'boom' } })
    const result = await call(supabase, PARENT_ID)
    expect(result.status).toBe('error')
  })

  it('uses the caller session client only — no role/admin gate', async () => {
    const { supabase } = makeSupabase({ data: [child('c1', 'Test Child A')], error: null })
    await call(supabase, PARENT_ID)
    expect(supabase.auth.getUser).not.toHaveBeenCalled()
    expect(supabase.auth.getClaims).not.toHaveBeenCalled()
    expect(supabase.from).not.toHaveBeenCalledWith('app_users')
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })
})

// ── impl_lookupChildByName ────────────────────────────────────────────────────

describe('impl_lookupChildByName', () => {
  beforeEach(() => vi.clearAllMocks())

  function call(supabase: { from: unknown }, query: string) {
    return impl_lookupChildByName(query, supabase as unknown as SupabaseClient)
  }

  it('returns a match with parent_full_name flattened from the embed', async () => {
    const { supabase } = makeSupabase({
      data: [childWithParent('c1', 'Test Child A', 'Test Parent One')],
      error: null,
    })
    const result = await call(supabase, 'Child')
    expect(result.status).toBe('matches')
    if (result.status !== 'matches') return
    expect(result.children).toHaveLength(1)
    expect(result.children[0]).toEqual({
      id: 'c1',
      parent_person_id: PARENT_ID,
      full_name: 'Test Child A',
      birth_date: '2018-03-01',
      gender: null,
      parent_full_name: 'Test Parent One',
    })
    // The raw embed is not leaked onto the result row
    expect(result.children[0]).not.toHaveProperty('people')
    expect(result.hasMore).toBe(false)
  })

  it('matches full_name only (no nickname), embeds parent, ordered by full_name, limit 6', async () => {
    const { supabase, builder } = makeSupabase({ data: [childWithParent('c1', 'Test Child')], error: null })
    await call(supabase, 'Child')
    expect(supabase.from).toHaveBeenCalledWith('children')
    expect(builder.select).toHaveBeenCalledWith(
      'id, parent_person_id, full_name, birth_date, gender, people!inner(full_name)',
    )
    expect(builder.ilike).toHaveBeenCalledTimes(1)
    expect(builder.ilike).toHaveBeenCalledWith('full_name', '%Child%')
    expect(builder.order).toHaveBeenCalledWith('full_name', { ascending: true })
    // LIMIT+1: the 6th row is the hasMore probe and is never returned
    expect(builder.limit).toHaveBeenCalledWith(6)
  })

  it('filters out soft-deleted children and children of soft-deleted parents', async () => {
    const { supabase, builder } = makeSupabase({ data: [childWithParent('c1', 'Test Child')], error: null })
    await call(supabase, 'Child')
    expect(builder.is).toHaveBeenCalledWith('deleted_at', null)
    expect(builder.is).toHaveBeenCalledWith('people.deleted_at', null)
  })

  it('returns 5 children and hasMore=true when a 6th row exists', async () => {
    const six = Array.from({ length: 6 }, (_, i) => childWithParent(`c${i}`, `Test Child ${i}`))
    const { supabase } = makeSupabase({ data: six, error: null })
    const result = await call(supabase, 'Child')
    expect(result.status).toBe('matches')
    if (result.status !== 'matches') return
    expect(result.children).toHaveLength(5)
    expect(result.hasMore).toBe(true)
    expect(result.children.map(c => c.id)).not.toContain('c5')
  })

  it('returns exactly 5 with hasMore=false when the 5th is the last row', async () => {
    const five = Array.from({ length: 5 }, (_, i) => childWithParent(`c${i}`, `Test Child ${i}`))
    const { supabase } = makeSupabase({ data: five, error: null })
    const result = await call(supabase, 'Child')
    expect(result.status).toBe('matches')
    if (result.status !== 'matches') return
    expect(result.children).toHaveLength(5)
    expect(result.hasMore).toBe(false)
  })

  it('returns none when no rows match', async () => {
    const { supabase } = makeSupabase({ data: [], error: null })
    const result = await call(supabase, 'Zzzz')
    expect(result.status).toBe('none')
  })

  it('returns error when the query fails', async () => {
    const { supabase } = makeSupabase({ data: null, error: { code: 'PGRST000', message: 'boom' } })
    const result = await call(supabase, 'Child')
    expect(result.status).toBe('error')
  })

  it.each(['', ' ', 'a', 'ab', '  ab  ', 'a1234567b'])(
    'returns query_too_short for %o (checked on the sanitized value) without touching the DB',
    async (query) => {
      const { supabase } = makeSupabase()
      const result = await call(supabase, query)
      expect(result.status).toBe('query_too_short')
      expect(supabase.from).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['%Child%',      'Child'],
    ['Chi_ld',       'Child'],
    ['Child,Other',  'ChildOther'],
    ['Child.Other',  'ChildOther'],
    ['Child*(x):',   'Childx'],
  ])('sanitizes %o before it reaches the ILIKE pattern (%s)', async (raw, safe) => {
    const { supabase, builder } = makeSupabase({ data: [childWithParent('c1', 'Test Child')], error: null })
    const result = await call(supabase, raw)
    expect(result.status).toBe('matches')
    const pattern = builder.ilike.mock.calls[0][1] as string
    expect(pattern).toBe(`%${safe}%`)
    // No caller-supplied wildcard survives inside our own two
    expect(pattern.slice(1, -1)).not.toMatch(/[%_]/)
  })

  it('uses the caller session client only — no role/admin gate', async () => {
    const { supabase } = makeSupabase({ data: [childWithParent('c1', 'Test Child')], error: null })
    await call(supabase, 'Child')
    expect(supabase.auth.getUser).not.toHaveBeenCalled()
    expect(supabase.auth.getClaims).not.toHaveBeenCalled()
    expect(supabase.from).not.toHaveBeenCalledWith('app_users')
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })
})
