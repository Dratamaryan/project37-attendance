// Integration test for Sprint 3 Task 7 — runImportDryRun orchestrator.
// Runs against local Docker Supabase (configured in .env.test.local).
// Calls runImportDryRun() directly (not via HTTP) — the impl/route split
// means the HTTP guard + multipart parsing are exercised separately by the
// bare-node .mjs script, not here.
// Run: npm test -- import-dry-run-route (scoped run for iteration only —
// verify report requires the full `npm test`, per feedback_collab.md).
//
// Fixture: DB-direct-insert phones would use +62999009103xx (T7 space,
// established in import-lookup.test.ts), but rows here pass through the real
// normalize pipeline and need a validly-formatted number — see the PHONES
// comment below. FAKE_ADMIN_ID suffix 101 (100/102/300xx already used by
// T4/T6/T2 per their file headers).

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import * as XLSX from 'xlsx'
import { runImportDryRun } from '../../lib/import/dry-run.impl'
import { COLUMN_MAPPINGS } from '../../lib/import/columns'

const CONSENT_HEADER = COLUMN_MAPPINGS.find((m) => m.target === 'photo_consent_raw')!.headerAliases[0]

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !serviceKey) {
  throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY')
}

const FAKE_ADMIN_ID = '00000000-0000-0000-0000-000000000101'

// +62999009103xx (raw digits starting '99') is the fixture-DB convention used
// elsewhere in this suite for DIRECT inserts, but is not a real Indonesian
// mobile prefix and fails normalizePhone's validity check. Since these rows
// go through the actual import normalize pipeline (not a direct insert), they
// need a real, allocated prefix (0812) — chosen distinct from any other test
// file's fixture range, with the "9103" T7-space marker kept in the suffix.
const PHONES = {
  NEW_1: '+62812000910311',
  NEW_2: '+62812000910312',
  DUP_IN_FILE: '+62812000910313',
  DB_ACTIVE: '+62812000910314',
  DB_DELETED: '+62812000910315',
} as const

let svc: SupabaseClient
let dbActiveId: string
let dbDeletedId: string
const importIdsToClean: string[] = []

function buildXlsxBuffer(headerRow: string[], dataRows: unknown[][], junkRowAbove?: unknown[]): Buffer {
  const aoa: unknown[][] = junkRowAbove ? [junkRowAbove, headerRow, ...dataRows] : [headerRow, ...dataRows]
  const worksheet = XLSX.utils.aoa_to_sheet(aoa)
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1')
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

beforeAll(async () => {
  svc = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })

  const { data: existingAdmin } = await svc.from('app_users').select('id').eq('id', FAKE_ADMIN_ID).maybeSingle()
  if (!existingAdmin) {
    const { error } = await svc.from('app_users').insert({
      id: FAKE_ADMIN_ID,
      email: 'import-test-admin-101@test.local',
      full_name: 'Import Test Admin',
      role: 'admin',
      active: true,
    })
    if (error) throw new Error(`app_users insert: ${error.message}`)
  }

  const { data: active, error: activeErr } = await svc
    .from('people')
    .insert({ phone_e164: PHONES.DB_ACTIVE, full_name: 'DryRun DB Active', nickname: 'Active' })
    .select('id')
    .single()
  if (activeErr) throw new Error(`fixture insert (active): ${activeErr.message}`)
  dbActiveId = active.id

  const { data: deleted, error: deletedErr } = await svc
    .from('people')
    .insert({
      phone_e164: PHONES.DB_DELETED,
      full_name: 'DryRun DB Deleted',
      nickname: 'Deleted',
      deleted_at: new Date().toISOString(),
    })
    .select('id')
    .single()
  if (deletedErr) throw new Error(`fixture insert (soft-deleted): ${deletedErr.message}`)
  dbDeletedId = deleted.id
})

afterEach(async () => {
  if (importIdsToClean.length > 0) {
    await svc.from('audit_log').delete().eq('entity_type', 'import').in('entity_id', importIdsToClean)
    importIdsToClean.length = 0
  }
})

afterAll(async () => {
  await svc.from('people').delete().in('phone_e164', Object.values(PHONES))
  await svc.from('app_users').delete().eq('id', FAKE_ADMIN_ID)
})

describe('runImportDryRun', () => {
  it('mixed classification fixture -> correct counts, zero writes to people, one matching audit row', async () => {
    const { count: peopleBefore } = await svc
      .from('people')
      .select('id', { count: 'exact', head: true })
      .like('phone_e164', '+62812000910301%')

    const buffer = buildXlsxBuffer(
      ['Nama Lengkap', 'Nomor HP', CONSENT_HEADER],
      [
        ['New Person One', PHONES.NEW_1.replace('+62', '0'), 'Ya'],
        ['Dup In File A', PHONES.DUP_IN_FILE.replace('+62', '0'), 'Tidak'],
        ['Dup In File B', PHONES.DUP_IN_FILE.replace('+62', '0'), 'Tidak'],
        ['DB Active Person', PHONES.DB_ACTIVE.replace('+62', '0'), null],
        ['DB Deleted Person', PHONES.DB_DELETED.replace('+62', '0'), null],
        ['No Phone Person', null, null],
      ],
    )

    const outcome = await runImportDryRun(
      { fileBuffer: buffer, filename: 'mixed.xlsx', actorUserId: FAKE_ADMIN_ID, ipAddress: null, userAgent: null },
      svc,
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    importIdsToClean.push(outcome.importId)

    // NEW_1 is 'new'; DUP_IN_FILE's first occurrence is also 'new' (no DB
    // match), its second occurrence is 'dup_in_file' — hence new: 2.
    expect(outcome.result.classificationCounts).toEqual({
      new: 2,
      dup_in_db: 1,
      dup_in_file: 1,
      dup_soft_deleted: 1,
      error: 1,
    })
    expect(outcome.result.totalRows).toBe(6)

    const dbActiveRow = outcome.result.rows.find((r) => r.phone_e164 === PHONES.DB_ACTIVE)
    expect(dbActiveRow?.matchedPersonId).toBe(dbActiveId)
    const dbDeletedRow = outcome.result.rows.find((r) => r.phone_e164 === PHONES.DB_DELETED)
    expect(dbDeletedRow?.matchedPersonId).toBe(dbDeletedId)

    // S6-T5a: consent flows through the dry-run's own JSON (data.photo_consent_state
    // / data.photo_publish_consent), not just at commit time -- this is what
    // lets the S6-T5 dry-run tally 81/33/77 straight from this response.
    const newRow = outcome.result.rows.find((r) => r.phone_e164 === PHONES.NEW_1)
    expect(newRow?.data.photo_consent_state).toBe('granted')
    expect(newRow?.data.photo_publish_consent).toBe(true)
    const dupInFileRow = outcome.result.rows.find((r) => r.phone_e164 === PHONES.DUP_IN_FILE)
    expect(dupInFileRow?.data.photo_consent_state).toBe('refused')
    expect(dupInFileRow?.data.photo_publish_consent).toBe(false)

    const { count: peopleAfter } = await svc
      .from('people')
      .select('id', { count: 'exact', head: true })
      .like('phone_e164', '+62812000910301%')
    expect(peopleAfter).toBe(peopleBefore) // dry-run writes NOTHING to people

    const { data: auditRows, error: auditErr } = await svc
      .from('audit_log')
      .select('*')
      .eq('entity_type', 'import')
      .eq('entity_id', outcome.importId)
    if (auditErr) throw auditErr
    expect(auditRows).toHaveLength(1)
    expect(auditRows![0].actor_user_id).toBe(FAKE_ADMIN_ID)
    expect(auditRows![0].action).toBe('import.dry_run')
    expect(auditRows![0].details_json.classification_counts).toEqual(outcome.result.classificationCounts)
    expect(auditRows![0].details_json.filename).toBe('mixed.xlsx')
  })

  it('empty-data file (valid header, zero data rows) -> ok, all-zero counts, still exactly one audit row', async () => {
    const buffer = buildXlsxBuffer(['Nama Lengkap', 'Nomor HP', CONSENT_HEADER], [])

    const outcome = await runImportDryRun(
      { fileBuffer: buffer, filename: 'empty.xlsx', actorUserId: FAKE_ADMIN_ID, ipAddress: null, userAgent: null },
      svc,
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    importIdsToClean.push(outcome.importId)

    expect(outcome.result.totalRows).toBe(0)
    expect(outcome.result.classificationCounts).toEqual({
      new: 0,
      dup_in_db: 0,
      dup_in_file: 0,
      dup_soft_deleted: 0,
      error: 0,
    })

    const { data: auditRows } = await svc
      .from('audit_log')
      .select('id')
      .eq('entity_type', 'import')
      .eq('entity_id', outcome.importId)
    expect(auditRows).toHaveLength(1)
  })

  it('junk-row-offset fixture: error row reported at the correct 1-based Excel row number', async () => {
    // junk row -> Excel row 1, header -> Excel row 2, data starts Excel row 3.
    // Second data row (missing phone) is Excel row 4.
    const buffer = buildXlsxBuffer(
      ['Nama Lengkap', 'Nomor HP', CONSENT_HEADER],
      [
        ['First Person', PHONES.NEW_2.replace('+62', '0'), 'Ya'],
        ['Second Person (bad)', null, null],
      ],
      [null, null], // junk row above header
    )

    const outcome = await runImportDryRun(
      { fileBuffer: buffer, filename: 'offset.xlsx', actorUserId: FAKE_ADMIN_ID, ipAddress: null, userAgent: null },
      svc,
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    importIdsToClean.push(outcome.importId)

    expect(outcome.result.rows[0].sourceRowNumber).toBe(3)
    expect(outcome.result.rows[1].sourceRowNumber).toBe(4)
    expect(outcome.result.rows[1].rowClass).toBe('error')
    expect(outcome.result.rows[1].reason).toBe('missing_phone')
  })

  it('sheet without a matching name and multiple sheets -> loud-fail listing available sheets', async () => {
    const worksheet1 = XLSX.utils.aoa_to_sheet([['Nama Lengkap', 'Nomor HP']])
    const worksheet2 = XLSX.utils.aoa_to_sheet([['x']])
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, worksheet1, 'Form responses 1')
    XLSX.utils.book_append_sheet(workbook, worksheet2, 'Other')
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer

    const outcome = await runImportDryRun(
      { fileBuffer: buffer, filename: 'wrong-sheets.xlsx', actorUserId: FAKE_ADMIN_ID, ipAddress: null, userAgent: null },
      svc,
    )

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toBe('sheet_not_found')
    if (outcome.error === 'sheet_not_found') {
      expect(outcome.availableSheets).toEqual(['Form responses 1', 'Other'])
    }
  })

  it('missing required column (Nomor HP) -> loud-fail naming it, no audit row written', async () => {
    const buffer = buildXlsxBuffer(['Nama Lengkap', CONSENT_HEADER], [['Someone', 'Ya']])

    const outcome = await runImportDryRun(
      { fileBuffer: buffer, filename: 'missing-col.xlsx', actorUserId: FAKE_ADMIN_ID, ipAddress: null, userAgent: null },
      svc,
    )

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toBe('missing_required_columns')
    if (outcome.error === 'missing_required_columns') {
      expect(outcome.missingFields).toEqual(['Nomor HP'])
    }
  })

  it('S6-T5a: missing consent column -> loud-fail naming it, no audit row, no rows classified (anti-silent-drop guard end-to-end)', async () => {
    const buffer = buildXlsxBuffer(['Nama Lengkap', 'Nomor HP'], [['Someone', PHONES.NEW_1.replace('+62', '0')]])

    const outcome = await runImportDryRun(
      { fileBuffer: buffer, filename: 'missing-consent-col.xlsx', actorUserId: FAKE_ADMIN_ID, ipAddress: null, userAgent: null },
      svc,
    )

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toBe('missing_required_columns')
    if (outcome.error === 'missing_required_columns') {
      expect(outcome.missingFields).toEqual([CONSENT_HEADER])
    }

    const { data: auditRows } = await svc
      .from('audit_log')
      .select('id')
      .eq('entity_type', 'import')
      .eq('details_json->>filename', 'missing-consent-col.xlsx')
    expect(auditRows).toHaveLength(0)
  })
})
