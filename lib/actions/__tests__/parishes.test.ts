import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { impl_searchParishes, impl_createPendingParish } from '../parishes.impl'
import { AUDIT_ACTIONS } from '../../audit'

// ────────────────────────────────────────────────────────────────────────────
// Mock factory
//
// Two response queues:
//   singleResponses — consumed by .single() calls (insert, TOCTOU conflict lookup)
//   directResponses — consumed when the builder is awaited directly (search query,
//                     dup pre-check via .limit(1))
//
// Making the builder "thenable" lets `await supabase.from(...).select(...).limit(n)`
// resolve without needing an explicit terminal method.
// ────────────────────────────────────────────────────────────────────────────

const ACTOR_ID = 'actor-uuid-parishes'
const PGRST116 = { code: 'PGRST116', message: 'no rows' }

type MockResponse = { data: unknown; error: unknown }

function makeMockBuilder(
  singleResponses: MockResponse[] = [],
  directResponses: MockResponse[] = [],
) {
  let sIdx = 0
  let dIdx = 0

  const single = vi.fn().mockImplementation(() => {
    const r = singleResponses[sIdx] ?? { data: null, error: PGRST116 }
    sIdx++
    return Promise.resolve(r)
  })

  const builder = {
    select:      vi.fn().mockReturnThis(),
    insert:      vi.fn().mockReturnThis(),
    eq:          vi.fn().mockReturnThis(),
    ilike:       vi.fn().mockReturnThis(),
    order:       vi.fn().mockReturnThis(),
    limit:       vi.fn().mockReturnThis(),
    single,
    // Makes the builder thenable so `await builder` resolves to the next direct response
    then(
      resolve: (v: MockResponse) => unknown,
      reject?: (e: unknown) => unknown,
    ) {
      const r = directResponses[dIdx] ?? { data: [], error: null }
      dIdx++
      return Promise.resolve(r).then(resolve, reject)
    },
  }
  return builder
}

type MockSupabase = SupabaseClient & {
  _builder: ReturnType<typeof makeMockBuilder>
  rpc:      ReturnType<typeof vi.fn>
  from:     ReturnType<typeof vi.fn>
}

function makeMockSupabase(
  singleResponses: MockResponse[] = [],
  directResponses: MockResponse[] = [],
  rpcResponse: MockResponse = { data: null, error: null },
  userId: string | null = ACTOR_ID,
): MockSupabase {
  const builder = makeMockBuilder(singleResponses, directResponses)
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: userId ? { id: userId } : null },
        error: null,
      }),
    },
    from: vi.fn().mockReturnValue(builder),
    rpc:  vi.fn().mockResolvedValue(rpcResponse),
    _builder: builder,
  } as unknown as MockSupabase
}

// Sample fixture
const MOCK_PARISH: MockResponse['data'] = {
  id:     'parish-uuid-1',
  name:   'Paroki Santa Maria',
  city:   'Jakarta',
  region: 'Jakarta Selatan',
  status: 'approved',
}

// ────────────────────────────────────────────────────────────────────────────
// impl_searchParishes
// ────────────────────────────────────────────────────────────────────────────

describe('impl_searchParishes', () => {
  it('empty query: returns success, orders by created_at DESC, does NOT call ilike', async () => {
    const supabase = makeMockSupabase([], [{ data: [MOCK_PARISH], error: null }])
    const result = await impl_searchParishes('', {}, supabase)

    expect(result.status).toBe('success')
    if (result.status !== 'success') return
    expect(result.parishes).toHaveLength(1)

    expect(supabase._builder.ilike).not.toHaveBeenCalled()
    expect(supabase._builder.order).toHaveBeenCalledWith('created_at', { ascending: false })
  })

  it('non-empty query: returns success, calls ilike with %query%, orders by name ASC', async () => {
    const supabase = makeMockSupabase([], [{ data: [MOCK_PARISH], error: null }])
    const result = await impl_searchParishes('  santa  ', {}, supabase)

    expect(result.status).toBe('success')
    expect(supabase._builder.ilike).toHaveBeenCalledWith('name', '%santa%')
    expect(supabase._builder.order).toHaveBeenCalledWith('name', { ascending: true })
  })

  it('includePending=false: calls eq("status", "approved")', async () => {
    const supabase = makeMockSupabase([], [{ data: [], error: null }])
    await impl_searchParishes('', { includePending: false }, supabase)

    expect(supabase._builder.eq).toHaveBeenCalledWith('status', 'approved')
  })

  it('DB error: returns { status: "error" }', async () => {
    const supabase = makeMockSupabase([], [{ data: null, error: { code: '500', message: 'DB down' } }])
    const result = await impl_searchParishes('', {}, supabase)

    expect(result.status).toBe('error')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// impl_createPendingParish
// ────────────────────────────────────────────────────────────────────────────

describe('impl_createPendingParish', () => {
  const VALID_INPUT = { name: 'Paroki Santo Yusuf', city: 'Bekasi', region: 'Bekasi Utara' }

  it('happy path: returns created, calls log_audit with PARISH_CREATE and entityType parishes', async () => {
    const supabase = makeMockSupabase(
      [{ data: MOCK_PARISH, error: null }],     // singleResponses: insert
      [{ data: [],          error: null }],     // directResponses: dup check → no match
    )
    const result = await impl_createPendingParish(VALID_INPUT, supabase)

    expect(result.status).toBe('created')
    expect(supabase.rpc).toHaveBeenCalledWith('log_audit', expect.objectContaining({
      p_action:      AUDIT_ACTIONS.PARISH_CREATE,
      p_entity_type: 'parishes',
    }))
  })

  it('validation_error on whitespace-only name — no DB call', async () => {
    const supabase = makeMockSupabase()
    const result = await impl_createPendingParish({ name: '   ' }, supabase)

    expect(result.status).toBe('validation_error')
    if (result.status !== 'validation_error') return
    expect(result.field_errors).toHaveProperty('name')
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('pre-check finds existing parish → duplicate, no INSERT', async () => {
    const supabase = makeMockSupabase(
      [],                                                       // singleResponses: not used
      [{ data: [{ id: 'p1', name: 'PAROKI SANTA MARIA', status: 'pending' }], error: null }], // dup found
    )
    const result = await impl_createPendingParish({ name: 'Paroki Santa Maria' }, supabase)

    expect(result.status).toBe('duplicate')
    if (result.status !== 'duplicate') return
    expect(result.existing.id).toBe('p1')
    expect(result.existing.name).toBe('PAROKI SANTA MARIA')

    // No INSERT should have been attempted
    expect(supabase._builder.insert).not.toHaveBeenCalled()
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('23505 unique_violation on INSERT (TOCTOU race) → duplicate with conflicting row id', async () => {
    const supabase = makeMockSupabase(
      [
        { data: null, error: { code: '23505', message: 'unique violation' } }, // insert fails
        { data: { id: 'winner-id', name: 'Paroki Santo Yusuf', status: 'pending' }, error: null }, // conflict lookup
      ],
      [{ data: [], error: null }],  // dup pre-check: clear
    )
    const result = await impl_createPendingParish(VALID_INPUT, supabase)

    expect(result.status).toBe('duplicate')
    if (result.status !== 'duplicate') return
    expect(result.existing.id).toBe('winner-id')
    expect(supabase.rpc).not.toHaveBeenCalled()
  })
})
