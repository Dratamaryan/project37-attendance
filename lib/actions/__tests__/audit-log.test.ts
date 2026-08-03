import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { impl_listAuditLog } from '../audit-log.impl'

const requireActiveAdminMock = vi.fn()
vi.mock('@/lib/auth/require-admin', () => ({
  requireActiveAdmin: (...args: unknown[]) => requireActiveAdminMock(...args),
}))

const ACTOR_ID = 'actor-uuid-audit-log'

type MockResponse = { data: unknown; error: unknown; count?: number | null }

// Builds a thenable query-builder mock. `head` distinguishes the count-only
// query (impl_listAuditLog issues two separate `.from('audit_log')` calls —
// the main select and a head:true count — so `from` needs to route each to
// its own response).
function makeMockBuilder(response: MockResponse) {
  const builder = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    gte: vi.fn().mockReturnThis(),
    lt: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then(resolve: (v: MockResponse) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve(response).then(resolve, reject)
    },
  }
  return builder
}

function makeMockSupabase({
  mainResponse,
  countResponse,
}: {
  mainResponse: MockResponse
  countResponse: MockResponse
}) {
  const mainBuilder = makeMockBuilder(mainResponse)
  const countBuilder = makeMockBuilder(countResponse)
  let callCount = 0

  const from = vi.fn().mockImplementation(() => {
    callCount++
    // impl_listAuditLog builds the main (paginated) query first, the
    // count-only query second — same call order every invocation.
    return callCount === 1 ? mainBuilder : countBuilder
  })

  return {
    supabase: { from } as unknown as SupabaseClient,
    mainBuilder,
    countBuilder,
    from,
  }
}

beforeEach(() => {
  requireActiveAdminMock.mockReset()
  requireActiveAdminMock.mockResolvedValue({ status: 'ok', actorId: ACTOR_ID, role: 'admin' })
})

const ROW = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 10,
  action: 'settings.update',
  entity_type: 'app_settings',
  entity_id: '1',
  details_json: { default_language: { from: 'id', to: 'en' } },
  created_at: '2026-08-01T10:00:00.123456+00:00',
  actor_user_id: ACTOR_ID,
  actor: { full_name: 'Test Admin', email: 'admin@test.invalid' },
  ...overrides,
})

describe('impl_listAuditLog — privilege gate', () => {
  it('not_authorized: short-circuits before any DB call', async () => {
    requireActiveAdminMock.mockResolvedValue({ status: 'denied' })
    const { supabase, from } = makeMockSupabase({
      mainResponse: { data: [], error: null },
      countResponse: { data: null, error: null, count: 0 },
    })

    const result = await impl_listAuditLog({}, supabase)
    expect(result).toEqual({ status: 'not_authorized' })
    expect(from).not.toHaveBeenCalled()
  })
})

describe('impl_listAuditLog — actor resolution', () => {
  it('actor_user_id set + embed resolves: kind "resolved" with name/email', async () => {
    const { supabase } = makeMockSupabase({
      mainResponse: { data: [ROW()], error: null },
      countResponse: { data: null, error: null, count: 1 },
    })
    const result = await impl_listAuditLog({}, supabase)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.rows[0].actor).toEqual({
      kind: 'resolved',
      fullName: 'Test Admin',
      email: 'admin@test.invalid',
    })
  })

  it('actor_user_id null (cron/system row): kind "system"', async () => {
    const { supabase } = makeMockSupabase({
      mainResponse: { data: [ROW({ actor_user_id: null, actor: null })], error: null },
      countResponse: { data: null, error: null, count: 1 },
    })
    const result = await impl_listAuditLog({}, supabase)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.rows[0].actor).toEqual({ kind: 'system' })
  })

  it('actor_user_id set but embed null (dangling/unresolved actor): kind "unresolved", carries the id', async () => {
    const { supabase } = makeMockSupabase({
      mainResponse: { data: [ROW({ actor_user_id: 'ghost-uuid', actor: null })], error: null },
      countResponse: { data: null, error: null, count: 1 },
    })
    const result = await impl_listAuditLog({}, supabase)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.rows[0].actor).toEqual({ kind: 'unresolved', actorUserId: 'ghost-uuid' })
  })
})

describe('impl_listAuditLog — filters', () => {
  it('applies actor/action/entityType/from/to filters via eq/gte/lt on both the data and count queries', async () => {
    const { supabase, mainBuilder, countBuilder } = makeMockSupabase({
      mainResponse: { data: [], error: null },
      countResponse: { data: null, error: null, count: 0 },
    })

    await impl_listAuditLog(
      {
        filters: {
          actorUserId: 'user-1',
          action: 'settings.update',
          entityType: 'app_settings',
          from: '2026-07-01',
          to: '2026-07-31',
        },
      },
      supabase,
    )

    for (const builder of [mainBuilder, countBuilder]) {
      expect(builder.eq).toHaveBeenCalledWith('actor_user_id', 'user-1')
      expect(builder.eq).toHaveBeenCalledWith('action', 'settings.update')
      expect(builder.eq).toHaveBeenCalledWith('entity_type', 'app_settings')
      expect(builder.gte).toHaveBeenCalledWith('created_at', '2026-07-01')
      // to-date is exclusive-upper-bound on the day AFTER (nextDay), matching
      // export.impl.ts's from/to convention.
      expect(builder.lt).toHaveBeenCalledWith('created_at', '2026-08-01')
    }
  })

  it('count query uses head:true (no rows fetched, just the count)', async () => {
    const { supabase, countBuilder } = makeMockSupabase({
      mainResponse: { data: [], error: null },
      countResponse: { data: null, error: null, count: 0 },
    })
    await impl_listAuditLog({}, supabase)
    expect(countBuilder.select).toHaveBeenCalledWith('id', { count: 'exact', head: true })
  })
})

describe('impl_listAuditLog — cursor + pagination boundary', () => {
  it('no cursor: .or() is never called', async () => {
    const { supabase, mainBuilder } = makeMockSupabase({
      mainResponse: { data: [], error: null },
      countResponse: { data: null, error: null, count: 0 },
    })
    await impl_listAuditLog({}, supabase)
    expect(mainBuilder.or).not.toHaveBeenCalled()
  })

  it('cursor present: .or() called with the RAW createdAt string verbatim (no Date reparse)', async () => {
    const { supabase, mainBuilder } = makeMockSupabase({
      mainResponse: { data: [], error: null },
      countResponse: { data: null, error: null, count: 0 },
    })
    const cursor = { createdAt: '2026-08-01T10:00:00.123456+00:00', id: 42 }
    await impl_listAuditLog({ cursor }, supabase)
    expect(mainBuilder.or).toHaveBeenCalledWith(
      'created_at.lt.2026-08-01T10:00:00.123456+00:00,' +
        'and(created_at.eq.2026-08-01T10:00:00.123456+00:00,id.lt.42)',
    )
  })

  it('page fills exactly pageSize+1 from DB: trims to pageSize, nextCursor set from the last TRIMMED row', async () => {
    const rows = [ROW({ id: 3 }), ROW({ id: 2 }), ROW({ id: 1 })]
    const { supabase } = makeMockSupabase({
      mainResponse: { data: rows, error: null },
      countResponse: { data: null, error: null, count: 3 },
    })
    const result = await impl_listAuditLog({ pageSize: 2 }, supabase)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.rows).toHaveLength(2)
    expect(result.rows.map(r => r.id)).toEqual([3, 2])
    expect(result.nextCursor).toEqual({ createdAt: ROW({ id: 2 }).created_at, id: 2 })
  })

  it('page returns <= pageSize rows: no trimming, nextCursor null (last page)', async () => {
    const rows = [ROW({ id: 2 }), ROW({ id: 1 })]
    const { supabase } = makeMockSupabase({
      mainResponse: { data: rows, error: null },
      countResponse: { data: null, error: null, count: 2 },
    })
    const result = await impl_listAuditLog({ pageSize: 5 }, supabase)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.rows).toHaveLength(2)
    expect(result.nextCursor).toBeNull()
  })

  it('pageSize is clamped to the DEFAULT_PAGE_SIZE ceiling even if a caller asks for more', async () => {
    const { supabase, mainBuilder } = makeMockSupabase({
      mainResponse: { data: [], error: null },
      countResponse: { data: null, error: null, count: 0 },
    })
    await impl_listAuditLog({ pageSize: 5000 }, supabase)
    expect(mainBuilder.limit).toHaveBeenCalledWith(501) // DEFAULT_PAGE_SIZE (500) + 1
  })

  it('total reflects the count-only query, NOT the length of the returned page', async () => {
    const rows = [ROW({ id: 1 })]
    const { supabase } = makeMockSupabase({
      mainResponse: { data: rows, error: null },
      countResponse: { data: null, error: null, count: 176 },
    })
    const result = await impl_listAuditLog({}, supabase)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.total).toBe(176)
  })
})

describe('impl_listAuditLog — error paths', () => {
  it('main query error: returns status error', async () => {
    const { supabase } = makeMockSupabase({
      mainResponse: { data: null, error: { message: 'db down' } },
      countResponse: { data: null, error: null, count: 0 },
    })
    const result = await impl_listAuditLog({}, supabase)
    expect(result.status).toBe('error')
  })

  it('count query error: returns status error', async () => {
    const { supabase } = makeMockSupabase({
      mainResponse: { data: [], error: null },
      countResponse: { data: null, error: { message: 'count failed' }, count: null },
    })
    const result = await impl_listAuditLog({}, supabase)
    expect(result.status).toBe('error')
  })
})
