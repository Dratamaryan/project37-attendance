// Integration tests for S9-R3b — GET /api/admin/export/instance/[instanceId]/rsvp.
// Runs against local Docker Supabase. Route module imported directly with
// @/lib/supabase/server mocked to a REAL session client (same pattern as
// instance-export-route.test.ts), so requireActiveAdmin + RLS run for real —
// and rsvp_checkin_crosstab, which is is_admin()-filtered, is read on the
// admin session exactly as in production.
//
// Synthetic fixture (phone space +62999009320xx — S9-R3b, unused elsewhere):
//   IE  linked instance, scheduled 2026-06-01T18:00Z = 2026-06-02 01:00 WIB
//       (proves the filename date is WIB, not UTC). RSVPs, in created order:
//     C1  member, coming, 2 children, consent, checked in      -> full phone
//     C2  newcomer, maybe, 0, consent, name is a formula payload -> full phone
//     N1  member, coming, 1, no consent, absent; updated later   -> masked
//     N2  newcomer, not_coming, 0, no consent, no name           -> masked
//     NP  newcomer, coming, 0, consent but NULL phone            -> ''
//     R   member, maybe, 1, no consent, soft-deleted after RSVP  -> masked
//     W   walk-in (checked in, no RSVP); KC1 = C1's child, checked in
//   IZ  instance with no link and no RSVPs (empty sheets)
//
// Hand-computed for IE:
//   responses 6; coming C1 N1 NP -> people 3, children 2+1+0 = 3, headcount 6;
//   maybe C2 R -> people 2, headcount 2 + 1 = 3; not_coming N2 -> 1.
//   buckets: coming_came 1 (C1), coming_no_show 2 (N1, NP), maybe_came 0,
//   maybe_no_show 2 (C2, R), not_coming_came 0, not_coming_no_show 1 (N2),
//   walk_in 1 (W). children expected 3, checked in 1. full_phone_rows 2.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { NextRequest } from 'next/server'
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { randomUUID } from 'crypto'
import * as XLSX from 'xlsx'

vi.mock('server-only', () => ({}))

import { impl_getInstanceRsvpExport, impl_getInstanceRsvpPanel } from '@/lib/rsvp/admin.impl'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !anonKey || !serviceKey) {
  throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY')
}

const PROD_PROJECT_REF = 'bftifxgdcmisasgvobuf'
if (url.includes(PROD_PROJECT_REF)) {
  throw new Error(
    `[rsvp-export-route.test.ts] NEXT_PUBLIC_SUPABASE_URL resolves to the PRODUCTION ` +
      `project (${PROD_PROJECT_REF}). This suite creates/deletes real auth users and people ` +
      `rows — must run against local Docker only.`,
  )
}

const PAYLOAD = '=HYPERLINK("x")'
const PHONES = {
  C1: '+6299900932001',
  C2: '+6299900932002',
  N1: '+6299900932003',
  N2: '+6299900932004',
  R:  '+6299900932005',
  W:  '+6299900932006',
} as const
const NON_CONSENT_PHONES = [PHONES.N1, PHONES.N2, PHONES.R]
const EVENT_NAME = '[SYNTH] RX Export Event'

let svc: SupabaseClient
let anonSession: SupabaseClient
let adminSession: SupabaseClient
let organizerSession: SupabaseClient
let adminId: string

const authUserIds: string[] = []
const peopleIds: string[] = []
const childIds: string[] = []
let eventId: string
const inst = { IE: '', IZ: '' }

const ORIGINAL_FLAG = process.env.RSVP_PUBLIC_ENABLED

let currentSessionClient: SupabaseClient
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => currentSessionClient,
}))

async function createAppUserSession(
  label: string,
  role: 'admin' | 'organizer',
): Promise<{ session: SupabaseClient; id: string }> {
  const email = `rx-${label}-${randomUUID()}@example.com`
  const pass = `Rx-${label}-${Date.now()}!`
  const { data: authData, error: authErr } = await svc.auth.admin.createUser({
    email, password: pass, email_confirm: true,
  })
  if (authErr || !authData.user) throw new Error(`createUser (${label}): ${authErr?.message}`)
  authUserIds.push(authData.user.id)

  const { error: appErr } = await svc
    .from('app_users')
    .insert({ id: authData.user.id, email, full_name: `[SYNTH] RX ${label}`, role, active: true })
  if (appErr) throw new Error(`insert app_user (${label}): ${appErr.message}`)

  const session = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { error: signInErr } = await session.auth.signInWithPassword({ email, password: pass })
  if (signInErr) throw new Error(`sign-in (${label}): ${signInErr.message}`)
  return { session, id: authData.user.id }
}

async function insertPerson(label: string, phone: string): Promise<string> {
  const { data, error } = await svc.from('people')
    .insert({ phone_e164: phone, full_name: `[SYNTH] RX ${label}`, nickname: label })
    .select('id').single()
  if (error) throw new Error(`insert person ${label}: ${error.message}`)
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

type RsvpFixture = {
  phone: string | null
  name?: string | null
  children: number
  status: 'coming' | 'maybe' | 'not_coming'
  personId: string | null
  consent: boolean
  createdAt: string
  updatedAt?: string
}
async function insertRsvp(linkId: string, r: RsvpFixture): Promise<string> {
  const { data, error } = await svc.from('event_rsvps').insert({
    event_instance_id: inst.IE,
    link_id: linkId,
    phone_e164: r.phone,
    name: r.name ?? null,
    children_count: r.children,
    followup_consent: r.consent,
    status: r.status,
    person_id: r.personId,
    created_at: r.createdAt,
    updated_at: r.updatedAt ?? r.createdAt,
  }).select('id').single()
  if (error) throw new Error(`insert rsvp: ${error.message}`)
  return data.id
}

beforeAll(async () => {
  svc = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
  anonSession = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })

  const admin = await createAppUserSession('admin', 'admin')
  adminSession = admin.session; adminId = admin.id
  organizerSession = (await createAppUserSession('organizer', 'organizer')).session

  const { data: event, error: eErr } = await svc.from('events').insert({
    name: EVENT_NAME, name_id: EVENT_NAME, event_type: 'adhoc',
    start_date: '2026-05-01', start_time: '18:00', recurrence_rule: null, created_by: adminId,
  }).select('id').single()
  if (eErr) throw new Error(`insert event: ${eErr.message}`)
  eventId = event.id

  inst.IE = await insertInstance('2026-06-01T18:00:00Z')
  inst.IZ = await insertInstance('2026-06-08T18:00:00Z')

  const c1 = await insertPerson('C1', PHONES.C1)
  const n1 = await insertPerson('N1', PHONES.N1)
  const r = await insertPerson('R', PHONES.R)
  const w = await insertPerson('W', PHONES.W)

  const { data: link, error: lErr } = await svc.from('event_rsvp_links')
    .insert({ event_instance_id: inst.IE, created_by: adminId }).select('id').single()
  if (lErr) throw new Error(`insert link: ${lErr.message}`)

  await insertRsvp(link.id, { phone: PHONES.C1, children: 2, status: 'coming', personId: c1, consent: true, createdAt: '2026-05-29T01:00:00Z' })
  await insertRsvp(link.id, { phone: PHONES.C2, name: PAYLOAD, children: 0, status: 'maybe', personId: null, consent: true, createdAt: '2026-05-29T02:00:00Z' })
  await insertRsvp(link.id, { phone: PHONES.N1, children: 1, status: 'coming', personId: n1, consent: false, createdAt: '2026-05-30T03:00:00Z', updatedAt: '2026-05-31T04:30:00Z' })
  await insertRsvp(link.id, { phone: PHONES.N2, name: null, children: 0, status: 'not_coming', personId: null, consent: false, createdAt: '2026-05-30T04:00:00Z' })
  await insertRsvp(link.id, { phone: null, name: '[SYNTH] RX No Phone', children: 0, status: 'coming', personId: null, consent: true, createdAt: '2026-05-30T05:00:00Z' })
  await insertRsvp(link.id, { phone: PHONES.R, children: 1, status: 'maybe', personId: r, consent: false, createdAt: '2026-05-30T06:00:00Z' })

  {
    const { error } = await svc.from('people').update({ deleted_at: '2026-06-01T00:00:00Z' }).eq('id', r)
    if (error) throw new Error(`soft-delete R: ${error.message}`)
  }

  const { error: aErr } = await svc.from('attendance').insert([
    { person_id: c1, event_instance_id: inst.IE, checked_in_by: adminId },
    { person_id: w, event_instance_id: inst.IE, checked_in_by: adminId },
  ])
  if (aErr) throw new Error(`insert attendance: ${aErr.message}`)

  const { data: kid, error: kErr } = await svc.from('children')
    .insert({ parent_person_id: c1, full_name: '[SYNTH] RX Child KC1', birth_date: '2019-01-01' }).select('id').single()
  if (kErr) throw new Error(`insert child: ${kErr.message}`)
  childIds.push(kid.id)
  const { error: caErr } = await svc.from('child_attendance')
    .insert({ child_id: kid.id, event_instance_id: inst.IE, checked_in_by: adminId })
  if (caErr) throw new Error(`insert child_attendance: ${caErr.message}`)
}, 60_000)

afterAll(async () => {
  if (ORIGINAL_FLAG === undefined) delete process.env.RSVP_PUBLIC_ENABLED
  else process.env.RSVP_PUBLIC_ENABLED = ORIGINAL_FLAG
  if (!svc) return
  const instIds = Object.values(inst).filter(Boolean)
  if (instIds.length > 0) {
    await svc.from('event_rsvps').delete().in('event_instance_id', instIds)
    await svc.from('event_rsvp_links').delete().in('event_instance_id', instIds)
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

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.RSVP_PUBLIC_ENABLED
  else process.env.RSVP_PUBLIC_ENABLED = ORIGINAL_FLAG
})

async function countRsvpExportAudits(): Promise<number> {
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
  const { GET } = await import('@/app/api/admin/export/instance/[instanceId]/rsvp/route')
  return GET(
    new NextRequest(`http://localhost/api/admin/export/instance/${instanceId}/rsvp`, {
      headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1', 'user-agent': 'rsvp-export-test' },
    }),
    { params: Promise.resolve({ instanceId }) },
  )
}

async function readWorkbook(res: Response): Promise<XLSX.WorkBook> {
  return XLSX.read(new Uint8Array(await res.arrayBuffer()), { type: 'array' })
}

function sheetRows(wb: XLSX.WorkBook, name: string): Record<string, unknown>[] {
  return XLSX.utils.sheet_to_json(wb.Sheets[name]!) as Record<string, unknown>[]
}

function sheetMatrix(wb: XLSX.WorkBook, name: string): unknown[][] {
  return XLSX.utils.sheet_to_json(wb.Sheets[name]!, { header: 1 }) as unknown[][]
}

const RESPONSE_HEADERS = ['Name', 'Type', 'Status', 'Children', 'Follow-up consent', 'Phone', 'Checked in', 'Submitted (WIB)', 'Updated (WIB)']

describe('GET /api/admin/export/instance/[instanceId]/rsvp — gate', () => {
  it('unauthenticated -> 401, no audit row', async () => {
    const before = await countRsvpExportAudits()
    expect((await callExport(anonSession, inst.IE)).status).toBe(401)
    expect(await countRsvpExportAudits()).toBe(before)
  })

  it('organizer -> 403, no audit row', async () => {
    const before = await countRsvpExportAudits()
    expect((await callExport(organizerSession, inst.IE)).status).toBe(403)
    expect(await countRsvpExportAudits()).toBe(before)
  })

  it('malformed id -> 400, unknown id -> 404, no audit rows', async () => {
    const before = await countRsvpExportAudits()
    expect((await callExport(adminSession, 'not-a-uuid')).status).toBe(400)
    expect((await callExport(adminSession, randomUUID())).status).toBe(404)
    expect(await countRsvpExportAudits()).toBe(before)
  })

  it('NOT gated by RSVP_PUBLIC_ENABLED: flag off -> still 200', async () => {
    process.env.RSVP_PUBLIC_ENABLED = 'false'
    expect((await callExport(adminSession, inst.IE)).status).toBe(200)
  })
})

describe('GET /api/admin/export/instance/[instanceId]/rsvp — admin 200', () => {
  it('xlsx headers + WIB-dated filename + export id', async () => {
    const res = await callExport(adminSession, inst.IE)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(res.headers.get('content-disposition'))
      .toBe(`attachment; filename="rsvp_2026-06-02_${inst.IE.slice(0, 8)}.xlsx"`)
    expect(res.headers.get('x-export-id')).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('Responses sheet: exact headers and rows; full phone only where consent', async () => {
    const wb = await readWorkbook(await callExport(adminSession, inst.IE))
    expect(wb.SheetNames).toEqual(['Responses', 'Summary'])
    expect(sheetMatrix(wb, 'Responses')[0]).toEqual(RESPONSE_HEADERS)
    expect(sheetRows(wb, 'Responses')).toEqual([
      {
        Name: '[SYNTH] RX C1', Type: 'Member', Status: 'Coming', Children: 2, 'Follow-up consent': 'Yes',
        Phone: PHONES.C1, 'Checked in': 'Yes', 'Submitted (WIB)': '2026-05-29 08:00', 'Updated (WIB)': '',
      },
      {
        Name: `'${PAYLOAD}`, Type: 'Newcomer', Status: 'Maybe', Children: 0, 'Follow-up consent': 'Yes',
        Phone: PHONES.C2, 'Checked in': 'No', 'Submitted (WIB)': '2026-05-29 09:00', 'Updated (WIB)': '',
      },
      {
        Name: '[SYNTH] RX N1', Type: 'Member', Status: 'Coming', Children: 1, 'Follow-up consent': 'No',
        Phone: '•••• 2003', 'Checked in': 'No', 'Submitted (WIB)': '2026-05-30 10:00', 'Updated (WIB)': '2026-05-31 11:30',
      },
      {
        Name: '(no name)', Type: 'Newcomer', Status: 'Not coming', Children: 0, 'Follow-up consent': 'No',
        Phone: '•••• 2004', 'Checked in': 'No', 'Submitted (WIB)': '2026-05-30 11:00', 'Updated (WIB)': '',
      },
      {
        Name: '[SYNTH] RX No Phone', Type: 'Newcomer', Status: 'Coming', Children: 0, 'Follow-up consent': 'Yes',
        Phone: '', 'Checked in': 'No', 'Submitted (WIB)': '2026-05-30 12:00', 'Updated (WIB)': '',
      },
      {
        Name: 'Removed member', Type: 'Removed member', Status: 'Maybe', Children: 1, 'Follow-up consent': 'No',
        Phone: '•••• 2005', 'Checked in': 'No', 'Submitted (WIB)': '2026-05-30 13:00', 'Updated (WIB)': '',
      },
    ])
  })

  it('sweep: no non-consent full phone (and no walk-in phone) appears anywhere in the workbook', async () => {
    const wb = await readWorkbook(await callExport(adminSession, inst.IE))
    const cells = wb.SheetNames.flatMap(n => sheetMatrix(wb, n).flat().map(v => String(v)))
    for (const phone of [...NON_CONSENT_PHONES, PHONES.W]) {
      expect(cells.some(c => c.includes(phone))).toBe(false)
      expect(cells.some(c => c.includes(phone.slice(1)))).toBe(false)   // nor the bare digits
    }
    // and the consented full phones are present, unprefixed (sheet-safe E.164 exemption)
    expect(cells).toContain(PHONES.C1)
    expect(cells).toContain(PHONES.C2)
  })

  it('sanitiser applied: formula name is quote-prefixed', async () => {
    const wb = await readWorkbook(await callExport(adminSession, inst.IE))
    const names = sheetRows(wb, 'Responses').map(r => r.Name)
    expect(names).toContain(`'${PAYLOAD}`)
    expect(names).not.toContain(PAYLOAD)
  })

  it('Summary sheet: label/value rows equal the hand-computed fixture', async () => {
    const wb = await readWorkbook(await callExport(adminSession, inst.IE))
    expect(sheetMatrix(wb, 'Summary')).toEqual([
      ['Metric', 'Value'],
      ['Total responses', 6],
      ['Coming (people)', 3],
      ['Expected headcount (food)', 6],
      ['Coming children', 3],
      ['Maybe (people)', 2],
      ['Maybe headcount', 3],
      ['Not coming', 1],
      ['Coming · came', 1],
      ["Coming · didn't come", 2],
      ['Maybe · came', 0],
      ["Maybe · didn't come", 2],
      ['Not coming · came anyway', 0],
      ["Not coming · didn't come", 1],
      ['Walk-in (no RSVP)', 1],
      ['Children expected', 3],
      ['Children checked in', 1],
    ])
  })

  it('empty instance -> Responses keeps its header row; Summary all zeros', async () => {
    const wb = await readWorkbook(await callExport(adminSession, inst.IZ))
    expect(sheetMatrix(wb, 'Responses')).toEqual([RESPONSE_HEADERS])
    const summary = sheetMatrix(wb, 'Summary')
    expect(summary[0]).toEqual(['Metric', 'Value'])
    expect(summary).toHaveLength(17)
    expect(summary.slice(1).every(row => row[1] === 0)).toBe(true)
  })

  it('exactly one export.create audit row: kind + instance id + counts + full_phone_rows, no PII', async () => {
    const before = await countRsvpExportAudits()
    const res = await callExport(adminSession, inst.IE)
    expect(res.status).toBe(200)
    expect(await countRsvpExportAudits()).toBe(before + 1)

    const { data, error } = await svc
      .from('audit_log')
      .select('details_json, actor_user_id, entity_type, entity_id, ip_address, user_agent')
      .eq('action', 'export.create')
      .eq('actor_user_id', adminId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single()
    if (error) throw new Error(`audit readback: ${error.message}`)

    expect(data.entity_type).toBe('export')
    expect(data.entity_id).toBe(res.headers.get('x-export-id'))
    expect(data.ip_address).toBe('203.0.113.7')
    expect(data.user_agent).toBe('rsvp-export-test')
    expect(data.details_json).toEqual({
      export_kind: 'instance_rsvps',
      event_instance_id: inst.IE,
      row_counts: { responses: 6 },
      full_phone_rows: 2,
    })
    const serialized = JSON.stringify(data.details_json)
    for (const phone of Object.values(PHONES)) expect(serialized).not.toContain(phone)
    expect(serialized).not.toContain('[SYNTH]')
    expect(serialized).not.toContain('HYPERLINK')
  })
})

describe('shared row builder — panel and export agree', () => {
  it('same rows, order, kinds, names, statuses and attended; panel phones always masked', async () => {
    const panel = await impl_getInstanceRsvpPanel(inst.IE, adminSession)
    const exp = await impl_getInstanceRsvpExport(inst.IE, adminSession)
    if (panel.status !== 'ok' || exp.status !== 'ok') throw new Error(`${panel.status}/${exp.status}`)

    const strip = (r: Record<string, unknown>) => {
      const { phone_masked: _pm, phone: _p, ...rest } = r
      return rest
    }
    expect(panel.panel.rows.map(strip)).toEqual(exp.rows.map(strip))
    expect(panel.panel.totals).toEqual(exp.totals)
    expect(panel.panel.buckets).toEqual(exp.buckets)
    expect(panel.panel.children).toEqual(exp.children)
    expect(exp.full_phone_rows).toBe(2)

    // panel never carries a full phone, even for consented rows
    const serializedPanel = JSON.stringify(panel.panel)
    for (const phone of Object.values(PHONES)) expect(serializedPanel).not.toContain(phone)
    expect(panel.panel.rows.map(r => r.phone_masked))
      .toEqual(['•••• 2001', '•••• 2002', '•••• 2003', '•••• 2004', null, '•••• 2005'])
  })

  it('organizer -> not_authorized from the export impl', async () => {
    expect(await impl_getInstanceRsvpExport(inst.IE, organizerSession)).toEqual({ status: 'not_authorized' })
  })
})
