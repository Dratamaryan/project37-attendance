// Integration tests for Sprint 9 R5 — RSVP retention
// (20261026120000_sprint9_r5_rsvp_retention.sql): run_rsvp_retention_pass(),
// the event_rsvps scrub inside anonymize_person(), and the frozen
// retained_person_id link read by rsvp_checkin_crosstab.
// Runs against local Docker Supabase only (configured in .env.test.local).
// Catalog privileges go through psql inside the local DB container, as in
// rsvp-admin.test.ts. Run: npm test -- rsvp-retention
//
// Instance dates are built from the DB's own WIB "today" (D), so the 90-day
// boundary is controlled by fixture dates, never by moving the clock.
// Synthetic fixture (phone space +62999009350xx — S9-R5, unused elsewhere):
//   IA      completed, ends D-200 (eligible) — T1/T3/T4:
//     a  member A matched at submit, coming, checked in      -> coming_came
//     b  newcomer, phone later registered as person B,
//        B checked in (resolved via phone at read time)      -> coming_came
//     c  newcomer, phone never on the roster                 -> maybe_no_show
//     d  newcomer whose phone belongs to SOFT-DELETED person D;
//        D checked in -> not resolved, D is a walk-in        -> not_coming_no_show
//     e  member E matched at submit, later soft-deleted      -> coming_no_show
//     f  W checked in, no RSVP                               -> walk_in
//   I90     ends D-90 (NOT eligible)          I91    ends D-91 (eligible)
//   IMID    starts D-91 23:00 WIB, 120 min -> ends D-90 01:00 WIB (NOT eligible)
//   ICAN    cancelled, ends D-91 (eligible)   ICAN90 cancelled, ends D-90 (NOT)
//   IP1/IP2 completed, end D-5 (never eligible) — T6:
//     L  live member: IP1 row matched (person_id L); IP2 row newcomer on L's
//        phone (L registered after submitting), L checked in at IP2
//     S  IP1 row matched, then S soft-deleted; IP2 row newcomer on S's phone
//        submitted after the soft-delete (never resolved to S)

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { randomUUID } from 'crypto'

vi.mock('server-only', () => ({}))

import { impl_anonymizePerson } from '@/lib/actions/people.impl'
import { impl_getInstanceRsvpExport, impl_getInstanceRsvpPanel, impl_listPersonRsvpHistory } from '@/lib/rsvp/admin.impl'
import { mapRsvpToExportRow } from '@/lib/rsvp/export'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !anonKey || !serviceKey) {
  throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY')
}

const { hostname } = new URL(url)
if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
  throw new Error(
    `[rsvp-retention.test.ts] NEXT_PUBLIC_SUPABASE_URL (${hostname}) is not local Docker. This suite ` +
      `runs the global RSVP retention pass and anonymizes people — must run against local Docker only.`,
  )
}

const DB_CONTAINER = 'supabase_db_project37-rewrite'
const APP_URL = 'http://localhost:3000'
const FN = 'public.run_rsvp_retention_pass(uuid)'

function psql(sql: string): string {
  return execFileSync(
    'docker',
    ['exec', DB_CONTAINER, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atc', sql],
    { encoding: 'utf8' },
  ).trim()
}

const PHONES = {
  A: '+6299900935001',
  B: '+6299900935002',
  C: '+6299900935003',
  D: '+6299900935004',
  E: '+6299900935005',
  W: '+6299900935006',
  R90: '+6299900935007',
  R91: '+6299900935008',
  RMID: '+6299900935009',
  RCAN: '+6299900935010',
  RCAN90: '+6299900935011',
  L: '+6299900935012',
  S: '+6299900935013',
} as const
const EVENT_NAME = '[SYNTH] R5 Retention Event'

let svc: SupabaseClient
let anonSession: SupabaseClient
let adminSession: SupabaseClient
let adminId: string

const authUserIds: string[] = []
const peopleIds: string[] = []
let eventId: string
const inst = { IA: '', I90: '', I91: '', IMID: '', ICAN: '', ICAN90: '', IP1: '', IP2: '' }
const person = { A: '', B: '', D: '', E: '', W: '', L: '', S: '' }
const rsvp = {
  a: '', b: '', c: '', d: '', e: '',
  r90: '', r91: '', rmid: '', rcan: '', rcan90: '',
  l1: '', l2: '', s1: '', s2: '',
}

const ORIGINAL_FLAG = process.env.RSVP_PUBLIC_ENABLED
const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL

function setEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

/** 'YYYY-MM-DD' + n days (calendar arithmetic, no timezone involved). */
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** Instant of HH:00 WIB (UTC+7, no DST) on a WIB calendar date. */
function wibAt(date: string, hour: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCHours(hour - 7)
  return d.toISOString()
}

async function createAdminSession(): Promise<{ session: SupabaseClient; id: string }> {
  const email = `r5-admin-${randomUUID()}@example.com`
  const pass = `R5-admin-${Date.now()}!`
  const { data: authData, error: authErr } = await svc.auth.admin.createUser({
    email, password: pass, email_confirm: true,
  })
  if (authErr || !authData.user) throw new Error(`createUser: ${authErr?.message}`)
  authUserIds.push(authData.user.id)

  const { error: appErr } = await svc
    .from('app_users')
    .insert({ id: authData.user.id, email, full_name: '[SYNTH] R5 admin', role: 'admin', active: true })
  if (appErr) throw new Error(`insert app_user: ${appErr.message}`)

  const session = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { error: signInErr } = await session.auth.signInWithPassword({ email, password: pass })
  if (signInErr) throw new Error(`sign-in: ${signInErr.message}`)
  return { session, id: authData.user.id }
}

async function insertPerson(label: string, phone: string): Promise<string> {
  const { data, error } = await svc.from('people')
    .insert({ phone_e164: phone, full_name: `[SYNTH] R5 ${label}`, nickname: label })
    .select('id').single()
  if (error) throw new Error(`insert person ${label}: ${error.message}`)
  peopleIds.push(data.id)
  return data.id
}

async function softDelete(personId: string): Promise<void> {
  const { error } = await svc.from('people').update({ deleted_at: new Date().toISOString() }).eq('id', personId)
  if (error) throw new Error(`soft-delete: ${error.message}`)
}

async function insertInstance(scheduledAt: string, status: 'scheduled' | 'completed' | 'cancelled'): Promise<string> {
  const { data, error } = await svc
    .from('event_instances')
    .insert({ event_id: eventId, scheduled_at: scheduledAt, event_name_snapshot: EVENT_NAME, event_name_snapshot_id: EVENT_NAME, status })
    .select('id')
    .single()
  if (error) throw new Error(`insert instance: ${error.message}`)
  return data.id
}

async function insertLink(instanceId: string): Promise<string> {
  const { data, error } = await svc.from('event_rsvp_links')
    .insert({ event_instance_id: instanceId, created_by: adminId })
    .select('id').single()
  if (error) throw new Error(`insert link: ${error.message}`)
  return data.id
}

type RsvpFixture = {
  phone: string
  name?: string | null
  children?: number
  status: 'coming' | 'maybe' | 'not_coming'
  personId: string | null
  followup?: boolean
}
async function insertRsvp(instanceId: string, linkId: string, r: RsvpFixture): Promise<string> {
  const { data, error } = await svc.from('event_rsvps').insert({
    event_instance_id: instanceId,
    link_id: linkId,
    phone_e164: r.phone,
    name: r.name ?? null,
    children_count: r.children ?? 0,
    followup_consent: r.followup ?? false,
    status: r.status,
    person_id: r.personId,
  }).select('id').single()
  if (error) throw new Error(`insert rsvp: ${error.message}`)
  return data.id
}

/** One-RSVP instance for the eligibility-boundary cases. */
async function boundaryInstance(scheduledAt: string, status: 'completed' | 'cancelled', phone: string): Promise<{ instanceId: string; rsvpId: string }> {
  const instanceId = await insertInstance(scheduledAt, status)
  const linkId = await insertLink(instanceId)
  const rsvpId = await insertRsvp(instanceId, linkId, { phone, name: '[SYNTH] R5 Boundary', status: 'coming', personId: null })
  return { instanceId, rsvpId }
}

async function checkIn(instanceId: string, personId: string): Promise<void> {
  const { error } = await svc.from('attendance')
    .insert({ event_instance_id: instanceId, person_id: personId, checked_in_by: adminId })
  if (error) throw new Error(`insert attendance: ${error.message}`)
}

type RsvpDbRow = {
  id: string
  phone_e164: string | null
  name: string | null
  person_id: string | null
  retained_person_id: string | null
  anonymized_at: string | null
  followup_consent: boolean
  status: string
  children_count: number
  updated_at: string
}
async function getRsvp(id: string): Promise<RsvpDbRow> {
  const { data, error } = await svc.from('event_rsvps')
    .select('id, phone_e164, name, person_id, retained_person_id, anonymized_at, followup_consent, status, children_count, updated_at')
    .eq('id', id).single()
  if (error) throw new Error(`read rsvp: ${error.message}`)
  return data as RsvpDbRow
}

type ViewRow = {
  event_instance_id: string
  rsvp_id: string | null
  attendance_id: string | null
  resolved_person_id: string | null
  matched_at_submit: boolean
  rsvp_status: string | null
  children_count: number | null
  attended: boolean
  bucket: string
}
async function crosstab(instanceId: string): Promise<ViewRow[]> {
  const { data, error } = await adminSession.from('rsvp_checkin_crosstab')
    .select('*')
    .eq('event_instance_id', instanceId)
    .order('rsvp_id', { ascending: true, nullsFirst: true })
    .order('attendance_id', { ascending: true, nullsFirst: true })
  if (error) throw new Error(`view read: ${error.message}`)
  return data as ViewRow[]
}

async function panelShape(instanceId: string) {
  const result = await impl_getInstanceRsvpPanel(instanceId, adminSession)
  if (result.status !== 'ok') throw new Error(`panel: ${result.status}`)
  const { totals, buckets, children, rows } = result.panel
  return {
    totals,
    buckets,
    children,
    rows: rows.map(r => ({
      rsvp_id: r.rsvp_id, display_kind: r.display_kind, display_name: r.display_name, status: r.status,
      children_count: r.children_count, attended: r.attended, updated_at: r.updated_at,
    })),
  }
}

type AuditRow = { actor_user_id: string | null; entity_type: string; entity_id: string; details_json: Record<string, unknown> }
async function rsvpAnonymizeAudits(instanceIds: string[]): Promise<AuditRow[]> {
  const { data, error } = await svc.from('audit_log')
    .select('actor_user_id, entity_type, entity_id, details_json')
    .eq('action', 'rsvp.anonymize')
    .in('entity_id', instanceIds)
  if (error) throw new Error(`audit read: ${error.message}`)
  return (data ?? []) as AuditRow[]
}

async function runPass(): Promise<number> {
  const { data, error } = await svc.rpc('run_rsvp_retention_pass', { p_actor_user_id: null })
  if (error) throw new Error(`run_rsvp_retention_pass: ${error.message}`)
  return data as number
}

beforeAll(async () => {
  svc = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
  anonSession = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })

  const admin = await createAdminSession()
  adminSession = admin.session; adminId = admin.id

  const { data: event, error: eErr } = await svc.from('events').insert({
    name: EVENT_NAME, name_id: EVENT_NAME, event_type: 'adhoc',
    start_date: '2026-01-01', start_time: '10:00', duration_min: 120, recurrence_rule: null, created_by: adminId,
  }).select('id').single()
  if (eErr) throw new Error(`insert event: ${eErr.message}`)
  eventId = event.id

  const today = psql(`SELECT (now() AT TIME ZONE 'Asia/Jakarta')::date`)

  // ── IA ──
  inst.IA = await insertInstance(wibAt(addDays(today, -200), 10), 'completed')
  const linkA = await insertLink(inst.IA)
  person.A = await insertPerson('A', PHONES.A)
  person.D = await insertPerson('D', PHONES.D)
  await softDelete(person.D)
  person.E = await insertPerson('E', PHONES.E)
  person.W = await insertPerson('W', PHONES.W)

  rsvp.a = await insertRsvp(inst.IA, linkA, { phone: PHONES.A, children: 1, status: 'coming', personId: person.A, followup: true })
  rsvp.b = await insertRsvp(inst.IA, linkA, { phone: PHONES.B, name: '[SYNTH] R5 Newcomer B', children: 2, status: 'coming', personId: null, followup: true })
  rsvp.c = await insertRsvp(inst.IA, linkA, { phone: PHONES.C, name: '[SYNTH] R5 Newcomer C', status: 'maybe', personId: null })
  rsvp.d = await insertRsvp(inst.IA, linkA, { phone: PHONES.D, name: '[SYNTH] R5 Newcomer D', status: 'not_coming', personId: null })
  rsvp.e = await insertRsvp(inst.IA, linkA, { phone: PHONES.E, status: 'coming', personId: person.E })

  person.B = await insertPerson('B', PHONES.B)   // registered at the door after the RSVP
  await softDelete(person.E)
  for (const p of [person.A, person.B, person.D, person.W]) await checkIn(inst.IA, p)

  // ── boundary ──
  ;({ instanceId: inst.I90, rsvpId: rsvp.r90 } = await boundaryInstance(wibAt(addDays(today, -90), 10), 'completed', PHONES.R90))
  ;({ instanceId: inst.I91, rsvpId: rsvp.r91 } = await boundaryInstance(wibAt(addDays(today, -91), 10), 'completed', PHONES.R91))
  ;({ instanceId: inst.IMID, rsvpId: rsvp.rmid } = await boundaryInstance(wibAt(addDays(today, -91), 23), 'completed', PHONES.RMID))
  ;({ instanceId: inst.ICAN, rsvpId: rsvp.rcan } = await boundaryInstance(wibAt(addDays(today, -91), 11), 'cancelled', PHONES.RCAN))
  ;({ instanceId: inst.ICAN90, rsvpId: rsvp.rcan90 } = await boundaryInstance(wibAt(addDays(today, -90), 11), 'cancelled', PHONES.RCAN90))

  // ── IP1 / IP2 ──
  inst.IP1 = await insertInstance(wibAt(addDays(today, -6), 10), 'completed')
  inst.IP2 = await insertInstance(wibAt(addDays(today, -5), 10), 'completed')
  const linkP1 = await insertLink(inst.IP1)
  const linkP2 = await insertLink(inst.IP2)
  person.S = await insertPerson('S', PHONES.S)
  rsvp.l2 = await insertRsvp(inst.IP2, linkP2, { phone: PHONES.L, name: '[SYNTH] R5 Newcomer L', status: 'coming', personId: null })
  person.L = await insertPerson('L', PHONES.L)
  rsvp.l1 = await insertRsvp(inst.IP1, linkP1, { phone: PHONES.L, status: 'coming', personId: person.L })
  rsvp.s1 = await insertRsvp(inst.IP1, linkP1, { phone: PHONES.S, status: 'maybe', personId: person.S })
  await softDelete(person.S)
  rsvp.s2 = await insertRsvp(inst.IP2, linkP2, { phone: PHONES.S, name: '[SYNTH] R5 Newcomer S', status: 'coming', personId: null })
  await checkIn(inst.IP2, person.L)
}, 60_000)

afterAll(async () => {
  setEnv('RSVP_PUBLIC_ENABLED', ORIGINAL_FLAG)
  setEnv('NEXT_PUBLIC_APP_URL', ORIGINAL_APP_URL)
  if (!svc) return
  const instIds = Object.values(inst).filter(Boolean)
  if (instIds.length > 0) {
    await svc.from('audit_log').delete().eq('action', 'rsvp.anonymize').in('entity_id', instIds)
    await svc.from('event_rsvps').delete().in('event_instance_id', instIds)
    await svc.from('event_rsvp_links').delete().in('event_instance_id', instIds)
    await svc.from('attendance').delete().in('event_instance_id', instIds)
    await svc.from('event_instances').delete().in('id', instIds)
  }
  if (eventId) await svc.from('events').delete().eq('id', eventId)
  if (peopleIds.length > 0) await svc.from('people').delete().in('id', peopleIds)
  if (authUserIds.length > 0) {
    await svc.from('audit_log').delete().in('actor_user_id', authUserIds)
    await svc.from('app_users').delete().in('id', authUserIds)
    for (const id of authUserIds) await svc.auth.admin.deleteUser(id)
  }
}, 60_000)

beforeEach(() => {
  setEnv('RSVP_PUBLIC_ENABLED', 'true')
  setEnv('NEXT_PUBLIC_APP_URL', APP_URL)
})

// ── T1 core invariant + T3 scrub + T4 idempotence (one pass, in order) ──────

describe('run_rsvp_retention_pass — core invariant', () => {
  let before: { crosstab: ViewRow[]; panel: Awaited<ReturnType<typeof panelShape>>; historyB: unknown }
  let rowsBefore: Record<string, RsvpDbRow>
  let firstCount: number

  beforeAll(async () => {
    const historyB = await impl_listPersonRsvpHistory(person.B, adminSession, 'en')
    before = { crosstab: await crosstab(inst.IA), panel: await panelShape(inst.IA), historyB }
    rowsBefore = Object.fromEntries(await Promise.all(
      (['a', 'b', 'c', 'd', 'e'] as const).map(async k => [k, await getRsvp(rsvp[k])] as const),
    ))
    firstCount = await runPass()
  }, 30_000)

  it('T1 fixture sanity: the pre-pass cross-tab is the hand-computed one', () => {
    const byRsvp = Object.fromEntries(before.crosstab.filter(r => r.rsvp_id).map(r => [r.rsvp_id!, r]))
    expect(byRsvp[rsvp.a]).toMatchObject({ bucket: 'coming_came', resolved_person_id: person.A })
    expect(byRsvp[rsvp.b]).toMatchObject({ bucket: 'coming_came', resolved_person_id: person.B, matched_at_submit: false })
    expect(byRsvp[rsvp.c]).toMatchObject({ bucket: 'maybe_no_show', resolved_person_id: null })
    expect(byRsvp[rsvp.d]).toMatchObject({ bucket: 'not_coming_no_show', resolved_person_id: null })
    expect(byRsvp[rsvp.e]).toMatchObject({ bucket: 'coming_no_show', resolved_person_id: person.E })
    expect(before.crosstab.filter(r => r.bucket === 'walk_in').map(r => r.resolved_person_id).sort())
      .toEqual([person.D, person.W].sort())
  })

  it('T1 cross-tab deep-equals the pre-pass snapshot (every resolved_person_id and bucket)', async () => {
    expect(await crosstab(inst.IA)).toEqual(before.crosstab)
  })

  it('T1 panel totals, buckets, children and per-row resolution unchanged; only newcomers\' typed names gone', async () => {
    const after = await panelShape(inst.IA)
    const typedNames = new Set([rsvp.c, rsvp.d])
    expect(after).toEqual({
      ...before.panel,
      rows: before.panel.rows.map(r => (typedNames.has(r.rsvp_id) ? { ...r, display_name: null } : r)),
    })
    // (a) via person_id and (b) via the frozen link keep their roster names.
    expect(after.rows.find(r => r.rsvp_id === rsvp.a)).toMatchObject({ display_kind: 'member', display_name: '[SYNTH] R5 A' })
    expect(after.rows.find(r => r.rsvp_id === rsvp.b)).toMatchObject({ display_kind: 'member', display_name: '[SYNTH] R5 B' })
  })

  it('T1 person history of the door-registered newcomer (b) unchanged', async () => {
    const historyB = await impl_listPersonRsvpHistory(person.B, adminSession, 'en')
    expect(historyB).toEqual(before.historyB)
    expect(historyB).toMatchObject({ status: 'ok', rows: [{ rsvp_id: rsvp.b, attended: true }] })
  })

  it('T3 scrub: phone/name NULL, anonymized_at set; person_id, followup, status, children, updated_at kept', async () => {
    expect(firstCount).toBeGreaterThanOrEqual(7) // IA 5 + I91 + ICAN; other rows in the local DB may also qualify
    for (const k of ['a', 'b', 'c', 'd', 'e'] as const) {
      const pre = rowsBefore[k]
      const post = await getRsvp(rsvp[k])
      expect(post).toMatchObject({
        phone_e164: null,
        name: null,
        person_id: pre.person_id,
        followup_consent: pre.followup_consent,
        status: pre.status,
        children_count: pre.children_count,
      })
      expect(post.anonymized_at).not.toBeNull()
      expect(post.updated_at).toBe(pre.updated_at) // still "last answer change"
    }
  })

  it('T3 frozen links: only (b) gets retained_person_id; (d) soft-deleted phone owner gets none', async () => {
    expect((await getRsvp(rsvp.b)).retained_person_id).toBe(person.B)
    for (const k of ['a', 'c', 'd', 'e'] as const) {
      expect((await getRsvp(rsvp[k])).retained_person_id).toBeNull()
    }
  })

  it('T4 one audit row per changed instance: actor NULL, rows count, trigger; no phone/name', async () => {
    const audits = await rsvpAnonymizeAudits(Object.values(inst))
    expect(audits.map(a => a.entity_id).sort()).toEqual([inst.IA, inst.I91, inst.ICAN].sort())
    const ia = audits.find(a => a.entity_id === inst.IA)!
    expect(ia).toMatchObject({ actor_user_id: null, entity_type: 'event_instances' })
    expect(ia.details_json).toEqual({ instance_id: inst.IA, rows: 5, trigger: 'scheduled_retention_pass' })
    for (const a of audits.filter(x => x.entity_id !== inst.IA)) expect(a.details_json).toMatchObject({ rows: 1 })
  })

  it('T4 idempotent: second run returns 0, rows untouched, no second audit row', async () => {
    const snapshot = await getRsvp(rsvp.b)
    expect(await runPass()).toBe(0)
    expect(await getRsvp(rsvp.b)).toEqual(snapshot)
    expect(await rsvpAnonymizeAudits(Object.values(inst))).toHaveLength(3)
  })
})

// ── B2 panel + export of scrubbed rows — after the pass above ───────────────

describe('panel + export after the pass (S9-R5 B2)', () => {
  it('panel: every IA row flagged anonymized, phone null', async () => {
    const result = await impl_getInstanceRsvpPanel(inst.IA, adminSession)
    if (result.status !== 'ok') throw new Error(result.status)
    expect(result.panel.rows).toHaveLength(5)
    for (const r of result.panel.rows) expect(r).toMatchObject({ anonymized: true, phone_masked: null })
  })

  it('export: rows flagged anonymized with empty phone; consented rows no longer count as full-phone rows', async () => {
    const result = await impl_getInstanceRsvpExport(inst.IA, adminSession)
    if (result.status !== 'ok') throw new Error(result.status)
    expect(result.rows).toHaveLength(5)
    for (const r of result.rows) expect(r).toMatchObject({ anonymized: true, phone: '' })
    expect(result.rows.filter(r => r.followup_consent)).toHaveLength(2) // a, b keep the flag
    expect(result.full_phone_rows).toBe(0)
  })

  it('panel + export Name: roster name via person_id / frozen link, removed member, Anonymized for newcomers', async () => {
    const panel = await impl_getInstanceRsvpPanel(inst.IA, adminSession)
    const exported = await impl_getInstanceRsvpExport(inst.IA, adminSession)
    if (panel.status !== 'ok' || exported.status !== 'ok') throw new Error('load failed')

    const panelById = Object.fromEntries(panel.panel.rows.map(r => [r.rsvp_id, r]))
    expect(panelById[rsvp.a]).toMatchObject({ display_kind: 'member', display_name: '[SYNTH] R5 A' })
    expect(panelById[rsvp.b]).toMatchObject({ display_kind: 'member', display_name: '[SYNTH] R5 B' })
    expect(panelById[rsvp.c]).toMatchObject({ display_kind: 'newcomer', display_name: null })
    expect(panelById[rsvp.d]).toMatchObject({ display_kind: 'newcomer', display_name: null })
    expect(panelById[rsvp.e]).toMatchObject({ display_kind: 'removed_member', display_name: null })

    const names = Object.fromEntries(exported.rows.map(r => [r.rsvp_id, mapRsvpToExportRow(r).Name]))
    expect(names).toEqual({
      [rsvp.a]: '[SYNTH] R5 A',
      [rsvp.b]: '[SYNTH] R5 B',
      [rsvp.c]: 'Anonymized',
      [rsvp.d]: 'Anonymized',
      [rsvp.e]: 'Removed member',
    })
  })

  it('panel: a not-yet-eligible row is not flagged', async () => {
    const result = await impl_getInstanceRsvpPanel(inst.I90, adminSession)
    if (result.status !== 'ok') throw new Error(result.status)
    expect(result.panel.rows).toEqual([expect.objectContaining({ anonymized: false, phone_masked: expect.any(String) })])
  })
})

// ── T2 eligibility boundary (WIB) — asserted after the pass above ───────────

describe('run_rsvp_retention_pass — eligibility boundary', () => {
  it('end WIB date + 90 = today -> NOT eligible', async () => {
    expect(await getRsvp(rsvp.r90)).toMatchObject({ anonymized_at: null, phone_e164: PHONES.R90 })
  })

  it('end WIB date + 91 -> eligible', async () => {
    expect(await getRsvp(rsvp.r91)).toMatchObject({ phone_e164: null, name: null })
    expect((await getRsvp(rsvp.r91)).anonymized_at).not.toBeNull()
  })

  it('clock runs from the END: starts D-91 23:00 WIB but ends D-90 01:00 WIB -> NOT eligible', async () => {
    expect(await getRsvp(rsvp.rmid)).toMatchObject({ anonymized_at: null, phone_e164: PHONES.RMID })
  })

  it('cancelled instances use the same clock (D-91 eligible, D-90 not)', async () => {
    expect((await getRsvp(rsvp.rcan)).anonymized_at).not.toBeNull()
    expect(await getRsvp(rsvp.rcan90)).toMatchObject({ anonymized_at: null, phone_e164: PHONES.RCAN90 })
  })

  it('recent instances untouched by the pass', async () => {
    for (const id of [rsvp.l1, rsvp.l2, rsvp.s1, rsvp.s2]) {
      expect((await getRsvp(id)).anonymized_at).toBeNull()
    }
  })
})

// ── T5 fail-safe ─────────────────────────────────────────────────────────────

describe('app_settings.rsvp_retention_days', () => {
  it('defaults to 90', async () => {
    const { data, error } = await svc.from('app_settings').select('rsvp_retention_days').eq('id', 1).single()
    expect(error).toBeNull()
    expect(data).toEqual({ rsvp_retention_days: 90 })
  })

  it.each([0, -1])('cannot be set to %i (CHECK)', async (days) => {
    const { error } = await svc.from('app_settings').update({ rsvp_retention_days: days }).eq('id', 1)
    expect(error?.code).toBe('23514')
  })

  it('cannot be set to NULL (NOT NULL)', async () => {
    const { error } = await svc.from('app_settings').update({ rsvp_retention_days: null }).eq('id', 1)
    expect(error?.code).toBe('23502')
  })
})

// ── T6 anonymize_person scrubs the person's RSVPs ───────────────────────────

describe('anonymize_person — RSVP rows', () => {
  let ip1Before: ViewRow[]
  let ip2Before: ViewRow[]
  const updatedAtBefore: Record<string, string> = {}

  beforeAll(async () => {
    ip1Before = await crosstab(inst.IP1)
    ip2Before = await crosstab(inst.IP2)
    for (const id of [rsvp.l1, rsvp.l2, rsvp.s1, rsvp.s2]) updatedAtBefore[id] = (await getRsvp(id)).updated_at
  })

  async function anonymizeAudit(personId: string): Promise<Record<string, unknown>> {
    const { data, error } = await svc.from('audit_log')
      .select('details_json').eq('action', 'people.anonymize').eq('entity_id', personId)
    if (error) throw new Error(`audit read: ${error.message}`)
    expect(data).toHaveLength(1)
    return (data![0] as { details_json: Record<string, unknown> }).details_json
  }

  it('fixture sanity: L\'s newcomer row resolves to L by phone and counts as came', () => {
    expect(ip2Before.find(r => r.rsvp_id === rsvp.l2)).toMatchObject({ resolved_person_id: person.L, bucket: 'coming_came' })
    expect(ip2Before.find(r => r.rsvp_id === rsvp.s2)).toMatchObject({ resolved_person_id: null, bucket: 'coming_no_show' })
  })

  it('live member: own row scrubbed (person_id kept), newcomer row on their phone scrubbed AND frozen', async () => {
    const result = await impl_anonymizePerson({ supabase: adminSession, adminSupabase: svc, input: { personId: person.L } })
    expect(result).toEqual({ status: 'anonymized' })

    const l1 = await getRsvp(rsvp.l1)
    expect(l1).toMatchObject({ phone_e164: null, name: null, person_id: person.L, retained_person_id: null })
    expect(l1.anonymized_at).not.toBeNull()

    const l2 = await getRsvp(rsvp.l2)
    expect(l2).toMatchObject({ phone_e164: null, name: null, person_id: null, retained_person_id: person.L })
    expect(l2.anonymized_at).not.toBeNull()

    expect(await anonymizeAudit(person.L)).toMatchObject({ trigger: 'admin', rsvp_rows: 2 })
  })

  it('already soft-deleted person: own row and newcomer row scrubbed, newcomer row NOT frozen', async () => {
    const result = await impl_anonymizePerson({ supabase: adminSession, adminSupabase: svc, input: { personId: person.S } })
    expect(result).toEqual({ status: 'anonymized' })

    expect(await getRsvp(rsvp.s1)).toMatchObject({ phone_e164: null, person_id: person.S, retained_person_id: null })
    const s2 = await getRsvp(rsvp.s2)
    expect(s2).toMatchObject({ phone_e164: null, name: null, person_id: null, retained_person_id: null })
    expect(s2.anonymized_at).not.toBeNull()

    expect(await anonymizeAudit(person.S)).toMatchObject({ rsvp_rows: 2 })
  })

  it('updated_at of every scrubbed row unchanged (still "last answer change")', async () => {
    for (const id of [rsvp.l1, rsvp.l2, rsvp.s1, rsvp.s2]) {
      expect((await getRsvp(id)).updated_at).toBe(updatedAtBefore[id])
    }
  })

  it('cross-tab of both instances unchanged', async () => {
    expect(await crosstab(inst.IP1)).toEqual(ip1Before)
    expect(await crosstab(inst.IP2)).toEqual(ip2Before)
  })

  it('re-run on an anonymized person touches no RSVP row', async () => {
    const before = await getRsvp(rsvp.l2)
    const result = await impl_anonymizePerson({ supabase: adminSession, adminSupabase: svc, input: { personId: person.L } })
    expect(result).toEqual({ status: 'already_anonymized' })
    expect(await getRsvp(rsvp.l2)).toEqual(before)
  })
})

// ── T7 grants ────────────────────────────────────────────────────────────────

describe('run_rsvp_retention_pass — privileges', () => {
  it('catalog: anon and authenticated cannot EXECUTE, service_role can', () => {
    expect(psql(`SELECT has_function_privilege('anon', '${FN}', 'EXECUTE')`)).toBe('f')
    expect(psql(`SELECT has_function_privilege('authenticated', '${FN}', 'EXECUTE')`)).toBe('f')
    expect(psql(`SELECT has_function_privilege('service_role', '${FN}', 'EXECUTE')`)).toBe('t')
  })

  it('SECURITY DEFINER with search_path = public', () => {
    expect(psql(`SELECT prosecdef, proconfig FROM pg_proc WHERE oid = '${FN}'::regprocedure`))
      .toBe('t|{search_path=public}')
  })

  it('anon and admin sessions are refused over the API', async () => {
    for (const client of [anonSession, adminSession]) {
      const { data, error } = await client.rpc('run_rsvp_retention_pass', { p_actor_user_id: null })
      expect(data).toBeNull()
      expect(error).not.toBeNull()
    }
  })

  it('anonymize_person grants unchanged; view still security_invoker, anon has no privilege', () => {
    const anonPerson = 'public.anonymize_person(uuid,uuid,text)'
    expect(psql(`SELECT has_function_privilege('authenticated', '${anonPerson}', 'EXECUTE')`)).toBe('f')
    expect(psql(`SELECT has_function_privilege('service_role', '${anonPerson}', 'EXECUTE')`)).toBe('t')
    expect(psql(`SELECT reloptions FROM pg_class WHERE oid = 'public.rsvp_checkin_crosstab'::regclass`))
      .toBe('{security_invoker=on}')
    expect(psql(`SELECT has_table_privilege('anon', 'public.rsvp_checkin_crosstab', 'SELECT')`)).toBe('f')
  })
})
