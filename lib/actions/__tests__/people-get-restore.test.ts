import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { impl_getPersonById, impl_restorePerson } from '../people.impl'
import { AUDIT_ACTIONS } from '../../audit'

// ── Mock factory (mirrors pattern from people.test.ts) ──────────────────────

const ACTOR_ID = 'admin-uuid-abcd'
const PGRST116 = { code: 'PGRST116', message: 'no rows' }

type MockResponse = { data: unknown; error: unknown }

function makeMockBuilder(responses: MockResponse[]) {
  let idx = 0
  const single = vi.fn().mockImplementation(() => {
    const r = responses[idx] ?? { data: null, error: PGRST116 }
    idx++
    return Promise.resolve(r)
  })
  return {
    select: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    eq:     vi.fn().mockReturnThis(),
    is:     vi.fn().mockReturnThis(),
    single,
  }
}

type MockSupabase = SupabaseClient & {
  _builder: ReturnType<typeof makeMockBuilder>
  rpc:      ReturnType<typeof vi.fn>
  from:     ReturnType<typeof vi.fn>
}

function makeMockSupabase(
  singleResponses: MockResponse[] = [],
  rpcResponse: MockResponse = { data: null, error: null },
  userId: string | null = ACTOR_ID,
): MockSupabase {
  const builder = makeMockBuilder(singleResponses)
  const mock = {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: userId ? { id: userId } : null },
        error: null,
      }),
    },
    from: vi.fn().mockReturnValue(builder),
    rpc:  vi.fn().mockResolvedValue(rpcResponse),
    _builder: builder,
  }
  return mock as unknown as MockSupabase
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FULL_PERSON = {
  id:                    'person-001',
  phone_e164:            '+6281234567890',
  full_name:             'Ryan Dratama',
  nickname:              'Ryan',
  email:                 null,
  birth_place:           null,
  birth_date:            '1990-01-01',
  gender:                'male',
  origin_parish:         null,
  marital_status:        null,
  kepanitiaan:           'Member',
  tribe:                 'Daniel',
  notes:                 null,
  current_city:          null,
  current_area:          null,
  photo_url:             null,
  photo_publish_consent: false,
  photo_consent_at:      null,
  photo_consent_version: null,
  created_at:            '2026-01-01T00:00:00Z',
  updated_at:            '2026-01-01T00:00:00Z',
  deleted_at:            null,
}

const ADMIN_ROLE = { data: { role: 'admin', active: true }, error: null }
const NON_ADMIN_ROLE = { data: { role: 'organizer', active: true }, error: null }
const DEACTIVATED_ADMIN_ROLE = { data: { role: 'admin', active: false }, error: null }

// ── impl_getPersonById ────────────────────────────────────────────────────────

describe('impl_getPersonById', () => {
  it('returns ok with full person when found', async () => {
    const supabase = makeMockSupabase([
      ADMIN_ROLE,
      { data: FULL_PERSON, error: null },
    ])
    const result = await impl_getPersonById('person-001', supabase)
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.person.id).toBe('person-001')
      expect(result.person.kepanitiaan).toBe('Member')
      expect(result.person.tribe).toBe('Daniel')
    }
  })

  it('returns not_found when row missing', async () => {
    const supabase = makeMockSupabase([
      ADMIN_ROLE,
      { data: null, error: PGRST116 },
    ])
    const result = await impl_getPersonById('nonexistent', supabase)
    expect(result.status).toBe('not_found')
  })

  it('returns not_authorized when caller is not admin', async () => {
    const supabase = makeMockSupabase([NON_ADMIN_ROLE])
    const result = await impl_getPersonById('person-001', supabase)
    expect(result.status).toBe('not_authorized')
  })

  it('returns not_authorized when caller is an admin but active=false (deactivated)', async () => {
    const supabase = makeMockSupabase([DEACTIVATED_ADMIN_ROLE])
    const result = await impl_getPersonById('person-001', supabase)
    expect(result.status).toBe('not_authorized')
  })

  it('returns error on unexpected DB error', async () => {
    const supabase = makeMockSupabase([
      ADMIN_ROLE,
      { data: null, error: { code: '42P01', message: 'table missing' } },
    ])
    const result = await impl_getPersonById('person-001', supabase)
    expect(result.status).toBe('error')
  })
})

// ── impl_restorePerson ────────────────────────────────────────────────────────

describe('impl_restorePerson', () => {
  it('happy path: sets deleted_at to NULL and logs PEOPLE_RESTORE audit', async () => {
    const supabase = makeMockSupabase(
      [ADMIN_ROLE, { data: { id: 'person-001' }, error: null }],
      { data: null, error: null },
    )
    const result = await impl_restorePerson('person-001', supabase)
    expect(result.status).toBe('restored')
    expect(supabase.rpc).toHaveBeenCalledWith('log_audit', expect.objectContaining({
      p_action:    AUDIT_ACTIONS.PEOPLE_RESTORE,
      p_entity_id: 'person-001',
    }))
  })

  it('returns not_found when row missing (PGRST116)', async () => {
    const supabase = makeMockSupabase([
      ADMIN_ROLE,
      { data: null, error: PGRST116 },
    ])
    const result = await impl_restorePerson('nonexistent', supabase)
    expect(result.status).toBe('not_found')
  })

  it('returns not_authorized when caller is not admin', async () => {
    const supabase = makeMockSupabase([NON_ADMIN_ROLE])
    const result = await impl_restorePerson('person-001', supabase)
    expect(result.status).toBe('not_authorized')
  })

  it('returns not_authorized when caller is an admin but active=false (deactivated)', async () => {
    const supabase = makeMockSupabase([DEACTIVATED_ADMIN_ROLE])
    const result = await impl_restorePerson('person-001', supabase)
    expect(result.status).toBe('not_authorized')
  })

  it('is idempotent: restoring an already-active person returns restored', async () => {
    // Person is not deleted — deleted_at is null — but update still succeeds
    // because impl_restorePerson has no is('deleted_at', null) filter.
    const supabase = makeMockSupabase(
      [ADMIN_ROLE, { data: { id: 'person-001' }, error: null }],
      { data: null, error: null },
    )
    const result = await impl_restorePerson('person-001', supabase)
    expect(result.status).toBe('restored')
  })
})
