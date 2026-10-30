// impl_rescheduleInstance (S9.5-T4) with a mock client: validation before any
// RPC, WIB date + time → timestamptz via toJakartaInstant, and the mapping of
// every 'reschedule:<code>' refusal to a typed error with en + id copy. The
// real RPC is covered in tests/integration/reschedule-instance.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import en from '@/messages/en.json'
import id from '@/messages/id.json'
import { impl_rescheduleInstance, mapRescheduleError } from '@/lib/actions/events.impl'
import type { RescheduleErrorCode } from '@/lib/actions/events.types'

const INSTANCE_ID = '11111111-2222-4333-8444-555555555555'
const NEW_ID = '99999999-2222-4333-8444-555555555555'

const rpc = vi.fn()
const single = vi.fn()
let claims: { claims: { sub: string } } | null
const client = {
  auth: { getClaims: async () => ({ data: claims }) },
  rpc: (...args: unknown[]) => rpc(...args),
  from: () => ({ select: () => ({ eq: () => ({ single: () => single() }) }) }),
} as unknown as SupabaseClient

function call(over: Partial<{ instanceId: string; wibDate: string; wibTime: string; reason: string }> = {}) {
  return impl_rescheduleInstance({
    supabase: client,
    instanceId: INSTANCE_ID,
    wibDate: '2026-12-19',
    wibTime: '15:00',
    reason: 'Venue unavailable',
    ...over,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  claims = { claims: { sub: 'admin-1' } }
  rpc.mockResolvedValue({ data: NEW_ID, error: null })
  single.mockResolvedValue({ data: { event_id: 'event-1' }, error: null })
})

describe('impl_rescheduleInstance — validation (no RPC)', () => {
  it.each([
    [{ instanceId: 'not-a-uuid' }, 'invalid_instance'],
    [{ wibDate: '19-12-2026' }, 'invalid_date'],
    [{ wibDate: '2026-02-30' }, 'invalid_date'],
    [{ wibDate: '2026-13-01' }, 'invalid_date'],
    [{ wibTime: '3pm' }, 'invalid_time'],
    [{ wibTime: '15:00:00' }, 'invalid_time'],
    [{ wibTime: '25:00' }, 'invalid_date'],
    [{ reason: '' }, 'reason_required'],
    [{ reason: '   ' }, 'reason_required'],
    [{ reason: 'x'.repeat(501) }, 'reason_too_long'],
  ] as const)('%j → %s', async (over, code) => {
    expect(await call(over)).toEqual({ status: 'error', code })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('500 code points (astral chars count once) is accepted', async () => {
    expect((await call({ reason: '😀'.repeat(500) })).status).toBe('ok')
  })

  it('no session → unauthenticated, no RPC', async () => {
    claims = null
    expect(await call()).toEqual({ status: 'error', code: 'unauthenticated' })
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('impl_rescheduleInstance — RPC call', () => {
  it('converts the WIB date + time to the UTC instant and sends the trimmed reason', async () => {
    const result = await call({ reason: '  Venue unavailable  ' })
    expect(rpc).toHaveBeenCalledWith('reschedule_instance', {
      p_instance_id: INSTANCE_ID,
      p_new_at: '2026-12-19T08:00:00.000Z', // 15:00 WIB = 08:00 UTC
      p_reason: 'Venue unavailable',
    })
    expect(result).toEqual({ status: 'ok', instance_id: NEW_ID, event_id: 'event-1' })
  })

  it('WIB midnight crossing: 2026-12-20 01:30 WIB → 2026-12-19T18:30Z', async () => {
    await call({ wibDate: '2026-12-20', wibTime: '01:30' })
    expect(rpc.mock.calls[0][1].p_new_at).toBe('2026-12-19T18:30:00.000Z')
  })

  it('RPC ok but the new row cannot be read → unknown', async () => {
    single.mockResolvedValue({ data: null, error: { message: 'x' } })
    expect(await call()).toEqual({ status: 'error', code: 'unknown' })
  })

  it('RPC returns a non-string → unknown', async () => {
    rpc.mockResolvedValue({ data: null, error: null })
    expect(await call()).toEqual({ status: 'error', code: 'unknown' })
  })
})

const SQL_CODES: [string, RescheduleErrorCode][] = [
  ['not_admin', 'not_admin'],
  ['invalid_input', 'invalid_instance'],
  ['not_found', 'not_found'],
  ['not_scheduled', 'not_scheduled'],
  ['original_in_past', 'original_in_past'],
  ['event_inactive', 'event_inactive'],
  ['not_recurring', 'not_recurring'],
  ['new_in_past', 'new_in_past'],
  ['beyond_horizon', 'beyond_horizon'],
  ['same_time', 'same_time'],
  ['slot_taken', 'slot_taken'],
  ['reason_required', 'reason_required'],
  ['reason_too_long', 'reason_too_long'],
]

describe('impl_rescheduleInstance — refusal mapping', () => {
  it.each(SQL_CODES)('reschedule:%s → %s', async (sql, code) => {
    rpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: `reschedule:${sql}` } })
    expect(await call()).toEqual({ status: 'error', code })
  })

  it('42501 (no EXECUTE) → not_admin; unrecognised token / other errors → unknown', () => {
    expect(mapRescheduleError({ code: '42501', message: 'permission denied for function reschedule_instance' })).toBe('not_admin')
    expect(mapRescheduleError({ code: 'P0001', message: 'reschedule:something_new' })).toBe('unknown')
    expect(mapRescheduleError({ code: '08006', message: 'connection failure' })).toBe('unknown')
  })

  it('every error code has a non-empty en and id message', () => {
    const codes: RescheduleErrorCode[] = [
      ...SQL_CODES.map(([, c]) => c), 'invalid_date', 'invalid_time', 'unauthenticated', 'unknown',
    ]
    const enErrors = en.admin.events.instance.reschedule.errors as Record<string, string>
    const idErrors = id.admin.events.instance.reschedule.errors as Record<string, string>
    for (const c of codes) {
      expect(enErrors[c], `en ${c}`).toBeTruthy()
      expect(idErrors[c], `id ${c}`).toBeTruthy()
    }
    expect(Object.keys(enErrors).sort()).toEqual([...new Set(codes)].sort())
  })
})
