// Integration tests for Sprint 6 Task 10a — people-roster Excel export.
// Runs against local Docker Supabase (configured in .env.test.local).
//
// Two halves, mirroring the two established export-test conventions:
//   - impl_getRosterRows scope + mapRosterRowToExportRow labels: same shape as
//     tests/integration/export-actions.test.ts (impl functions exercised
//     directly against a real signed-in admin session client).
//   - GET /api/admin/export/people gate + audit: same shape as
//     tests/integration/admin-api-active-check.test.ts (route module imported
//     directly, @/lib/supabase/server mocked to hand back a real session
//     client, so requireActiveAdmin() -> real app_users lookup runs for real).
//
// Fixture: full_name prefix 'PPL Export Test' (unique marker, not just phone
// space) so the scope assertion counts EXACTLY our fixture rows regardless of
// demo-seed or other tests' people — the roster query has no filters to scope
// it down by, unlike the attendance export's parish filter. Phone space
// +62999009104xx (T10a — checked against every other integration test's phone
// space, unused). Admin/organizer id suffixes via randomUUID (createUser),
// no fixed FAKE_ADMIN_ID needed since nothing here references app_users.id in
// assertions.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { NextRequest } from 'next/server'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomUUID } from 'crypto'
import * as XLSX from 'xlsx'
import { impl_getRosterRows, mapRosterRowToExportRow } from '../../lib/actions/people-export.impl'
import type { RosterRow } from '../../lib/actions/people-export.types'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !anonKey || !serviceKey) {
  throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY')
}

const PROD_PROJECT_REF = 'bftifxgdcmisasgvobuf'
if (url.includes(PROD_PROJECT_REF)) {
  throw new Error(
    `[people-export-actions.test.ts] NEXT_PUBLIC_SUPABASE_URL resolves to the PRODUCTION ` +
      `project (${PROD_PROJECT_REF}). This suite creates/deletes real auth users and people ` +
      `rows — must run against local Docker only.`,
  )
}

const NAME_PREFIX = 'PPL Export Test'
const NAMES = {
  ACTIVE: `${NAME_PREFIX} Active`,
  DELETED: `${NAME_PREFIX} SoftDeleted`,
  ANON: `${NAME_PREFIX} Anonymized`,
} as const

const PHONES = {
  ACTIVE: '+62999009104001',
  DELETED: '+62999009104002',
  ANON: '+62999009104003',
} as const

let svc: SupabaseClient
const peopleIds: string[] = []
const authUserIds: string[] = []

let currentSessionClient: SupabaseClient
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => currentSessionClient,
}))

async function createAppUserSession(
  label: string,
  role: 'admin' | 'organizer',
  active = true,
): Promise<SupabaseClient> {
  const email = `ppl-export-${label}-${randomUUID()}@test.invalid`
  const pass = `PplExport-${label}-${Date.now()}!`
  const { data: authData, error: authErr } = await svc.auth.admin.createUser({
    email, password: pass, email_confirm: true,
  })
  if (authErr || !authData.user) throw new Error(`createUser (${label}): ${authErr?.message}`)
  authUserIds.push(authData.user.id)

  const { error: appErr } = await svc
    .from('app_users')
    .insert({ id: authData.user.id, email, full_name: `PPL Export Test ${label}`, role, active })
  if (appErr) throw new Error(`insert app_user (${label}): ${appErr.message}`)

  const session = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { error: signInErr } = await session.auth.signInWithPassword({ email, password: pass })
  if (signInErr) throw new Error(`sign-in (${label}): ${signInErr.message}`)
  return session
}

let activeAdminSession: SupabaseClient
let deactivatedAdminSession: SupabaseClient
let organizerSession: SupabaseClient

async function countAuditRows(): Promise<number> {
  const { count, error } = await svc
    .from('audit_log')
    .select('id', { count: 'exact', head: true })
    .eq('action', 'export.create')
    .eq('entity_type', 'export')
  if (error) throw new Error(`countAuditRows failed: ${error.message}`)
  return count ?? 0
}

/** Ground-truth scope count from base table — never trust absence-of-error. */
async function gtScopeCount(): Promise<number> {
  const { count, error } = await svc
    .from('people')
    .select('id', { count: 'exact', head: true })
    .like('full_name', `${NAME_PREFIX}%`)
    .is('anonymized_at', null)
  if (error) throw new Error(`gtScopeCount failed: ${error.message}`)
  return count ?? 0
}

beforeAll(async () => {
  svc = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })

  const { data: active, error: e1 } = await svc.from('people').insert({
    phone_e164: PHONES.ACTIVE,
    full_name: NAMES.ACTIVE,
    nickname: 'Active',
    photo_consent_state: 'granted',
    photo_publish_consent: true,
  }).select('id').single()
  if (e1) throw new Error(`insert ACTIVE: ${e1.message}`)
  peopleIds.push(active.id)

  const { data: deleted, error: e2 } = await svc.from('people').insert({
    phone_e164: PHONES.DELETED,
    full_name: NAMES.DELETED,
    nickname: 'Deleted',
    photo_consent_state: 'unknown',
    photo_publish_consent: false,
    deleted_at: '2026-06-01T00:00:00Z',
  }).select('id').single()
  if (e2) throw new Error(`insert DELETED: ${e2.message}`)
  peopleIds.push(deleted.id)

  const { data: anon, error: e3 } = await svc.from('people').insert({
    phone_e164: PHONES.ANON,
    full_name: NAMES.ANON,
    nickname: 'Anon',
    photo_consent_state: 'refused',
    photo_publish_consent: false,
    anonymized_at: '2026-06-02T00:00:00Z',
  }).select('id').single()
  if (e3) throw new Error(`insert ANON: ${e3.message}`)
  peopleIds.push(anon.id)

  activeAdminSession = await createAppUserSession('active', 'admin')
  deactivatedAdminSession = await createAppUserSession('deactivated', 'admin', false)
  organizerSession = await createAppUserSession('organizer', 'organizer')
}, 30_000)

afterAll(async () => {
  if (!svc) return
  if (peopleIds.length > 0) {
    await svc.from('people').update({ deleted_at: null }).in('id', peopleIds)
    await svc.from('people').delete().in('id', peopleIds)
  }
  if (authUserIds.length > 0) {
    await svc.from('audit_log').delete().in('actor_user_id', authUserIds)
    await svc.from('app_users').delete().in('id', authUserIds)
    for (const id of authUserIds) {
      await svc.auth.admin.deleteUser(id)
    }
  }
}, 30_000)

// ── impl_getRosterRows — scope, proven against an independent recount ─────────

describe('impl_getRosterRows scope', () => {
  it('active + soft-deleted included, anonymized excluded — matches independent service-role recount', async () => {
    const gt = await gtScopeCount()
    expect(gt).toBe(2) // ACTIVE + DELETED, never ANON

    const result = await impl_getRosterRows({ supabase: activeAdminSession })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return

    const fixtureRows = result.data.filter(r => r.full_name.startsWith(NAME_PREFIX))
    expect(fixtureRows.length).toBe(gt)

    const activeRow = fixtureRows.find(r => r.full_name === NAMES.ACTIVE)
    const deletedRow = fixtureRows.find(r => r.full_name === NAMES.DELETED)
    const anonRow = fixtureRows.find(r => r.full_name === NAMES.ANON)

    expect(activeRow).toBeDefined()
    expect(activeRow!.deleted_at).toBeNull()
    expect(deletedRow).toBeDefined()
    expect(deletedRow!.deleted_at).not.toBeNull()
    expect(anonRow).toBeUndefined()
  })
})

// ── mapRosterRowToExportRow — pure label mapping ───────────────────────────────

describe('mapRosterRowToExportRow', () => {
  const base: RosterRow = {
    full_name: 'Test Person',
    nickname: 'TP',
    phone_e164: '+62999009104099',
    email: null,
    birth_date: null,
    birth_place: null,
    gender: null,
    origin_parish: null,
    marital_status: null,
    kepanitiaan: null,
    tribe: null,
    current_city: null,
    photo_consent_state: 'unknown',
    photo_publish_consent: false,
    deleted_at: null,
    created_at: '2026-05-08T23:00:00+00:00',
  }

  it('Photo consent carries the enum state verbatim for all three values', () => {
    expect(mapRosterRowToExportRow({ ...base, photo_consent_state: 'granted' })['Photo consent']).toBe('granted')
    expect(mapRosterRowToExportRow({ ...base, photo_consent_state: 'refused' })['Photo consent']).toBe('refused')
    expect(mapRosterRowToExportRow({ ...base, photo_consent_state: 'unknown' })['Photo consent']).toBe('unknown')
  })

  it("Can publish renders Yes/No, distinct vocabulary from Photo consent's granted/refused/unknown", () => {
    expect(mapRosterRowToExportRow({ ...base, photo_publish_consent: true })['Can publish']).toBe('Yes')
    expect(mapRosterRowToExportRow({ ...base, photo_publish_consent: false })['Can publish']).toBe('No')
  })

  it('Status derives from deleted_at', () => {
    expect(mapRosterRowToExportRow({ ...base, deleted_at: null }).Status).toBe('active')
    expect(mapRosterRowToExportRow({ ...base, deleted_at: '2026-06-01T00:00:00Z' }).Status).toBe('inactive/soft-deleted')
  })

  it('Birth date and Created are stable YYYY-MM-DD, not tz-shifted', () => {
    const row = mapRosterRowToExportRow({ ...base, birth_date: '1990-05-08', created_at: '2026-05-08T23:00:00+00:00' })
    expect(row['Birth date']).toBe('1990-05-08')
    expect(row.Created).toBe('2026-05-08') // NOT '2026-05-09' — no Date-object tz shift
  })

  it('gender and marital_status map to title-case labels; null fields render as empty string', () => {
    expect(mapRosterRowToExportRow({ ...base, gender: 'male' }).Gender).toBe('Male')
    expect(mapRosterRowToExportRow({ ...base, gender: 'female' }).Gender).toBe('Female')
    expect(mapRosterRowToExportRow({ ...base, marital_status: 'married' })['Marital status']).toBe('Married')
    expect(mapRosterRowToExportRow(base).Gender).toBe('')
    expect(mapRosterRowToExportRow(base).Email).toBe('')
    expect(mapRosterRowToExportRow(base)['Birth date']).toBe('')
  })
})

// ── GET /api/admin/export/people — active-check + audit + content ─────────────

describe('GET /api/admin/export/people', () => {
  it('deactivated admin -> 403, no export.create audit row written', async () => {
    currentSessionClient = deactivatedAdminSession
    const before = await countAuditRows()

    const { GET } = await import('@/app/api/admin/export/people/route')
    const req = new NextRequest('http://localhost/api/admin/export/people')
    const res = await GET(req)

    expect(res.status).toBe(403)
    expect(await countAuditRows()).toBe(before)
  })

  it('organizer -> 403, no export.create audit row written', async () => {
    currentSessionClient = organizerSession
    const before = await countAuditRows()

    const { GET } = await import('@/app/api/admin/export/people/route')
    const req = new NextRequest('http://localhost/api/admin/export/people')
    const res = await GET(req)

    expect(res.status).toBe(403)
    expect(await countAuditRows()).toBe(before)
  })

  it('active admin -> 200, exactly one export.create audit row (kind + count, no PII), workbook reflects scope + labels', async () => {
    currentSessionClient = activeAdminSession
    const before = await countAuditRows()

    const { GET } = await import('@/app/api/admin/export/people/route')
    const req = new NextRequest('http://localhost/api/admin/export/people')
    const res = await GET(req)

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Disposition')).toContain('attachment')

    const after = await countAuditRows()
    expect(after).toBe(before + 1)

    const { data: auditRow, error: auditErr } = await svc
      .from('audit_log')
      .select('details_json')
      .eq('action', 'export.create')
      .eq('entity_type', 'export')
      .order('created_at', { ascending: false })
      .limit(1)
      .single()
    if (auditErr) throw new Error(`audit readback failed: ${auditErr.message}`)

    const details = auditRow.details_json as Record<string, unknown>
    expect(Object.keys(details).sort()).toEqual(['export_kind', 'row_count'])
    expect(details.export_kind).toBe('people_roster')
    expect(typeof details.row_count).toBe('number')
    expect(JSON.stringify(details)).not.toContain(NAME_PREFIX)
    expect(JSON.stringify(details)).not.toContain(PHONES.ACTIVE)

    const buffer = new Uint8Array(await res.arrayBuffer())
    const workbook = XLSX.read(buffer, { type: 'array' })
    expect(workbook.SheetNames).toEqual(['People Roster'])
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets['People Roster']!) as Record<string, unknown>[]

    const activeRow = rows.find(r => r.Name === NAMES.ACTIVE)
    const deletedRow = rows.find(r => r.Name === NAMES.DELETED)
    const anonRow = rows.find(r => r.Name === NAMES.ANON)

    expect(activeRow).toBeDefined()
    expect(activeRow!.Status).toBe('active')
    expect(activeRow!['Photo consent']).toBe('granted')
    expect(activeRow!['Can publish']).toBe('Yes')

    expect(deletedRow).toBeDefined()
    expect(deletedRow!.Status).toBe('inactive/soft-deleted')

    expect(anonRow).toBeUndefined()
  })
})
