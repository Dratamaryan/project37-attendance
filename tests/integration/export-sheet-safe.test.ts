// Integration test for S8-T5 C1 — both existing xlsx exports run every cell
// through lib/utils/sheet-safe.ts. Runs against local Docker Supabase.
//
// One fixture person whose nickname is a formula payload, with one attendance
// row, so it appears in BOTH the people roster and the attendance export. Route
// modules are imported directly with @/lib/supabase/server mocked to a real
// signed-in admin session (same pattern as people-export-actions.test.ts).
//
// Phone space +62999009107xx (S8-T5 C1 — unused by every other test file).

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { NextRequest } from 'next/server'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomUUID } from 'crypto'
import * as XLSX from 'xlsx'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !anonKey || !serviceKey) {
  throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY')
}

const PROD_PROJECT_REF = 'bftifxgdcmisasgvobuf'
if (url.includes(PROD_PROJECT_REF)) {
  throw new Error(
    `[export-sheet-safe.test.ts] NEXT_PUBLIC_SUPABASE_URL resolves to the PRODUCTION ` +
      `project (${PROD_PROJECT_REF}). This suite creates/deletes real auth users and people ` +
      `rows — must run against local Docker only.`,
  )
}

const PAYLOAD = '=HYPERLINK("http://evil.invalid","click")'
const FULL_NAME = 'SHEETSAFE Test Person'
const PHONE = '+62999009107001'
const PARISH = 'SHEETSAFE Test Parish'
const EVENT_NAME = 'SHEETSAFE Test Event'

let svc: SupabaseClient
let adminSession: SupabaseClient
let adminId: string
let personId: string
let eventId: string
let instanceId: string

let currentSessionClient: SupabaseClient
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => currentSessionClient,
}))

beforeAll(async () => {
  svc = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })

  const email = `sheetsafe-admin-${randomUUID()}@test.invalid`
  const pass = `SheetSafe-${Date.now()}!`
  const { data: authData, error: authErr } = await svc.auth.admin.createUser({
    email, password: pass, email_confirm: true,
  })
  if (authErr || !authData.user) throw new Error(`createUser: ${authErr?.message}`)
  adminId = authData.user.id

  const { error: appErr } = await svc
    .from('app_users')
    .insert({ id: adminId, email, full_name: 'SHEETSAFE Test Admin', role: 'admin', active: true })
  if (appErr) throw new Error(`insert app_user: ${appErr.message}`)

  adminSession = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { error: signInErr } = await adminSession.auth.signInWithPassword({ email, password: pass })
  if (signInErr) throw new Error(`sign-in: ${signInErr.message}`)

  const { data: person, error: pErr } = await svc.from('people').insert({
    phone_e164: PHONE,
    full_name: FULL_NAME,
    nickname: PAYLOAD,
    origin_parish: PARISH,
  }).select('id').single()
  if (pErr) throw new Error(`insert person: ${pErr.message}`)
  personId = person.id

  const { data: event, error: eErr } = await svc.from('events').insert({
    name: EVENT_NAME,
    name_id: EVENT_NAME,
    event_type: 'adhoc',
    start_date: '2026-06-05',
    start_time: '18:00',
    recurrence_rule: null,
    created_by: adminId,
  }).select('id').single()
  if (eErr) throw new Error(`insert event: ${eErr.message}`)
  eventId = event.id

  const { data: inst, error: iErr } = await svc.from('event_instances').insert({
    event_id: eventId,
    scheduled_at: '2026-06-05T11:00:00Z',
    event_name_snapshot: EVENT_NAME,
    event_name_snapshot_id: EVENT_NAME,
    status: 'completed',
  }).select('id').single()
  if (iErr) throw new Error(`insert instance: ${iErr.message}`)
  instanceId = inst.id

  const { error: aErr } = await svc.from('attendance').insert({
    event_instance_id: instanceId,
    person_id: personId,
    checked_in_at: '2026-06-05T11:05:00Z',
    checked_in_by: adminId,
  })
  if (aErr) throw new Error(`insert attendance: ${aErr.message}`)
}, 30_000)

afterAll(async () => {
  if (!svc) return
  if (instanceId) {
    await svc.from('attendance').delete().eq('event_instance_id', instanceId)
    await svc.from('event_instances').delete().eq('id', instanceId)
  }
  if (eventId) await svc.from('events').delete().eq('id', eventId)
  if (personId) await svc.from('people').delete().eq('id', personId)
  if (adminId) {
    await svc.from('audit_log').delete().eq('actor_user_id', adminId)
    await svc.from('app_users').delete().eq('id', adminId)
    await svc.auth.admin.deleteUser(adminId)
  }
}, 30_000)

async function readSheet(res: Response, sheet: string): Promise<Record<string, unknown>[]> {
  const workbook = XLSX.read(new Uint8Array(await res.arrayBuffer()), { type: 'array' })
  return XLSX.utils.sheet_to_json(workbook.Sheets[sheet]!) as Record<string, unknown>[]
}

describe('xlsx exports neutralise formula-leading cells', () => {
  it('GET /api/admin/export/people — formula nickname is quote-prefixed; E.164 phone left as-is', async () => {
    currentSessionClient = adminSession
    const { GET } = await import('@/app/api/admin/export/people/route')
    const res = await GET(new NextRequest('http://localhost/api/admin/export/people'))
    expect(res.status).toBe(200)

    const row = (await readSheet(res, 'People Roster')).find(r => r.Name === FULL_NAME)
    expect(row).toBeDefined()
    expect(row!.Nickname).toBe(`'${PAYLOAD}`)
    expect(row!.Phone).toBe(PHONE)
  })

  it('GET /api/admin/export/attendance — formula nickname is quote-prefixed on the Raw sheet', async () => {
    currentSessionClient = adminSession
    const { GET } = await import('@/app/api/admin/export/attendance/route')
    const res = await GET(
      new NextRequest(`http://localhost/api/admin/export/attendance?parish=${encodeURIComponent(PARISH)}`),
    )
    expect(res.status).toBe(200)

    const rows = await readSheet(res, 'Raw Attendance')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.nickname).toBe(`'${PAYLOAD}`)
    expect(rows[0]!.phone_e164).toBe(PHONE)
  })
})
