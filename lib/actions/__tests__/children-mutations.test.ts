import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { impl_createChild, impl_updateChild, impl_softDeleteChild } from '../children.impl'
import { AUDIT_ACTIONS } from '../../audit'

// ────────────────────────────────────────────────────────────────────────────
// Mock factory
//
// One shared chainable builder. Every terminal — .single(), .maybeSingle(), or
// awaiting the builder itself (the duplicate-check SELECT and the soft-delete
// UPDATE have no single terminal) — consumes the next response from one queue,
// in call order. Same sequential idea as people.test.ts's makeMockBuilder.
// ────────────────────────────────────────────────────────────────────────────

const ACTOR_ID = 'actor-uuid-1234'
const PARENT_ID = '11111111-2222-4333-8444-555555555555'
const CHILD_ID  = '66666666-7777-4888-8999-aaaaaaaaaaaa'

type MockResponse = { data?: unknown; error?: unknown; count?: number | null }

function makeMockBuilder(responses: MockResponse[]) {
  let idx = 0
  const next = () => {
    const r = responses[idx] ?? { data: null, error: null }
    idx++
    return Promise.resolve({ data: r.data ?? null, error: r.error ?? null, count: r.count ?? null })
  }
  const builder = {
    select:      vi.fn().mockReturnThis(),
    insert:      vi.fn().mockReturnThis(),
    update:      vi.fn().mockReturnThis(),
    eq:          vi.fn().mockReturnThis(),
    is:          vi.fn().mockReturnThis(),
    ilike:       vi.fn().mockReturnThis(),
    order:       vi.fn().mockReturnThis(),
    single:      vi.fn().mockImplementation(next),
    maybeSingle: vi.fn().mockImplementation(next),
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      next().then(resolve, reject),
  }
  return builder
}

type MockSupabase = SupabaseClient & {
  _builder: ReturnType<typeof makeMockBuilder>
  rpc:      ReturnType<typeof vi.fn>
  from:     ReturnType<typeof vi.fn>
}

function makeMockSupabase(responses: MockResponse[] = [], userId: string | null = ACTOR_ID): MockSupabase {
  const builder = makeMockBuilder(responses)
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: userId ? { id: userId } : null }, error: null }),
    },
    from: vi.fn().mockReturnValue(builder),
    rpc:  vi.fn().mockResolvedValue({ data: null, error: null }),
    _builder: builder,
  } as unknown as MockSupabase
}

// Synthetic fixture
const MOCK_CHILD = {
  id:               CHILD_ID,
  parent_person_id: PARENT_ID,
  full_name:        'Test Child Alpha',
  birth_date:       '2018-03-01',
  gender:           null,
}

const RLS_DENIED = { code: '42501', message: 'new row violates row-level security policy' }

/** The single log_audit call's p_details_json, asserted IDs-only. */
function auditDetails(supabase: MockSupabase): Record<string, unknown> {
  expect(supabase.rpc).toHaveBeenCalledTimes(1)
  const details = supabase.rpc.mock.calls[0][1].p_details_json as Record<string, unknown>
  for (const forbidden of ['full_name', 'birth_date', 'name', 'before', 'after', 'notes', 'gender']) {
    expect(details).not.toHaveProperty(forbidden)
  }
  expect(JSON.stringify(details)).not.toContain('Test Child')
  expect(JSON.stringify(details)).not.toContain('2018-03-01')
  return details
}

// Pin "now" so Jakarta-vs-UTC date logic is deterministic:
// 2026-10-06T18:00:00Z = 2026-10-07 01:00 WIB. Today-in-Jakarta is 10-07 while
// the UTC date is still 10-06 — exactly the window toISOString() gets wrong.
beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-10-06T18:00:00Z'), toFake: ['Date'] })
})
afterEach(() => {
  vi.useRealTimers()
})

// ────────────────────────────────────────────────────────────────────────────
// createChild
// ────────────────────────────────────────────────────────────────────────────

describe('impl_createChild', () => {
  const VALID = { parentPersonId: PARENT_ID, full_name: '  Test Child Alpha  ', birth_date: '2018-03-01' }

  it('happy path: created; trims name; sets updated_at; audit is IDs-only', async () => {
    const supabase = makeMockSupabase([
      { data: { id: PARENT_ID } }, // parent guard
      { data: [] },                // duplicate check: none
      { data: MOCK_CHILD },        // insert
    ])
    const result = await impl_createChild(VALID, supabase)
    expect(result).toEqual({ status: 'created', child: MOCK_CHILD })

    const payload = supabase._builder.insert.mock.calls[0][0]
    expect(payload).toMatchObject({
      parent_person_id: PARENT_ID,
      full_name:        'Test Child Alpha',
      birth_date:       '2018-03-01',
      gender:           null,
      notes:            null,
    })
    expect(typeof payload.updated_at).toBe('string')

    expect(supabase.rpc).toHaveBeenCalledWith('log_audit', expect.objectContaining({
      p_action:      AUDIT_ACTIONS.CHILD_CREATE,
      p_entity_type: 'children',
      p_entity_id:   CHILD_ID,
    }))
    expect(auditDetails(supabase)).toEqual({ child_id: CHILD_ID, parent_id: PARENT_ID })
  })

  it('parent guard filters deleted_at IS NULL explicitly', async () => {
    const supabase = makeMockSupabase([{ data: { id: PARENT_ID } }, { data: [] }, { data: MOCK_CHILD }])
    await impl_createChild(VALID, supabase)
    expect(supabase.from).toHaveBeenNthCalledWith(1, 'people')
    expect(supabase._builder.is).toHaveBeenCalledWith('deleted_at', null)
  })

  it('missing full_name → validation_error, no DB call, no audit', async () => {
    const supabase = makeMockSupabase()
    const result = await impl_createChild({ ...VALID, full_name: '   ' }, supabase)
    expect(result).toEqual({ status: 'validation_error', field_errors: { full_name: 'Required' } })
    expect(supabase.from).not.toHaveBeenCalled()
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it.each([
    ['not ISO',         '01/03/2018'],
    ['impossible day',  '2019-02-29'],
    ['month 13',        '2018-13-01'],
    ['out of range',    '1899-12-31'],
  ])('bad birth_date (%s) → validation_error', async (_label, birth_date) => {
    const supabase = makeMockSupabase()
    const result = await impl_createChild({ ...VALID, birth_date }, supabase)
    expect(result.status).toBe('validation_error')
    if (result.status !== 'validation_error') return
    expect(result.field_errors).toHaveProperty('birth_date')
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('leap day 2020-02-29 is accepted', async () => {
    const supabase = makeMockSupabase([{ data: { id: PARENT_ID } }, { data: [] }, { data: MOCK_CHILD }])
    const result = await impl_createChild({ ...VALID, birth_date: '2020-02-29' }, supabase)
    expect(result.status).toBe('created')
  })

  it('future date in Jakarta (tomorrow WIB) → validation_error', async () => {
    const supabase = makeMockSupabase()
    const result = await impl_createChild({ ...VALID, birth_date: '2026-10-08' }, supabase)
    expect(result.status).toBe('validation_error')
    if (result.status !== 'validation_error') return
    expect(result.field_errors.birth_date).toMatch(/future/)
  })

  it('today in Jakarta is accepted even though it is "tomorrow" in UTC', async () => {
    const supabase = makeMockSupabase([{ data: { id: PARENT_ID } }, { data: [] }, { data: MOCK_CHILD }])
    const result = await impl_createChild({ ...VALID, birth_date: '2026-10-07' }, supabase)
    expect(result.status).toBe('created')
  })

  it('birth_date null / absent is allowed (unknown)', async () => {
    const supabase = makeMockSupabase([{ data: { id: PARENT_ID } }, { data: [] }, { data: MOCK_CHILD }])
    const result = await impl_createChild({ parentPersonId: PARENT_ID, full_name: 'X Y' }, supabase)
    expect(result.status).toBe('created')
    expect(supabase._builder.insert.mock.calls[0][0].birth_date).toBeNull()
  })

  it('invalid gender → validation_error', async () => {
    const supabase = makeMockSupabase()
    const result = await impl_createChild(
      { ...VALID, gender: 'other' as unknown as 'male' }, supabase,
    )
    expect(result.status).toBe('validation_error')
  })

  it('malformed parentPersonId → validation_error (no DB call)', async () => {
    const supabase = makeMockSupabase()
    const result = await impl_createChild({ ...VALID, parentPersonId: 'nope' }, supabase)
    expect(result.status).toBe('validation_error')
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('parent missing or soft-deleted → parent_not_found; no insert, no audit', async () => {
    const supabase = makeMockSupabase([{ data: null }])
    const result = await impl_createChild(VALID, supabase)
    expect(result).toEqual({ status: 'parent_not_found' })
    expect(supabase._builder.insert).not.toHaveBeenCalled()
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('same-name sibling exists → duplicate_warning: STILL created, existing populated', async () => {
    const sibling = { ...MOCK_CHILD, id: 'sib-1', birth_date: '2016-01-01' }
    const supabase = makeMockSupabase([
      { data: { id: PARENT_ID } },
      { data: [sibling] },
      { data: MOCK_CHILD },
    ])
    const result = await impl_createChild(VALID, supabase)
    expect(result).toEqual({ status: 'duplicate_warning', child: MOCK_CHILD, existing: [sibling] })
    expect(supabase._builder.insert).toHaveBeenCalledTimes(1)
    expect(auditDetails(supabase)).toEqual({ child_id: CHILD_ID, parent_id: PARENT_ID })
  })

  it('duplicate check is case-insensitive exact (ilike, LIKE metachars escaped)', async () => {
    const supabase = makeMockSupabase([{ data: { id: PARENT_ID } }, { data: [] }, { data: MOCK_CHILD }])
    await impl_createChild({ ...VALID, full_name: ' 100%_Kid ' }, supabase)
    expect(supabase._builder.ilike).toHaveBeenCalledWith('full_name', '100\\%\\_Kid')
    expect(supabase._builder.eq).toHaveBeenCalledWith('parent_person_id', PARENT_ID)
  })

  it('RLS insert denial (42501) → forbidden, no audit', async () => {
    const supabase = makeMockSupabase([{ data: { id: PARENT_ID } }, { data: [] }, { error: RLS_DENIED }])
    const result = await impl_createChild(VALID, supabase)
    expect(result.status).toBe('forbidden')
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('other insert error → error', async () => {
    const supabase = makeMockSupabase([{ data: { id: PARENT_ID } }, { data: [] }, { error: { code: 'XX000', message: 'boom' } }])
    const result = await impl_createChild(VALID, supabase)
    expect(result.status).toBe('error')
  })

  it('no session → forbidden, no DB call', async () => {
    const supabase = makeMockSupabase([], null)
    const result = await impl_createChild(VALID, supabase)
    expect(result.status).toBe('forbidden')
    expect(supabase.from).not.toHaveBeenCalled()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// updateChild
// ────────────────────────────────────────────────────────────────────────────

describe('impl_updateChild', () => {
  it('updates only provided fields; audit carries changed field NAMES only', async () => {
    const updated = { ...MOCK_CHILD, full_name: 'Test Child Beta' }
    const supabase = makeMockSupabase([{ data: MOCK_CHILD }, { data: updated }])
    const result = await impl_updateChild(CHILD_ID, { full_name: ' Test Child Beta ', birth_date: null }, supabase)
    expect(result).toEqual({ status: 'updated', child: updated })

    const patch = supabase._builder.update.mock.calls[0][0]
    expect(patch).toMatchObject({ full_name: 'Test Child Beta', birth_date: null })
    expect(patch).not.toHaveProperty('gender')
    expect(patch).not.toHaveProperty('notes')
    expect(typeof patch.updated_at).toBe('string')

    expect(supabase.rpc).toHaveBeenCalledWith('log_audit', expect.objectContaining({
      p_action: AUDIT_ACTIONS.CHILD_UPDATE, p_entity_id: CHILD_ID,
    }))
    expect(auditDetails(supabase)).toEqual({
      child_id: CHILD_ID, parent_id: PARENT_ID, changed_fields: ['full_name', 'birth_date'],
    })
  })

  it('ignores non-whitelisted keys (parent_person_id / deleted_at never reach the UPDATE)', async () => {
    const supabase = makeMockSupabase([{ data: MOCK_CHILD }, { data: MOCK_CHILD }])
    const input = { notes: 'n', parent_person_id: 'x', deleted_at: 'y' } as unknown as { notes: string }
    await impl_updateChild(CHILD_ID, input, supabase)
    const patch = supabase._builder.update.mock.calls[0][0]
    expect(patch).not.toHaveProperty('parent_person_id')
    expect(patch).not.toHaveProperty('deleted_at')
  })

  it('empty patch → validation_error, no DB call', async () => {
    const supabase = makeMockSupabase()
    const result = await impl_updateChild(CHILD_ID, {}, supabase)
    expect(result.status).toBe('validation_error')
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('future Jakarta birth_date → validation_error', async () => {
    const supabase = makeMockSupabase()
    const result = await impl_updateChild(CHILD_ID, { birth_date: '2026-10-08' }, supabase)
    expect(result.status).toBe('validation_error')
  })

  it('blank full_name → validation_error', async () => {
    const supabase = makeMockSupabase()
    const result = await impl_updateChild(CHILD_ID, { full_name: '  ' }, supabase)
    expect(result).toEqual({ status: 'validation_error', field_errors: { full_name: 'Required' } })
  })

  it('child missing / soft-deleted → not_found, no update, no audit', async () => {
    const supabase = makeMockSupabase([{ data: null }])
    const result = await impl_updateChild(CHILD_ID, { notes: 'x' }, supabase)
    expect(result).toEqual({ status: 'not_found' })
    expect(supabase._builder.update).not.toHaveBeenCalled()
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('malformed id → not_found', async () => {
    const supabase = makeMockSupabase()
    expect(await impl_updateChild('bad', { notes: 'x' }, supabase)).toEqual({ status: 'not_found' })
  })

  it('RLS denial (42501) → forbidden', async () => {
    const supabase = makeMockSupabase([{ data: MOCK_CHILD }, { error: RLS_DENIED }])
    const result = await impl_updateChild(CHILD_ID, { notes: 'x' }, supabase)
    expect(result.status).toBe('forbidden')
    expect(supabase.rpc).not.toHaveBeenCalled()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// softDeleteChild
// ────────────────────────────────────────────────────────────────────────────

describe('impl_softDeleteChild', () => {
  it('sets deleted_at + updated_at; audit IDs-only', async () => {
    const supabase = makeMockSupabase([
      { data: { id: CHILD_ID, parent_person_id: PARENT_ID } },
      { count: 1 },
    ])
    const result = await impl_softDeleteChild(CHILD_ID, supabase)
    expect(result).toEqual({ status: 'soft_deleted', id: CHILD_ID })

    const [patch, opts] = supabase._builder.update.mock.calls[0]
    expect(typeof patch.deleted_at).toBe('string')
    expect(patch.updated_at).toBe(patch.deleted_at)
    expect(opts).toEqual({ count: 'exact' })

    expect(supabase.rpc).toHaveBeenCalledWith('log_audit', expect.objectContaining({
      p_action: AUDIT_ACTIONS.CHILD_SOFT_DELETE, p_entity_id: CHILD_ID,
    }))
    expect(auditDetails(supabase)).toEqual({ child_id: CHILD_ID, parent_id: PARENT_ID })
  })

  it('already soft-deleted / missing → not_found', async () => {
    const supabase = makeMockSupabase([{ data: null }])
    expect(await impl_softDeleteChild(CHILD_ID, supabase)).toEqual({ status: 'not_found' })
    expect(supabase._builder.update).not.toHaveBeenCalled()
  })

  it('RLS denial (organizer) → forbidden, no audit', async () => {
    const supabase = makeMockSupabase([
      { data: { id: CHILD_ID, parent_person_id: PARENT_ID } },
      { error: RLS_DENIED },
    ])
    const result = await impl_softDeleteChild(CHILD_ID, supabase)
    expect(result.status).toBe('forbidden')
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('zero rows updated (race) → not_found, no audit', async () => {
    const supabase = makeMockSupabase([
      { data: { id: CHILD_ID, parent_person_id: PARENT_ID } },
      { count: 0 },
    ])
    expect(await impl_softDeleteChild(CHILD_ID, supabase)).toEqual({ status: 'not_found' })
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('no session → forbidden', async () => {
    const supabase = makeMockSupabase([], null)
    expect((await impl_softDeleteChild(CHILD_ID, supabase)).status).toBe('forbidden')
  })
})
