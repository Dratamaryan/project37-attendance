// Unit tests for the S9-R1 public RSVP impl (lib/rsvp/public.impl.ts):
// form-data parsing/validation, WIB event-header formatting per locale,
// locale/token/image guards, and submit result mapping against a fake anon
// client. The real RPCs are covered in tests/integration/rsvp-public.test.ts.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('server-only', () => ({}))

import {
  formatRsvpEventView,
  impl_getRsvpPageData,
  impl_submitRsvp,
  isWellFormedRsvpToken,
  parseRsvpFormData,
  resolveRsvpLocale,
  safeImageUrl,
} from '../public.impl'

const GATE = 'unit-test-gate-value'
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz012-_9'
const ORIGINAL_FLAG = process.env.RSVP_PUBLIC_ENABLED
const ORIGINAL_GATE = process.env.RSVP_GATE_SECRET

function setEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  return fd
}

const VALID = { status: 'coming', phone: '081234567890' }

function fakeClient(result: { data?: unknown; error?: { code: string; message: string } | null }) {
  const rpc = vi.fn().mockResolvedValue({ data: result.data ?? null, error: result.error ?? null })
  return { client: { rpc } as unknown as SupabaseClient, rpc }
}

beforeEach(() => {
  setEnv('RSVP_PUBLIC_ENABLED', 'true')
  setEnv('RSVP_GATE_SECRET', GATE)
})

afterEach(() => {
  setEnv('RSVP_PUBLIC_ENABLED', ORIGINAL_FLAG)
  setEnv('RSVP_GATE_SECRET', ORIGINAL_GATE)
  vi.restoreAllMocks()
})

// ── parseRsvpFormData ────────────────────────────────────────────────────────

describe('parseRsvpFormData — status', () => {
  it.each(['coming', 'maybe', 'not_coming'])('%s accepted', (status) => {
    const r = parseRsvpFormData(form({ ...VALID, status }))
    expect(r.ok && r.input.status).toBe(status)
  })

  it.each([[''], ['COMING'], ['yes'], ['attending']])('%j -> required', (status) => {
    const r = parseRsvpFormData(form({ ...VALID, status }))
    expect(r).toEqual({ ok: false, fieldErrors: { status: 'required' } })
  })

  it('missing -> required', () => {
    expect(parseRsvpFormData(form({ phone: VALID.phone }))).toEqual({
      ok: false,
      fieldErrors: { status: 'required' },
    })
  })
})

describe('parseRsvpFormData — phone (region ID)', () => {
  it.each([
    ['081234567890', '+6281234567890'],
    ['0812-3456-7890', '+6281234567890'],
    ['+62 812 3456 7890', '+6281234567890'],
    ['81234567890', '+6281234567890'],
    ['+6591234567', '+6591234567'],
  ])('%j -> %s', (phone, e164) => {
    const r = parseRsvpFormData(form({ ...VALID, phone }))
    expect(r.ok && r.input.phoneE164).toBe(e164)
  })

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['0812', 'too_short'],
    ['0812345678901234567', 'too_long'],
    ['1'.repeat(33), 'too_long'],
    ['abcdefgh', 'invalid_for_country'],
    ['0000000000', 'invalid_for_country'],
  ])('%j -> %s', (phone, reason) => {
    expect(parseRsvpFormData(form({ ...VALID, phone }))).toEqual({
      ok: false,
      fieldErrors: { phone: reason },
    })
  })
})

describe('parseRsvpFormData — name', () => {
  it('trimmed; blank -> null', () => {
    const named = parseRsvpFormData(form({ ...VALID, name: '  Budi  ' }))
    expect(named.ok && named.input.name).toBe('Budi')
    const blank = parseRsvpFormData(form({ ...VALID, name: '   ' }))
    expect(blank.ok && blank.input.name).toBeNull()
    const absent = parseRsvpFormData(form(VALID))
    expect(absent.ok && absent.input.name).toBeNull()
  })

  it('100 chars ok, 101 -> too_long', () => {
    expect(parseRsvpFormData(form({ ...VALID, name: 'a'.repeat(100) })).ok).toBe(true)
    expect(parseRsvpFormData(form({ ...VALID, name: 'a'.repeat(101) }))).toEqual({
      ok: false,
      fieldErrors: { name: 'too_long' },
    })
  })

  it('counts code points like Postgres char_length (100 emoji ok)', () => {
    expect(parseRsvpFormData(form({ ...VALID, name: '😀'.repeat(100) })).ok).toBe(true)
  })
})

describe('parseRsvpFormData — children', () => {
  it.each([['1', 1], ['7', 7], ['20', 20]])('yes + %s -> %d', (count, expected) => {
    const r = parseRsvpFormData(form({ ...VALID, bringing_children: 'yes', children_count: count }))
    expect(r.ok && r.input.children).toBe(expected)
  })

  it.each([
    ['', 'required'],
    ['0', 'out_of_range'],
    ['21', 'out_of_range'],
    ['-1', 'out_of_range'],
    ['2.5', 'out_of_range'],
    ['abc', 'out_of_range'],
    ['100', 'out_of_range'],
  ])('yes + %j -> %s', (count, error) => {
    expect(
      parseRsvpFormData(form({ ...VALID, bringing_children: 'yes', children_count: count })),
    ).toEqual({ ok: false, fieldErrors: { children: error } })
  })

  it('bringing no / absent -> 0 even with a count', () => {
    const no = parseRsvpFormData(form({ ...VALID, bringing_children: 'no', children_count: '5' }))
    expect(no.ok && no.input.children).toBe(0)
    const absent = parseRsvpFormData(form({ ...VALID, children_count: '5' }))
    expect(absent.ok && absent.input.children).toBe(0)
  })

  it('not_coming -> 0, and a bad count is ignored', () => {
    const r = parseRsvpFormData(
      form({ ...VALID, status: 'not_coming', bringing_children: 'yes', children_count: '99' }),
    )
    expect(r.ok && r.input.children).toBe(0)
  })

  it('maybe + yes counts', () => {
    const r = parseRsvpFormData(
      form({ ...VALID, status: 'maybe', bringing_children: 'yes', children_count: '3' }),
    )
    expect(r.ok && r.input.children).toBe(3)
  })
})

describe('parseRsvpFormData — consent and combined errors', () => {
  it('consent only when the checkbox value is "on"', () => {
    const on = parseRsvpFormData(form({ ...VALID, followup_consent: 'on' }))
    expect(on.ok && on.input.followupConsent).toBe(true)
    const off = parseRsvpFormData(form(VALID))
    expect(off.ok && off.input.followupConsent).toBe(false)
    const other = parseRsvpFormData(form({ ...VALID, followup_consent: 'true' }))
    expect(other.ok && other.input.followupConsent).toBe(false)
  })

  it('reports every failing field at once', () => {
    expect(
      parseRsvpFormData(
        form({ phone: '', name: 'x'.repeat(101), bringing_children: 'yes', children_count: '' }),
      ),
    ).toEqual({
      ok: false,
      fieldErrors: { status: 'required', phone: 'empty', name: 'too_long', children: 'required' },
    })
  })
})

// ── formatRsvpEventView ──────────────────────────────────────────────────────

const CTX = {
  event_name: 'Friday Worship',
  event_name_id: 'Ibadah Jumat',
  scheduled_at: '2026-10-24T11:00:00+00:00', // 18:00 WIB, Saturday
  duration_min: 120,
  location: 'Main Hall',
  image_url: 'https://example.invalid/poster.png',
}

describe('formatRsvpEventView', () => {
  it('id: Indonesian name, date and HH.mm range in WIB', () => {
    expect(formatRsvpEventView(CTX, 'id')).toEqual({
      name: 'Ibadah Jumat',
      dateLabel: 'Sabtu, 24 Oktober 2026',
      timeLabel: '18.00–20.00 WIB',
      location: 'Main Hall',
      imageUrl: 'https://example.invalid/poster.png',
    })
  })

  it('en: English name, date and h:mm a range in WIB', () => {
    expect(formatRsvpEventView(CTX, 'en')).toEqual({
      name: 'Friday Worship',
      dateLabel: 'Saturday, October 24, 2026',
      timeLabel: '6:00 PM–8:00 PM WIB',
      location: 'Main Hall',
      imageUrl: 'https://example.invalid/poster.png',
    })
  })

  it('id falls back to event_name when there is no Indonesian name', () => {
    expect(formatRsvpEventView({ ...CTX, event_name_id: null }, 'id').name).toBe('Friday Worship')
  })

  it('WIB day rollover: 17:30 UTC Saturday is Sunday 00:30 WIB', () => {
    const ctx = { ...CTX, scheduled_at: '2026-10-24T17:30:00Z' }
    expect(formatRsvpEventView(ctx, 'id')).toMatchObject({
      dateLabel: 'Minggu, 25 Oktober 2026',
      timeLabel: '00.30–02.30 WIB',
    })
    expect(formatRsvpEventView(ctx, 'en')).toMatchObject({
      dateLabel: 'Sunday, October 25, 2026',
      timeLabel: '12:30 AM–2:30 AM WIB',
    })
  })

  it('end past WIB midnight keeps the start date', () => {
    const ctx = { ...CTX, scheduled_at: '2026-10-24T16:00:00Z' } // 23:00 WIB
    expect(formatRsvpEventView(ctx, 'id')).toMatchObject({
      dateLabel: 'Sabtu, 24 Oktober 2026',
      timeLabel: '23.00–01.00 WIB',
    })
  })

  it('no positive duration -> start time only', () => {
    expect(formatRsvpEventView({ ...CTX, duration_min: null }, 'id').timeLabel).toBe('18.00 WIB')
    expect(formatRsvpEventView({ ...CTX, duration_min: 0 }, 'en').timeLabel).toBe('6:00 PM WIB')
  })

  it('null location / image stay null', () => {
    expect(formatRsvpEventView({ ...CTX, location: null, image_url: null }, 'en')).toMatchObject({
      location: null,
      imageUrl: null,
    })
  })
})

describe('safeImageUrl', () => {
  it.each([
    ['https://example.invalid/a.png', 'https://example.invalid/a.png'],
    ['http://127.0.0.1:54321/storage/v1/object/public/event-images/a.webp', 'http://127.0.0.1:54321/storage/v1/object/public/event-images/a.webp'],
    ['javascript:alert(1)', null],
    ['data:image/png;base64,AAAA', null],
    ['not a url', null],
    ['', null],
    [null, null],
  ])('%j -> %j', (raw, expected) => {
    expect(safeImageUrl(raw)).toBe(expected)
  })
})

describe('resolveRsvpLocale / isWellFormedRsvpToken', () => {
  it.each([
    ['id', 'id'],
    ['en', 'en'],
    [undefined, 'id'],
    [null, 'id'],
    ['', 'id'],
    ['EN', 'id'],
    ['fr', 'id'],
  ])('locale cookie %j -> %s', (raw, expected) => {
    expect(resolveRsvpLocale(raw)).toBe(expected)
  })

  it.each([
    [TOKEN, true],
    ['a', true],
    ['x'.repeat(64), true],
    ['x'.repeat(65), false],
    ['', false],
    ['has space', false],
    ['a/b', false],
    ['a+b=', false],
    [null, false],
    [123, false],
  ])('token %j -> %s', (token, expected) => {
    expect(isWellFormedRsvpToken(token)).toBe(expected)
  })
})

// ── impl_getRsvpPageData (fake client) ───────────────────────────────────────

describe('impl_getRsvpPageData', () => {
  it('flag off -> disabled without calling the RPC', async () => {
    setEnv('RSVP_PUBLIC_ENABLED', 'false')
    const { client, rpc } = fakeClient({ data: { open: true, ...CTX } })
    expect(await impl_getRsvpPageData(TOKEN, 'id', client)).toEqual({ kind: 'disabled' })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('malformed token -> closed without calling the RPC', async () => {
    const { client, rpc } = fakeClient({ data: { open: true, ...CTX } })
    expect(await impl_getRsvpPageData('bad token!', 'id', client)).toEqual({ kind: 'closed' })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('RPC error or malformed payload -> closed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const failing = fakeClient({ error: { code: 'XX000', message: 'boom' } })
    expect(await impl_getRsvpPageData(TOKEN, 'id', failing.client)).toEqual({ kind: 'closed' })
    const malformed = fakeClient({ data: { open: true, event_name: 'x' } })
    expect(await impl_getRsvpPageData(TOKEN, 'id', malformed.client)).toEqual({ kind: 'closed' })
  })
})

// ── impl_submitRsvp (fake client) ────────────────────────────────────────────

describe('impl_submitRsvp mapping', () => {
  const valid = () => form({ ...VALID, name: 'Budi', bringing_children: 'yes', children_count: '2', followup_consent: 'on' })

  it('sends the normalized input with the gate', async () => {
    const { client, rpc } = fakeClient({ data: { ok: true } })
    expect(await impl_submitRsvp(TOKEN, valid(), client)).toEqual({
      kind: 'success',
      status: 'coming',
      children: 2,
    })
    expect(rpc).toHaveBeenCalledWith('submit_rsvp', {
      p_gate: GATE,
      p_token: TOKEN,
      p_phone_e164: '+6281234567890',
      p_name: 'Budi',
      p_children_count: 2,
      p_followup_consent: true,
      p_status: 'coming',
    })
  })

  it.each([
    [{ ok: false, code: 'closed' }, { kind: 'closed' }],
    [{ ok: false, code: 'limit' }, { kind: 'limit' }],
    [{ ok: false, code: 'unavailable' }, { kind: 'unavailable' }],
    [{ ok: false, code: 'invalid' }, { kind: 'error' }],
    [{ surprise: 1 }, { kind: 'error' }],
    [null, { kind: 'error' }],
  ])('RPC %j -> %j', async (data, expected) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { client } = fakeClient({ data })
    expect(await impl_submitRsvp(TOKEN, valid(), client)).toEqual(expected)
  })

  it('RPC transport error -> unavailable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { client } = fakeClient({ error: { code: 'PGRST202', message: 'not found' } })
    expect(await impl_submitRsvp(TOKEN, valid(), client)).toEqual({ kind: 'unavailable' })
  })

  it('flag off / malformed token -> closed, no RPC', async () => {
    const { client, rpc } = fakeClient({ data: { ok: true } })
    setEnv('RSVP_PUBLIC_ENABLED', 'FALSE')
    expect(await impl_submitRsvp(TOKEN, valid(), client)).toEqual({ kind: 'closed' })
    setEnv('RSVP_PUBLIC_ENABLED', 'true')
    expect(await impl_submitRsvp('../etc', valid(), client)).toEqual({ kind: 'closed' })
    expect(await impl_submitRsvp(undefined, valid(), client)).toEqual({ kind: 'closed' })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('validation errors return before the gate / RPC', async () => {
    setEnv('RSVP_GATE_SECRET', undefined)
    const { client, rpc } = fakeClient({ data: { ok: true } })
    expect(await impl_submitRsvp(TOKEN, form({ phone: '' }), client)).toEqual({
      kind: 'invalid',
      fieldErrors: { status: 'required', phone: 'empty' },
    })
    expect(rpc).not.toHaveBeenCalled()
  })

  it.each([[undefined], [''], ['   ']])('gate %j -> unavailable, one console.error, no RPC', async (gate) => {
    setEnv('RSVP_GATE_SECRET', gate)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { client, rpc } = fakeClient({ data: { ok: true } })
    expect(await impl_submitRsvp(TOKEN, valid(), client)).toEqual({ kind: 'unavailable' })
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('gate value never appears in logs (gate rejected by RPC)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { client } = fakeClient({ data: { ok: false, code: 'unavailable' } })
    await impl_submitRsvp(TOKEN, valid(), client)
    expect(errorSpy).toHaveBeenCalled()
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(GATE)
  })
})
