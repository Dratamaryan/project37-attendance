import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { impl_listPeople } from '../people.impl'

// ── Mock photos.impl so we don't need real storage ───────────────────────────
vi.mock('@/lib/storage/photos.impl', () => ({
  impl_getPhotoSignedUrl: vi.fn().mockResolvedValue({ status: 'no_photo' }),
}))

import { impl_getPhotoSignedUrl } from '@/lib/storage/photos.impl'
const mockGetSignedUrl = vi.mocked(impl_getPhotoSignedUrl)

// ── Fixtures ──────────────────────────────────────────────────────────────────
const ACTOR_ID = 'admin-uuid-0001'

const MOCK_PERSON = {
  id: 'person-001',
  phone_e164: '+6281234567890',
  full_name: 'Ryan Dratama',
  nickname: 'Ryan',
  origin_parish: 'Jakarta Selatan',
  photo_url: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  deleted_at: null,
}

// ── Mock builder helpers ─────────────────────────────────────────────────────

// For queries that use .single() — role lookup
function makeSingleBuilder(response: { data: unknown; error: unknown }) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue(response),
  }
}

// For paginated list queries — chain returns `this` and the object is thenable.
// count: 'exact' is a select option so the response has { data, error, count }.
function makePaginatedBuilder(response: { data: unknown; error: unknown; count: number | null }) {
  const promise = Promise.resolve(response)
  const builder = Object.assign(promise, {
    select: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    range: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    ilike: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
  })
  return builder
}

type PaginatedBuilder = ReturnType<typeof makePaginatedBuilder>

type MockSetup = {
  supabase: {
    auth: { getUser: ReturnType<typeof vi.fn> }
    from: ReturnType<typeof vi.fn>
  }
  peopleBuilder: PaginatedBuilder
}

function makeSupabase({
  userId = ACTOR_ID as string | null,
  role = 'admin',
  active = true,
  queryResult = { data: [MOCK_PERSON], error: null, count: 1 },
}: {
  userId?: string | null
  role?: string | null
  active?: boolean
  queryResult?: { data: unknown; error: unknown; count: number | null }
} = {}): MockSetup {
  const roleBuilder = makeSingleBuilder(
    role !== null
      ? { data: { role, active }, error: null }
      : { data: null, error: { code: 'PGRST116' } }
  )
  const peopleBuilder = makePaginatedBuilder(queryResult)

  const supabase = {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: userId ? { id: userId } : null },
      }),
    },
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'app_users') return roleBuilder
      if (table === 'people') return peopleBuilder
      return {}
    }),
  }

  return { supabase, peopleBuilder }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('impl_listPeople', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSignedUrl.mockResolvedValue({ status: 'no_photo' })
  })

  it('returns ok status with people array and total count', async () => {
    const { supabase } = makeSupabase()
    const result = await impl_listPeople({}, supabase as unknown as SupabaseClient)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.people).toHaveLength(1)
    expect(result.people[0].id).toBe('person-001')
    expect(result.total).toBe(1)
  })

  it('uses default page=1, page_size=25 when not specified', async () => {
    const { supabase, peopleBuilder } = makeSupabase()
    const result = await impl_listPeople({}, supabase as unknown as SupabaseClient)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.page).toBe(1)
    expect(result.page_size).toBe(25)
    expect(peopleBuilder.range).toHaveBeenCalledWith(0, 24)
  })

  it('rejects page_size > 100', async () => {
    const { supabase } = makeSupabase()
    const result = await impl_listPeople({ page_size: 101 }, supabase as unknown as SupabaseClient)
    expect(result.status).toBe('error')
    if (result.status !== 'error') return
    expect(result.message).toMatch(/100/)
  })

  it('search by name uses OR filter on full_name and nickname', async () => {
    const { supabase, peopleBuilder } = makeSupabase()
    const result = await impl_listPeople({ query: 'Ryan' }, supabase as unknown as SupabaseClient)
    expect(result.status).toBe('ok')
    expect(peopleBuilder.or).toHaveBeenCalledWith(
      'full_name.ilike.%Ryan%,nickname.ilike.%Ryan%'
    )
    expect(peopleBuilder.ilike).not.toHaveBeenCalled()
  })

  it('search by phone uses ILIKE on phone_e164 when input is digits-only', async () => {
    const { supabase, peopleBuilder } = makeSupabase()
    const result = await impl_listPeople({ query: '+6282' }, supabase as unknown as SupabaseClient)
    expect(result.status).toBe('ok')
    expect(peopleBuilder.ilike).toHaveBeenCalledWith('phone_e164', '%+6282%')
    expect(peopleBuilder.or).not.toHaveBeenCalled()
  })

  it('include_deleted=false adds deleted_at IS NULL filter', async () => {
    const { supabase, peopleBuilder } = makeSupabase()
    await impl_listPeople({ include_deleted: false }, supabase as unknown as SupabaseClient)
    expect(peopleBuilder.is).toHaveBeenCalledWith('deleted_at', null)
  })

  it('include_deleted=true does NOT add deleted_at IS NULL filter', async () => {
    const { supabase, peopleBuilder } = makeSupabase()
    await impl_listPeople({ include_deleted: true }, supabase as unknown as SupabaseClient)
    expect(peopleBuilder.is).not.toHaveBeenCalled()
  })

  it('returns not_authorized when caller is not admin', async () => {
    const { supabase } = makeSupabase({ role: 'organizer' })
    const result = await impl_listPeople({}, supabase as unknown as SupabaseClient)
    expect(result.status).toBe('not_authorized')
  })

  it('returns not_authorized when caller is an admin but active=false (deactivated)', async () => {
    const { supabase } = makeSupabase({ role: 'admin', active: false })
    const result = await impl_listPeople({}, supabase as unknown as SupabaseClient)
    expect(result.status).toBe('not_authorized')
  })

  it('returns not_authorized when no session', async () => {
    const { supabase } = makeSupabase({ userId: null })
    const result = await impl_listPeople({}, supabase as unknown as SupabaseClient)
    expect(result.status).toBe('not_authorized')
  })

  it('returns error status when DB query fails', async () => {
    const { supabase } = makeSupabase({
      queryResult: { data: null, error: { code: 'PGRST000', message: 'connection error' }, count: null },
    })
    const result = await impl_listPeople({}, supabase as unknown as SupabaseClient)
    expect(result.status).toBe('error')
  })
})
