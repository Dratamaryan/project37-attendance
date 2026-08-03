// Unit tests (mocked client) for settings.impl.ts validation logic and the
// changed-fields-only audit/cache-invalidation behavior. The admin-gate
// happy/denied paths themselves are proven against real Postgres in
// tests/integration/settings.test.ts, following the T6 admin-users.impl.ts
// precedent (gate mechanics proven once, live; here we test what's specific
// to this module — validation and diffing).
//
// next/cache's revalidateTag() throws "Invariant: static generation store
// missing" outside a real Next.js server request context (confirmed by
// reading node_modules/next/dist/server/web/spec-extension/revalidate.js) —
// unmockable in a bare Vitest process. Mocked here so the default_language
// change path is testable at all; the actual revalidateTag behavior is
// proven live/local against a real running Next server, not in Vitest — see
// docs/sprint-5-task-7-verify.md.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const revalidateTagMock = vi.fn()
vi.mock('next/cache', () => ({ revalidateTag: (...args: unknown[]) => revalidateTagMock(...args) }))

const requireActiveAdminMock = vi.fn()
vi.mock('@/lib/auth/require-admin', () => ({
  requireActiveAdmin: (...args: unknown[]) => requireActiveAdminMock(...args),
}))

const logAuditMock = vi.fn()
vi.mock('../../audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../audit')>()
  return { ...actual, logAudit: (...args: unknown[]) => logAuditMock(...args) }
})

import { impl_updateSettings, impl_getHorizonImpact } from '../settings.impl'
import { DEFAULT_LANGUAGE_CACHE_TAG } from '@/lib/settings/constants'

const ACTOR_ID = 'actor-uuid-settings'

const CURRENT_ROW = {
  default_country_code: 'ID',
  default_language: 'id',
  materialization_horizon_mo: 12,
  birthday_notify_time: '07:00:00',
  birthday_notify_timezone: 'Asia/Jakarta',
  birthday_notify_email: null,
  telegram_admin_chat_id: '000000000',
  consent_policy_version: 'v1',
  retention_archive_years: 3,
  retention_aggregate_years: 5,
  updated_at: '2026-07-28T14:28:22.344Z',
}

function makeAdminSupabase({
  beforeRow = CURRENT_ROW,
  afterRow,
}: { beforeRow?: typeof CURRENT_ROW; afterRow?: Record<string, unknown> } = {}) {
  let selectCallCount = 0
  const from = vi.fn().mockImplementation((table: string) => {
    if (table === 'app_settings') {
      const builder = {
        select: vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockImplementation(() => {
          selectCallCount++
          if (selectCallCount === 1) return Promise.resolve({ data: beforeRow, error: null })
          return Promise.resolve({ data: afterRow ?? beforeRow, error: null })
        }),
      }
      return builder
    }
    throw new Error(`Unexpected table in mock: ${table}`)
  })
  return { from } as unknown as SupabaseClient
}

const fakeSupabase = {} as unknown as SupabaseClient

beforeEach(() => {
  vi.clearAllMocks()
  requireActiveAdminMock.mockResolvedValue({ status: 'ok', actorId: ACTOR_ID, role: 'admin' })
})

describe('impl_updateSettings — privilege gate', () => {
  it('not_authorized short-circuits before any DB call', async () => {
    requireActiveAdminMock.mockResolvedValue({ status: 'denied' })
    const adminSupabase = makeAdminSupabase()

    const result = await impl_updateSettings({
      supabase: fakeSupabase,
      adminSupabase,
      input: { default_language: 'en' },
    })

    expect(result.status).toBe('not_authorized')
    expect((adminSupabase as unknown as { from: ReturnType<typeof vi.fn> }).from).not.toHaveBeenCalled()
  })
})

describe('impl_updateSettings — validation', () => {
  it('rejects an unsupported language, no DB call', async () => {
    const adminSupabase = makeAdminSupabase()
    const result = await impl_updateSettings({
      supabase: fakeSupabase,
      adminSupabase,
      input: { default_language: 'fr' },
    })
    expect(result.status).toBe('validation_error')
    if (result.status !== 'validation_error') return
    expect(result.field_errors).toHaveProperty('default_language')
    expect((adminSupabase as unknown as { from: ReturnType<typeof vi.fn> }).from).not.toHaveBeenCalled()
  })

  it.each([0, 25, 1.5, -3])('rejects an out-of-range/non-integer horizon: %s', async (bad) => {
    const adminSupabase = makeAdminSupabase()
    const result = await impl_updateSettings({
      supabase: fakeSupabase,
      adminSupabase,
      input: { materialization_horizon_mo: bad },
    })
    expect(result.status).toBe('validation_error')
    if (result.status !== 'validation_error') return
    expect(result.field_errors).toHaveProperty('materialization_horizon_mo')
  })

  it.each(['7am', '25:00', '07:60', ''])('rejects a malformed notify time: %s', async (bad) => {
    const adminSupabase = makeAdminSupabase()
    const result = await impl_updateSettings({
      supabase: fakeSupabase,
      adminSupabase,
      input: { birthday_notify_time: bad },
    })
    expect(result.status).toBe('validation_error')
    if (result.status !== 'validation_error') return
    expect(result.field_errors).toHaveProperty('birthday_notify_time')
  })

  it('rejects a non-IANA timezone string', async () => {
    const adminSupabase = makeAdminSupabase()
    const result = await impl_updateSettings({
      supabase: fakeSupabase,
      adminSupabase,
      input: { birthday_notify_timezone: 'Not/AZone' },
    })
    expect(result.status).toBe('validation_error')
    if (result.status !== 'validation_error') return
    expect(result.field_errors).toHaveProperty('birthday_notify_timezone')
  })

  it('accepts a valid IANA timezone', async () => {
    const adminSupabase = makeAdminSupabase({
      afterRow: { ...CURRENT_ROW, birthday_notify_timezone: 'America/New_York' },
    })
    const result = await impl_updateSettings({
      supabase: fakeSupabase,
      adminSupabase,
      input: { birthday_notify_timezone: 'America/New_York' },
    })
    expect(result.status).toBe('ok')
  })
})

describe('impl_updateSettings — changed-fields diff, audit, cache invalidation', () => {
  it('happy path: audits only the changed field, revalidates default_language tag with {expire:0}', async () => {
    const adminSupabase = makeAdminSupabase({ afterRow: { ...CURRENT_ROW, default_language: 'en' } })

    const result = await impl_updateSettings({
      supabase: fakeSupabase,
      adminSupabase,
      input: { default_language: 'en' },
    })

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.changed).toEqual({ default_language: { from: 'id', to: 'en' } })

    expect(logAuditMock).toHaveBeenCalledTimes(1)
    expect(logAuditMock.mock.calls[0][0]).toMatchObject({
      actorUserId: ACTOR_ID,
      action: 'settings.update',
      entityType: 'app_settings',
      entityId: '1',
      detailsJson: { default_language: { from: 'id', to: 'en' } },
    })

    expect(revalidateTagMock).toHaveBeenCalledTimes(1)
    expect(revalidateTagMock).toHaveBeenCalledWith(DEFAULT_LANGUAGE_CACHE_TAG, { expire: 0 })
  })

  it('does NOT call revalidateTag when default_language is unchanged', async () => {
    const adminSupabase = makeAdminSupabase({
      afterRow: { ...CURRENT_ROW, materialization_horizon_mo: 6 },
    })

    const result = await impl_updateSettings({
      supabase: fakeSupabase,
      adminSupabase,
      input: { materialization_horizon_mo: 6 },
    })

    expect(result.status).toBe('ok')
    expect(revalidateTagMock).not.toHaveBeenCalled()
    expect(logAuditMock).toHaveBeenCalledTimes(1)
  })

  it('no-op patch (value equals current) skips audit entirely — no false "changed" entry', async () => {
    const adminSupabase = makeAdminSupabase({ afterRow: { ...CURRENT_ROW } })

    const result = await impl_updateSettings({
      supabase: fakeSupabase,
      adminSupabase,
      input: { default_language: 'id' }, // same as CURRENT_ROW
    })

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.changed).toEqual({})
    expect(logAuditMock).not.toHaveBeenCalled()
    expect(revalidateTagMock).not.toHaveBeenCalled()
  })
})

describe('impl_getHorizonImpact', () => {
  it('not_authorized short-circuits before any DB call', async () => {
    requireActiveAdminMock.mockResolvedValue({ status: 'denied' })
    const fromMock = vi.fn()
    const adminSupabase = { from: fromMock } as unknown as SupabaseClient

    const result = await impl_getHorizonImpact({
      supabase: fakeSupabase,
      adminSupabase,
      input: { newHorizonMonths: 6 },
    })
    expect(result.status).toBe('not_authorized')
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('rejects an out-of-range horizon before any DB call', async () => {
    const fromMock = vi.fn()
    const adminSupabase = { from: fromMock } as unknown as SupabaseClient

    const result = await impl_getHorizonImpact({
      supabase: fakeSupabase,
      adminSupabase,
      input: { newHorizonMonths: 99 },
    })
    expect(result.status).toBe('validation_error')
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('queries scheduled instances beyond the computed horizon end, returns the count', async () => {
    const builder = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      gt: vi.fn().mockReturnThis(),
      then(resolve: (v: unknown) => unknown) {
        return Promise.resolve({ count: 3, error: null }).then(resolve)
      },
    }
    const fromMock = vi.fn().mockReturnValue(builder)
    const adminSupabase = { from: fromMock } as unknown as SupabaseClient

    const result = await impl_getHorizonImpact({
      supabase: fakeSupabase,
      adminSupabase,
      input: { newHorizonMonths: 6 },
    })

    expect(result).toEqual({ status: 'ok', estimated_count: 3, horizon_end: expect.any(String) })
    expect(builder.eq).toHaveBeenCalledWith('status', 'scheduled')
    expect(builder.gt).toHaveBeenCalledWith('scheduled_at', expect.any(String))
  })
})
