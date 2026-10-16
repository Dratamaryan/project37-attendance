// Integration tests for S8-T5 C3 — GET /api/admin/export/instance/[instanceId].
// Runs against local Docker Supabase. Route module imported directly with
// @/lib/supabase/server mocked to a REAL session client (same pattern as
// people-export-actions.test.ts), so requireActiveAdmin + RLS run for real.
//
// Fixture (phone space +629990091091xx — S8-T5 C3, unused elsewhere):
//   IE  instance under test, scheduled 2026-06-01T18:00Z = 2026-06-02 01:00 WIB
//       (proves the filename date is WIB, not UTC)
//   IP  earlier instance (May) — E2 attended it, so E2 is NOT a first-timer at IE
//   IX  another instance — EX + child KX attended it; must never appear
//   E1  nickname is a formula payload, checked in by the admin, first-timer
//   E2  checked in by the organizer (proves per-row checker email)
//   E3  soft-deleted — excluded (D2)
//   K   child of E1 at IE;  KX child at IX

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { NextRequest } from 'next/server'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomUUID } from 'crypto'
import * as XLSX from 'xlsx'

vi.mock('server-only', () => ({}))

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !anonKey || !serviceKey) {
  throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY')
}

const PROD_PROJECT_REF = 'bftifxgdcmisasgvobuf'
if (url.includes(PROD_PROJECT_REF)) {
  throw new Error(
    `[instance-export-route.test.ts] NEXT_PUBLIC_SUPABASE_URL resolves to the PRODUCTION ` +
      `project (${PROD_PROJECT_REF}). This suite creates/deletes real auth users and people ` +
      `rows — must run against local Docker only.`,
  )
}

const PAYLOAD = '=HYPERLINK("http://evil.invalid","click")'
const PHONES = {
  E1: '+62999009109101',
  E2: '+62999009109102',
  E3: '+62999009109103',
  EX: '+62999009109104',
} as const
const EVENT_NAME = 'IEXP Test Event'

let svc: SupabaseClient
let anonSession: SupabaseClient
let adminSession: SupabaseClient
let deactivatedAdminSession: SupabaseClient
let organizerSession: SupabaseClient
let adminId: string
let adminEmail: string
let organizerId: string
let organizerEmail: string

const authUserIds: string[] = []
const peopleIds: string[] = []
const childIds: string[] = []
let eventId: string
const inst = { IE: '', IP: '', IX: '' }

let currentSessionClient: SupabaseClient
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => currentSessionClient,
}))

async function createAppUserSession(
  label: string,
  role: 'admin' | 'organizer',
  active = true,
): Promise<{ session: SupabaseClient; id: string; email: string }> {
  const email = `iexp-${label}-${randomUUID()}@test.invalid`
  const pass = `Iexp-${label}-${Date.now()}!`
  const { data: authData, error: authErr } = await svc.auth.admin.createUser({
    email, password: pass, email_confirm: true,
  })
  if (authErr || !authData.user) throw new Error(`createUser (${label}): ${authErr?.message}`)
  authUserIds.push(authData.user.id)

  const { error: appErr } = await svc
    .from('app_users')
    .insert({ id: authData.user.id, email, full_name: `IEXP Test ${label}`, role, active })
  if (appErr) throw new Error(`insert app_user (${label}): ${appErr.message}`)

  const session = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { error: signInErr } = await session.auth.signInWithPassword({ email, password: pass })
  if (signInErr) throw new Error(`sign-in (${label}): ${signInErr.message}`)
  return { session, id: authData.user.id, email }
}

async function insertPerson(full_name: string, phone: string, attrs: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await svc.from('people').insert({ phone_e164: phone, full_name, ...attrs }).select('id').single()
  if (error) throw new Error(`insert person ${full_name}: ${error.message}`)
  peopleIds.push(data.id)
  return data.id
}

async function insertInstance(scheduledAt: string): Promise<string> {
  const { data, error } = await svc
    .from('event_instances')
    .insert({ event_id: eventId, scheduled_at: scheduledAt, event_name_snapshot: EVENT_NAME, event_name_snapshot_id: EVENT_NAME, status: 'completed' })
    .select('id')
    .single()
  if (error) throw new Error(`insert instance: ${error.message}`)
  return data.id
}

async function insertChild(name: string, parentId: string): Promise<string> {
  const { data, error } = await svc.from('children').insert({ parent_person_id: parentId, full_name: name, birth_date: '2018-03-04' }).select('id').single()
  if (error) throw new Error(`insert child: ${error.message}`)
  childIds.push(data.id)
  return data.id
}

beforeAll(async () => {
  svc = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
  anonSession = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })

  const admin = await createAppUserSession('admin', 'admin')
  adminSession = admin.session; adminId = admin.id; adminEmail = admin.email
  const organizer = await createAppUserSession('organizer', 'organizer')
  organizerSession = organizer.session; organizerId = organizer.id; organizerEmail = organizer.email
  deactivatedAdminSession = (await createAppUserSession('deactivated', 'admin', false)).session

  const { data: event, error: eErr } = await svc.from('events').insert({
    name: EVENT_NAME, name_id: EVENT_NAME, event_type: 'adhoc',
    start_date: '2026-05-01', start_time: '18:00', recurrence_rule: null, created_by: adminId,
  }).select('id').single()
  if (eErr) throw new Error(`insert event: ${eErr.message}`)
  eventId = event.id

  inst.IP = await insertInstance('2026-05-01T11:00:00Z')
  inst.IE = await insertInstance('2026-06-01T18:00:00Z')
  inst.IX = await insertInstance('2026-06-03T11:00:00Z')

  const e1 = await insertPerson('IEXP Person E1', PHONES.E1, { nickname: PAYLOAD, origin_parish: 'IEXP Parish', email: 'e1@test.invalid' })
  const e2 = await insertPerson('IEXP Person E2', PHONES.E2, { nickname: 'E2' })
  const e3 = await insertPerson('IEXP Person E3', PHONES.E3, { nickname: 'E3', deleted_at: '2026-06-10T00:00:00Z' })
  const ex = await insertPerson('IEXP Person EX', PHONES.EX, { nickname: 'EX' })

  const { error: aErr } = await svc.from('attendance').insert([
    { person_id: e2, event_instance_id: inst.IP, checked_in_at: '2026-05-01T11:10:00Z', checked_in_by: adminId },
    { person_id: e1, event_instance_id: inst.IE, checked_in_at: '2026-06-01T18:05:00Z', checked_in_by: adminId },
    { person_id: e2, event_instance_id: inst.IE, checked_in_at: '2026-06-01T18:06:00Z', checked_in_by: organizerId },
    { person_id: e3, event_instance_id: inst.IE, checked_in_at: '2026-06-01T18:07:00Z', checked_in_by: adminId },
    { person_id: ex, event_instance_id: inst.IX, checked_in_at: '2026-06-03T11:05:00Z', checked_in_by: adminId },
  ])
  if (aErr) throw new Error(`insert attendance: ${aErr.message}`)

  const k = await insertChild('IEXP Child K', e1)
  const kx = await insertChild('IEXP Child KX', ex)
  const { error: cErr } = await svc.from('child_attendance').insert([
    { child_id: k, event_instance_id: inst.IE, checked_in_at: '2026-06-01T18:20:00Z', checked_in_by: adminId },
    { child_id: kx, event_instance_id: inst.IX, checked_in_at: '2026-06-03T11:20:00Z', checked_in_by: adminId },
  ])
  if (cErr) throw new Error(`insert child_attendance: ${cErr.message}`)
}, 60_000)

afterAll(async () => {
  if (!svc) return
  const instIds = Object.values(inst).filter(Boolean)
  if (instIds.length > 0) {
    await svc.from('child_attendance').delete().in('event_instance_id', instIds)
    await svc.from('attendance').delete().in('event_instance_id', instIds)
  }
  if (childIds.length > 0) await svc.from('children').delete().in('id', childIds)
  if (instIds.length > 0) await svc.from('event_instances').delete().in('id', instIds)
  if (eventId) await svc.from('events').delete().eq('id', eventId)
  if (peopleIds.length > 0) await svc.from('people').delete().in('id', peopleIds)
  if (authUserIds.length > 0) {
    await svc.from('audit_log').delete().in('actor_user_id', authUserIds)
    await svc.from('app_users').delete().in('id', authUserIds)
    for (const id of authUserIds) await svc.auth.admin.deleteUser(id)
  }
}, 60_000)

async function countInstanceExportAudits(): Promise<number> {
  const { count, error } = await svc
    .from('audit_log')
    .select('id', { count: 'exact', head: true })
    .eq('action', 'export.create')
    .eq('entity_type', 'export')
    .in('actor_user_id', authUserIds)
  if (error) throw new Error(`count audit: ${error.message}`)
  return count ?? 0
}

async function callExport(session: SupabaseClient, instanceId: string): Promise<Response> {
  currentSessionClient = session
  const { GET } = await import('@/app/api/admin/export/instance/[instanceId]/route')
  return GET(
    new NextRequest(`http://localhost/api/admin/export/instance/${instanceId}`),
    { params: Promise.resolve({ instanceId }) },
  )
}

async function readWorkbook(res: Response): Promise<XLSX.WorkBook> {
  return XLSX.read(new Uint8Array(await res.arrayBuffer()), { type: 'array' })
}

function sheetRows(wb: XLSX.WorkBook, name: string): Record<string, unknown>[] {
  return XLSX.utils.sheet_to_json(wb.Sheets[name]!) as Record<string, unknown>[]
}

function sheetHeaders(wb: XLSX.WorkBook, name: string): unknown[] {
  return (XLSX.utils.sheet_to_json(wb.Sheets[name]!, { header: 1 }) as unknown[][])[0] ?? []
}

describe('GET /api/admin/export/instance/[instanceId] — gate', () => {
  it('unauthenticated -> 401, no audit row', async () => {
    const before = await countInstanceExportAudits()
    expect((await callExport(anonSession, inst.IE)).status).toBe(401)
    expect(await countInstanceExportAudits()).toBe(before)
  })

  it('organizer -> 403, no audit row', async () => {
    const before = await countInstanceExportAudits()
    expect((await callExport(organizerSession, inst.IE)).status).toBe(403)
    expect(await countInstanceExportAudits()).toBe(before)
  })

  it('deactivated admin -> 403, no audit row', async () => {
    const before = await countInstanceExportAudits()
    expect((await callExport(deactivatedAdminSession, inst.IE)).status).toBe(403)
    expect(await countInstanceExportAudits()).toBe(before)
  })

  it('malformed id -> 400, unknown id -> 404, no audit rows', async () => {
    const before = await countInstanceExportAudits()
    expect((await callExport(adminSession, 'not-a-uuid')).status).toBe(400)
    expect((await callExport(adminSession, randomUUID())).status).toBe(404)
    expect(await countInstanceExportAudits()).toBe(before)
  })
})

describe('GET /api/admin/export/instance/[instanceId] — admin 200', () => {
  it('xlsx headers + WIB-dated filename', async () => {
    const res = await callExport(adminSession, inst.IE)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    // 2026-06-01T18:00Z is 2026-06-02 in WIB
    expect(res.headers.get('Content-Disposition'))
      .toBe(`attachment; filename="attendees_2026-06-02_${inst.IE.slice(0, 8)}.xlsx"`)
  })

  it('Adults sheet: exact human headers, only this instance, soft-deleted excluded, masked phones, per-row checker, first-timer', async () => {
    const wb = await readWorkbook(await callExport(adminSession, inst.IE))
    expect(wb.SheetNames).toEqual(['Adults', 'Children'])
    expect(sheetHeaders(wb, 'Adults'))
      .toEqual(['Name', 'Nickname', 'Phone (last 4)', 'Checked in (WIB)', 'First-timer', 'Checked in by'])

    const rows = sheetRows(wb, 'Adults')
    expect(rows.map(r => r.Name)).toEqual(['IEXP Person E1', 'IEXP Person E2'])

    expect(rows[0]).toMatchObject({
      'Phone (last 4)': '•••• 9101',
      'Checked in (WIB)': '2026-06-02 01:05',
      'First-timer': 'Yes',
      'Checked in by': adminEmail,
    })
    expect(rows[1]).toMatchObject({
      Nickname: 'E2',
      'Phone (last 4)': '•••• 9102',
      'First-timer': 'No',
      'Checked in by': organizerEmail,
    })
  })

  it('sanitiser applied: formula nickname is quote-prefixed', async () => {
    const wb = await readWorkbook(await callExport(adminSession, inst.IE))
    expect(sheetRows(wb, 'Adults')[0]!.Nickname).toBe(`'${PAYLOAD}`)
  })

  it('Children sheet: headers, this instance only, parent masked phone, no birth date', async () => {
    const wb = await readWorkbook(await callExport(adminSession, inst.IE))
    expect(sheetHeaders(wb, 'Children'))
      .toEqual(['Child name', 'Parent name', 'Parent phone (last 4)', 'Checked in (WIB)'])
    expect(sheetRows(wb, 'Children')).toEqual([
      {
        'Child name': 'IEXP Child K',
        'Parent name': 'IEXP Person E1',
        'Parent phone (last 4)': '•••• 9101',
        'Checked in (WIB)': '2026-06-02 01:20',
      },
    ])
  })

  it('no full phone, parish, email or birth date anywhere in the workbook', async () => {
    const wb = await readWorkbook(await callExport(adminSession, inst.IE))
    const allText = wb.SheetNames.map(n => XLSX.utils.sheet_to_csv(wb.Sheets[n]!)).join('\n')
    for (const phone of Object.values(PHONES)) expect(allText).not.toContain(phone.slice(1))
    expect(allText).not.toContain('IEXP Parish')
    expect(allText).not.toContain('e1@test.invalid')
    expect(allText).not.toContain('2018-03-04')
  })

  it('empty Children sheet still carries its header row', async () => {
    const wb = await readWorkbook(await callExport(adminSession, inst.IP))
    expect(sheetRows(wb, 'Children')).toEqual([])
    expect(sheetHeaders(wb, 'Children'))
      .toEqual(['Child name', 'Parent name', 'Parent phone (last 4)', 'Checked in (WIB)'])
  })

  it('exactly one export.create audit row: kind + instance id + row counts, no PII', async () => {
    const before = await countInstanceExportAudits()
    expect((await callExport(adminSession, inst.IE)).status).toBe(200)
    expect(await countInstanceExportAudits()).toBe(before + 1)

    const { data, error } = await svc
      .from('audit_log')
      .select('details_json, actor_user_id, entity_type')
      .eq('action', 'export.create')
      .eq('actor_user_id', adminId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single()
    if (error) throw new Error(`audit readback: ${error.message}`)

    expect(data.entity_type).toBe('export')
    expect(data.details_json).toEqual({
      export_kind: 'instance_attendees',
      event_instance_id: inst.IE,
      row_counts: { adults: 2, children: 1 },
    })
    const serialized = JSON.stringify(data.details_json)
    expect(serialized).not.toContain('IEXP Person')
    expect(serialized).not.toContain(PHONES.E1)
  })
})
