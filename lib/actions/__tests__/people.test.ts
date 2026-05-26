import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  impl_lookupByPhone,
  impl_createPerson,
  impl_updatePerson,
  impl_softDeletePerson,
  impl_setPhotoConsent,
} from '../people.impl'
import { AUDIT_ACTIONS } from '../../audit'

// ────────────────────────────────────────────────────────────────────────────
// Mock factory
//
// makeMockBuilder returns a Supabase query builder where every chainable method
// returns `this`. The terminal `.single()` consumes responses sequentially from
// the array passed in — this handles multiple `from()` calls in one action
// (dup-check SELECT, INSERT, app_settings SELECT, etc.) using one shared mock.
// ────────────────────────────────────────────────────────────────────────────

const ACTOR_ID = 'actor-uuid-1234'
const PGRST116 = { code: 'PGRST116', message: 'no rows' }

type MockResponse = { data: unknown; error: unknown }

function makeMockBuilder(responses: MockResponse[]) {
  let idx = 0
  const single = vi.fn().mockImplementation(() => {
    const r = responses[idx] ?? { data: null, error: PGRST116 }
    idx++
    return Promise.resolve(r)
  })

  const builder = {
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    eq:     vi.fn().mockReturnThis(),
    is:     vi.fn().mockReturnThis(),
    single,
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

// Shared mock person shape matching PersonSummary
const MOCK_PERSON = {
  id:                   'person-uuid-1',
  phone_e164:           '+6281234567890',
  full_name:            'Budi Santoso',
  nickname:             'Budi',
  email:                'budi@example.com',
  birth_date:           '1990-01-15',
  gender:               'male',
  origin_parish:        null,
  marital_status:       null,
  photo_url:            null,
  photo_publish_consent: false,
  created_at:           '2026-05-26T00:00:00Z',
}

// ────────────────────────────────────────────────────────────────────────────
// lookupByPhone
// ────────────────────────────────────────────────────────────────────────────

describe('impl_lookupByPhone', () => {
  it('returns invalid_phone for empty string — no DB call made', async () => {
    const supabase = makeMockSupabase()
    const result = await impl_lookupByPhone('', 'ID', supabase)
    expect(result.status).toBe('invalid_phone')
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('returns invalid_phone for junk input — no DB call made', async () => {
    const supabase = makeMockSupabase()
    const result = await impl_lookupByPhone('not-a-phone!!', 'ID', supabase)
    expect(result.status).toBe('invalid_phone')
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('returns found with PersonSummary when DB row exists', async () => {
    const supabase = makeMockSupabase([{ data: MOCK_PERSON, error: null }])
    const result = await impl_lookupByPhone('081234567890', 'ID', supabase)
    expect(result.status).toBe('found')
    if (result.status !== 'found') return
    expect(result.person.id).toBe(MOCK_PERSON.id)
    expect(result.person.phone_e164).toBe(MOCK_PERSON.phone_e164)
  })

  it('returns not_found with normalized_e164 when DB returns PGRST116', async () => {
    const supabase = makeMockSupabase([{ data: null, error: PGRST116 }])
    const result = await impl_lookupByPhone('081234567890', 'ID', supabase)
    expect(result.status).toBe('not_found')
    if (result.status !== 'not_found') return
    expect(result.normalized_e164).toMatch(/^\+62/)
  })

  it('returns error on unexpected DB error', async () => {
    const supabase = makeMockSupabase([{ data: null, error: { code: '500', message: 'DB down' } }])
    const result = await impl_lookupByPhone('081234567890', 'ID', supabase)
    expect(result.status).toBe('error')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// createPerson
// ────────────────────────────────────────────────────────────────────────────

describe('impl_createPerson', () => {
  const VALID_INPUT = {
    phone_e164_raw: '081234567890',
    country:        'ID' as const,
    full_name:      'Budi Santoso',
    nickname:       'Budi',
    birth_date:     '1990-01-15',
  }

  it('happy path: returns created person; calls log_audit with PEOPLE_CREATE and entityId', async () => {
    const supabase = makeMockSupabase([
      { data: null,        error: PGRST116 }, // dup check: no match
      { data: MOCK_PERSON, error: null },     // insert
    ])
    const result = await impl_createPerson(VALID_INPUT, supabase)
    expect(result.status).toBe('created')
    if (result.status !== 'created') return
    expect(result.person.id).toBe(MOCK_PERSON.id)

    expect(supabase.rpc).toHaveBeenCalledWith('log_audit', expect.objectContaining({
      p_action:    AUDIT_ACTIONS.PEOPLE_CREATE,
      p_entity_id: MOCK_PERSON.id,
    }))
  })

  it('returns validation_error for invalid phone — no DB call', async () => {
    const supabase = makeMockSupabase()
    const result = await impl_createPerson({ ...VALID_INPUT, phone_e164_raw: 'bad' }, supabase)
    expect(result.status).toBe('validation_error')
    if (result.status !== 'validation_error') return
    expect(result.field_errors).toHaveProperty('phone_e164_raw')
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('returns validation_error for empty full_name', async () => {
    const supabase = makeMockSupabase()
    const result = await impl_createPerson({ ...VALID_INPUT, full_name: '   ' }, supabase)
    expect(result.status).toBe('validation_error')
    if (result.status !== 'validation_error') return
    expect(result.field_errors).toHaveProperty('full_name')
  })

  it('returns validation_error for empty nickname', async () => {
    const supabase = makeMockSupabase()
    const result = await impl_createPerson({ ...VALID_INPUT, nickname: '' }, supabase)
    expect(result.status).toBe('validation_error')
    if (result.status !== 'validation_error') return
    expect(result.field_errors).toHaveProperty('nickname')
  })

  it('returns validation_error for missing birth_date', async () => {
    const supabase = makeMockSupabase()
    const result = await impl_createPerson({ ...VALID_INPUT, birth_date: '' }, supabase)
    expect(result.status).toBe('validation_error')
    if (result.status !== 'validation_error') return
    expect(result.field_errors).toHaveProperty('birth_date')
  })

  it('returns duplicate_phone when pre-check finds existing active person', async () => {
    const supabase = makeMockSupabase([
      { data: { id: 'existing-id', full_name: 'Other Person' }, error: null },
    ])
    const result = await impl_createPerson(VALID_INPUT, supabase)
    expect(result.status).toBe('duplicate_phone')
    if (result.status !== 'duplicate_phone') return
    expect(result.existing.id).toBe('existing-id')
    expect(result.existing.full_name).toBe('Other Person')
  })

  it('returns duplicate_phone on 23505 unique_violation (TOCTOU race)', async () => {
    const supabase = makeMockSupabase([
      { data: null,                               error: PGRST116 },                           // dup check: clear
      { data: null,                               error: { code: '23505', message: 'dup' } },  // insert fails
      { data: { id: 'racer-id', full_name: 'Racer' }, error: null },                          // fetch conflicting
    ])
    const result = await impl_createPerson(VALID_INPUT, supabase)
    expect(result.status).toBe('duplicate_phone')
    if (result.status !== 'duplicate_phone') return
    expect(result.existing.id).toBe('racer-id')
  })

  it('does NOT call log_audit when result is duplicate_phone', async () => {
    const supabase = makeMockSupabase([
      { data: { id: 'existing-id', full_name: 'Other' }, error: null },
    ])
    await impl_createPerson(VALID_INPUT, supabase)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('does NOT call log_audit when result is validation_error', async () => {
    const supabase = makeMockSupabase()
    await impl_createPerson({ ...VALID_INPUT, full_name: '' }, supabase)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('audit details contain phone_e164 + full_name + has_photo but NOT birth_date or email', async () => {
    const supabase = makeMockSupabase([
      { data: null,        error: PGRST116 },
      { data: MOCK_PERSON, error: null },
    ])
    await impl_createPerson({ ...VALID_INPUT, photo_url: 'storage/photo.jpg' }, supabase)
    const details = (supabase.rpc as ReturnType<typeof vi.fn>).mock.calls[0][1].p_details_json
    expect(details).toHaveProperty('phone_e164')
    expect(details).toHaveProperty('full_name')
    expect(details).toHaveProperty('has_photo', true)
    expect(details).not.toHaveProperty('birth_date')
    expect(details).not.toHaveProperty('email')
  })

  it('returns error on unexpected DB error during dup check', async () => {
    const supabase = makeMockSupabase([
      { data: null, error: { code: '500', message: 'DB error' } },
    ])
    const result = await impl_createPerson(VALID_INPUT, supabase)
    expect(result.status).toBe('error')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// updatePerson
// ────────────────────────────────────────────────────────────────────────────

describe('impl_updatePerson', () => {
  const BEFORE = { ...MOCK_PERSON, nickname: 'old-nick', email: 'old@mail.com' }
  const AFTER  = { ...MOCK_PERSON, nickname: 'new-nick', email: 'new@mail.com' }

  it('happy path: returns updated person; audit includes PEOPLE_UPDATE and only changed fields', async () => {
    const supabase = makeMockSupabase([
      { data: BEFORE, error: null }, // pre-fetch
      { data: AFTER,  error: null }, // update
    ])
    const result = await impl_updatePerson('person-uuid-1', { nickname: 'new-nick', email: 'new@mail.com' }, supabase)
    expect(result.status).toBe('updated')

    expect(supabase.rpc).toHaveBeenCalledWith('log_audit', expect.objectContaining({
      p_action: AUDIT_ACTIONS.PEOPLE_UPDATE,
    }))
    const details = (supabase.rpc as ReturnType<typeof vi.fn>).mock.calls[0][1].p_details_json
    expect(details.changed_fields).toEqual(expect.arrayContaining(['nickname', 'email']))
    expect(details.before).toEqual({ nickname: 'old-nick', email: 'old@mail.com' })
    expect(details.after).toEqual({ nickname: 'new-nick', email: 'new@mail.com' })
  })

  it('rejects phone_e164 in input with validation_error — no DB call', async () => {
    const supabase = makeMockSupabase()
    const result = await impl_updatePerson('person-uuid-1', { phone_e164: '+62xxx' } as never, supabase)
    expect(result.status).toBe('validation_error')
    if (result.status !== 'validation_error') return
    expect(result.field_errors).toHaveProperty('phone_e164')
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('rejects photo_publish_consent in input, directs caller to setPhotoConsent', async () => {
    const supabase = makeMockSupabase()
    const result = await impl_updatePerson('person-uuid-1', { photo_publish_consent: true } as never, supabase)
    expect(result.status).toBe('validation_error')
    if (result.status !== 'validation_error') return
    expect(result.field_errors.photo_publish_consent).toMatch(/setPhotoConsent/i)
  })

  it('null value in input is written to DB (clears the field)', async () => {
    const supabase = makeMockSupabase([
      { data: { ...MOCK_PERSON, email: 'old@mail.com' }, error: null },
      { data: { ...MOCK_PERSON, email: null },           error: null },
    ])
    const result = await impl_updatePerson('person-uuid-1', { email: null }, supabase)
    expect(result.status).toBe('updated')
    const updateArg = (supabase._builder.update as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(updateArg).toHaveProperty('email', null)
  })

  it('field absent from input is NOT included in UPDATE payload', async () => {
    const supabase = makeMockSupabase([
      { data: BEFORE, error: null },
      { data: AFTER,  error: null },
    ])
    await impl_updatePerson('person-uuid-1', { nickname: 'new-nick' }, supabase)
    const updateArg = (supabase._builder.update as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(updateArg).not.toHaveProperty('email')
    expect(updateArg).not.toHaveProperty('full_name')
    expect(updateArg).not.toHaveProperty('birth_date')
  })

  it('returns not_found when pre-fetch returns PGRST116', async () => {
    const supabase = makeMockSupabase([{ data: null, error: PGRST116 }])
    const result = await impl_updatePerson('person-uuid-1', { nickname: 'x' }, supabase)
    expect(result.status).toBe('not_found')
  })

  it('returns error when not authenticated', async () => {
    const supabase = makeMockSupabase([], { data: null, error: null }, null)
    const result = await impl_updatePerson('person-uuid-1', { nickname: 'x' }, supabase)
    expect(result.status).toBe('error')
  })

  it('audit before/after snapshots contain only the changed fields, not the full row', async () => {
    const supabase = makeMockSupabase([
      { data: BEFORE, error: null },
      { data: AFTER,  error: null },
    ])
    await impl_updatePerson('person-uuid-1', { nickname: 'new-nick' }, supabase)
    const details = (supabase.rpc as ReturnType<typeof vi.fn>).mock.calls[0][1].p_details_json
    expect(Object.keys(details.before)).toEqual(['nickname'])
    expect(Object.keys(details.after)).toEqual(['nickname'])
  })
})

// ────────────────────────────────────────────────────────────────────────────
// softDeletePerson
// ────────────────────────────────────────────────────────────────────────────

describe('impl_softDeletePerson', () => {
  it('admin happy path: returns deleted and calls log_audit with PEOPLE_SOFT_DELETE', async () => {
    const supabase = makeMockSupabase([{ data: { id: 'person-uuid-1' }, error: null }])
    const result = await impl_softDeletePerson('person-uuid-1', supabase)
    expect(result.status).toBe('deleted')
    expect(supabase.rpc).toHaveBeenCalledWith('log_audit', expect.objectContaining({
      p_action: AUDIT_ACTIONS.PEOPLE_SOFT_DELETE,
    }))
  })

  it('returns not_authorized when DB returns 42501 (organizer WITH CHECK violation)', async () => {
    const supabase = makeMockSupabase([
      { data: null, error: { code: '42501', message: 'RLS violation' } },
    ])
    const result = await impl_softDeletePerson('person-uuid-1', supabase)
    expect(result.status).toBe('not_authorized')
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('returns not_found when UPDATE returns PGRST116 (person does not exist or already deleted)', async () => {
    const supabase = makeMockSupabase([{ data: null, error: PGRST116 }])
    const result = await impl_softDeletePerson('person-uuid-1', supabase)
    expect(result.status).toBe('not_found')
  })

  it('returns error when not authenticated', async () => {
    const supabase = makeMockSupabase([], { data: null, error: null }, null)
    const result = await impl_softDeletePerson('person-uuid-1', supabase)
    expect(result.status).toBe('error')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// setPhotoConsent
// ────────────────────────────────────────────────────────────────────────────

describe('impl_setPhotoConsent', () => {
  const NO_CONSENT  = { id: 'person-uuid-1', photo_publish_consent: false }
  const HAS_CONSENT = { id: 'person-uuid-1', photo_publish_consent: true }
  const GRANTED_PERSON = { ...MOCK_PERSON, photo_publish_consent: true }
  const REVOKED_PERSON = { ...MOCK_PERSON, photo_publish_consent: false }

  it('consent=true: calls log_audit with CONSENT_GRANT — not PEOPLE_UPDATE', async () => {
    const supabase = makeMockSupabase([
      { data: NO_CONSENT,                                   error: null }, // fetch current
      { data: { consent_policy_version: 'v1' },             error: null }, // app_settings
      { data: GRANTED_PERSON,                               error: null }, // update
    ])
    const result = await impl_setPhotoConsent('person-uuid-1', true, supabase)
    expect(result.status).toBe('updated')

    const rpcCalls = (supabase.rpc as ReturnType<typeof vi.fn>).mock.calls
    const actions = rpcCalls.map((c: unknown[]) => (c[1] as Record<string, unknown>).p_action)
    expect(actions).toContain(AUDIT_ACTIONS.CONSENT_GRANT)
    expect(actions).not.toContain(AUDIT_ACTIONS.PEOPLE_UPDATE)
  })

  it('consent=false: calls log_audit with CONSENT_REVOKE — not PEOPLE_UPDATE', async () => {
    const supabase = makeMockSupabase([
      { data: HAS_CONSENT,   error: null }, // fetch current (no app_settings call for revoke)
      { data: REVOKED_PERSON, error: null }, // update
    ])
    const result = await impl_setPhotoConsent('person-uuid-1', false, supabase)
    expect(result.status).toBe('updated')

    const rpcCalls = (supabase.rpc as ReturnType<typeof vi.fn>).mock.calls
    const actions = rpcCalls.map((c: unknown[]) => (c[1] as Record<string, unknown>).p_action)
    expect(actions).toContain(AUDIT_ACTIONS.CONSENT_REVOKE)
    expect(actions).not.toContain(AUDIT_ACTIONS.PEOPLE_UPDATE)
  })

  it('consent=true: UPDATE payload includes photo_consent_version from app_settings', async () => {
    const supabase = makeMockSupabase([
      { data: NO_CONSENT,                           error: null },
      { data: { consent_policy_version: 'v2' },     error: null },
      { data: GRANTED_PERSON,                       error: null },
    ])
    await impl_setPhotoConsent('person-uuid-1', true, supabase)
    const updateArg = (supabase._builder.update as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(updateArg).toHaveProperty('photo_consent_version', 'v2')
    expect(updateArg.photo_consent_at).not.toBeNull()
  })

  it('app_settings fetch failure: consent still writes with photo_consent_version: null', async () => {
    const supabase = makeMockSupabase([
      { data: NO_CONSENT,                                         error: null },              // fetch current
      { data: null, error: { code: '500', message: 'settings err' } },                       // app_settings fails
      { data: GRANTED_PERSON,                                     error: null },              // update proceeds
    ])
    const result = await impl_setPhotoConsent('person-uuid-1', true, supabase)
    expect(result.status).toBe('updated')
    const updateArg = (supabase._builder.update as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(updateArg).toHaveProperty('photo_consent_version', null)
    expect(updateArg).toHaveProperty('photo_consent_at')
    expect(updateArg.photo_consent_at).not.toBeNull()
  })

  it('consent=false: UPDATE payload has photo_consent_at: null and does NOT include photo_consent_version', async () => {
    // Test #32: revoke clears photo_consent_at; leaves photo_consent_version untouched in DB
    const supabase = makeMockSupabase([
      { data: HAS_CONSENT,    error: null },
      { data: REVOKED_PERSON, error: null },
    ])
    await impl_setPhotoConsent('person-uuid-1', false, supabase)
    const updateArg = (supabase._builder.update as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(updateArg).toHaveProperty('photo_consent_at', null)
    expect(updateArg).not.toHaveProperty('photo_consent_version')
  })

  it('returns not_found when person fetch returns PGRST116', async () => {
    const supabase = makeMockSupabase([{ data: null, error: PGRST116 }])
    const result = await impl_setPhotoConsent('person-uuid-1', true, supabase)
    expect(result.status).toBe('not_found')
  })

  it('returns error when not authenticated', async () => {
    const supabase = makeMockSupabase([], { data: null, error: null }, null)
    const result = await impl_setPhotoConsent('person-uuid-1', true, supabase)
    expect(result.status).toBe('error')
  })

  it('audit details record from/to consent values', async () => {
    const supabase = makeMockSupabase([
      { data: NO_CONSENT,                       error: null },
      { data: { consent_policy_version: 'v1' }, error: null },
      { data: GRANTED_PERSON,                   error: null },
    ])
    await impl_setPhotoConsent('person-uuid-1', true, supabase)
    const details = (supabase.rpc as ReturnType<typeof vi.fn>).mock.calls[0][1].p_details_json
    expect(details).toEqual({ from: false, to: true })
  })
})
