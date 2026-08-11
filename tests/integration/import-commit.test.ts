// Integration test for Sprint 3 Task 8 — runImportCommit orchestrator +
// insertNewPeople (the ON CONFLICT DO NOTHING insert step). Runs against
// local Docker Supabase (configured in .env.test.local). Calls runImportCommit
// / insertNewPeople directly (not via HTTP) — same impl/route split as T7.
// Run: npm test -- import-commit (scoped run for iteration only — verify
// report requires the full `npm test`, per feedback_collab.md).
//
// Fixture space: +62812000920xxx, FAKE_ADMIN_ID suffix 102 (91/93/94/96/97/98/
// 99/100/101 already used by other integration test files per their headers).

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import * as XLSX from 'xlsx'
import { runImportCommit, insertNewPeople } from '../../lib/import/commit.impl'
import { COLUMN_MAPPINGS } from '../../lib/import/columns'
import type { ClassifiedRow } from '../../lib/import/types'

const CONSENT_HEADER = COLUMN_MAPPINGS.find((m) => m.target === 'photo_consent_raw')!.headerAliases[0]

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !serviceKey) {
  throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY')
}

const FAKE_ADMIN_ID = '00000000-0000-0000-0000-000000000102'

const PHONES = {
  NEW_1: '+62812000920001',
  NEW_2: '+62812000920002',
  DUP_IN_FILE: '+62812000920003',
  DB_ACTIVE: '+62812000920004',
  DB_DELETED: '+62812000920005',
  RACE_A: '+62812000920006',
  RACE_B: '+62812000920007',
  RACE_CONFLICT: '+62812000920008',
  CONSENT_GRANTED: '+62812000920009',
  CONSENT_REFUSED: '+62812000920010',
  CONSENT_BLANK: '+62812000920011',
} as const

let svc: SupabaseClient
let dbDeletedId: string
const importIdsToClean: string[] = []

function buildXlsxBuffer(headerRow: string[], dataRows: unknown[][]): Buffer {
  const worksheet = XLSX.utils.aoa_to_sheet([headerRow, ...dataRows])
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1')
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

function fakeNewRow(
  sourceRowNumber: number,
  phone_e164: string,
  full_name: string,
  consent: { state: 'granted' | 'refused' | 'unknown'; publish: boolean } = { state: 'unknown', publish: false },
): ClassifiedRow {
  return {
    sourceRowNumber,
    rowClass: 'new',
    phone_e164,
    full_name,
    nickname: full_name.split(' ')[0],
    reason: null,
    warnings: [],
    matchedPersonId: null,
    data: {
      sourceRowNumber,
      phone_e164,
      phone_error: null,
      full_name,
      nickname: full_name.split(' ')[0],
      nicknameFallbackApplied: true,
      birth_place: null,
      birth_date: null,
      gender: null,
      origin_parish: null,
      marital_status: null,
      kepanitiaan: null,
      tribe: null,
      photo_consent_state: consent.state,
      photo_publish_consent: consent.publish,
      warnings: [],
    },
  }
}

beforeAll(async () => {
  svc = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })

  const { data: existingAdmin } = await svc.from('app_users').select('id').eq('id', FAKE_ADMIN_ID).maybeSingle()
  if (!existingAdmin) {
    const { error } = await svc.from('app_users').insert({
      id: FAKE_ADMIN_ID,
      email: 'import-test-admin-102@test.local',
      full_name: 'Import Commit Test Admin',
      role: 'admin',
      active: true,
    })
    if (error) throw new Error(`app_users insert: ${error.message}`)
  }

  const { error: activeErr } = await svc
    .from('people')
    .insert({ phone_e164: PHONES.DB_ACTIVE, full_name: 'Commit DB Active', nickname: 'Active' })
  if (activeErr) throw new Error(`fixture insert (active): ${activeErr.message}`)

  const { data: deleted, error: deletedErr } = await svc
    .from('people')
    .insert({
      phone_e164: PHONES.DB_DELETED,
      full_name: 'Commit DB Deleted',
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
  // Clean up any people rows this test file's commit runs actually inserted,
  // scoped to this file's fixture prefix only.
  await svc.from('people').delete().like('phone_e164', '+62812000920%').neq('phone_e164', PHONES.DB_ACTIVE).neq('phone_e164', PHONES.DB_DELETED)
})

afterAll(async () => {
  await svc.from('people').delete().like('phone_e164', '+62812000920%')
  await svc.from('app_users').delete().eq('id', FAKE_ADMIN_ID)
})

describe('runImportCommit', () => {
  it('mixed classification fixture -> inserts only new rows, correct result counts, one audit row', async () => {
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

    const outcome = await runImportCommit(
      { fileBuffer: buffer, filename: 'mixed-commit.xlsx', actorUserId: FAKE_ADMIN_ID, ipAddress: null, userAgent: null },
      svc,
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    importIdsToClean.push(outcome.importId)

    // NEW_1 is 'new'; DUP_IN_FILE's first occurrence is also 'new' -> attempted: 2.
    expect(outcome.result.classificationCounts).toEqual({
      new: 2,
      dup_in_db: 1,
      dup_in_file: 1,
      dup_soft_deleted: 1,
      error: 1,
    })
    expect(outcome.result.attempted).toBe(2)
    expect(outcome.result.inserted).toBe(2)
    expect(outcome.result.raced).toBe(0)
    expect(outcome.result.skippedDup).toBe(3) // dup_in_db + dup_in_file + dup_soft_deleted
    expect(outcome.result.skippedError).toBe(1)

    // Only NEW_1 was actually inserted as a brand-new row (DUP_IN_FILE's
    // 'new' occurrence shares the same phone as its own dup_in_file sibling,
    // so it also lands -- confirm both new-classified phones are present).
    const { data: newRow } = await svc.from('people').select('id').eq('phone_e164', PHONES.NEW_1).maybeSingle()
    expect(newRow).not.toBeNull()
    const { data: dupInFileRow } = await svc.from('people').select('id').eq('phone_e164', PHONES.DUP_IN_FILE).maybeSingle()
    expect(dupInFileRow).not.toBeNull()

    // dup_in_db / dup_soft_deleted / error rows must NOT create new rows.
    const { count: dbActiveCount } = await svc
      .from('people')
      .select('id', { count: 'exact', head: true })
      .eq('phone_e164', PHONES.DB_ACTIVE)
    expect(dbActiveCount).toBe(1) // still just the original fixture row

    const auditRow = await fetchAuditRow(outcome.importId)
    expect(auditRow.action).toBe('import.commit')
    expect(auditRow.actor_user_id).toBe(FAKE_ADMIN_ID)
    expect(auditRow.details_json.attempted).toBe(2)
    expect(auditRow.details_json.inserted).toBe(2)
    expect(auditRow.details_json.inserted_ids).toHaveLength(2)
  })

  it('dup_soft_deleted phone is never resurrected -- deleted_at stays set, no new row created', async () => {
    const buffer = buildXlsxBuffer(
      ['Nama Lengkap', 'Nomor HP', CONSENT_HEADER],
      [['Deleted Person Reimported', PHONES.DB_DELETED.replace('+62', '0'), 'Ya']],
    )

    const outcome = await runImportCommit(
      { fileBuffer: buffer, filename: 'resurrect-attempt.xlsx', actorUserId: FAKE_ADMIN_ID, ipAddress: null, userAgent: null },
      svc,
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    importIdsToClean.push(outcome.importId)

    expect(outcome.result.attempted).toBe(0)
    expect(outcome.result.inserted).toBe(0)
    expect(outcome.result.skippedDup).toBe(1)

    const { data: stillDeleted } = await svc
      .from('people')
      .select('id, deleted_at')
      .eq('id', dbDeletedId)
      .single()
    expect(stillDeleted!.deleted_at).not.toBeNull()

    const { count } = await svc.from('people').select('id', { count: 'exact', head: true }).eq('phone_e164', PHONES.DB_DELETED)
    expect(count).toBe(1) // exactly the original soft-deleted row, no resurrection duplicate
  })

  it('empty new set (all dup/error) -> ok result, zero inserts, still exactly one audit row', async () => {
    const buffer = buildXlsxBuffer(['Nama Lengkap', 'Nomor HP', CONSENT_HEADER], [['Bad Row', null, null]])

    const outcome = await runImportCommit(
      { fileBuffer: buffer, filename: 'all-error.xlsx', actorUserId: FAKE_ADMIN_ID, ipAddress: null, userAgent: null },
      svc,
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    importIdsToClean.push(outcome.importId)

    expect(outcome.result.attempted).toBe(0)
    expect(outcome.result.inserted).toBe(0)

    const auditRow = await fetchAuditRow(outcome.importId)
    expect(auditRow.action).toBe('import.commit')
  })

  it('structural failure (missing required column) -> no audit row written', async () => {
    const buffer = buildXlsxBuffer(['Nama Lengkap'], [['Someone']])

    const outcome = await runImportCommit(
      { fileBuffer: buffer, filename: 'missing-col-commit.xlsx', actorUserId: FAKE_ADMIN_ID, ipAddress: null, userAgent: null },
      svc,
    )

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toBe('missing_required_columns')

    const { data: auditRows } = await svc
      .from('audit_log')
      .select('id')
      .eq('action', 'import.commit')
      .eq('details_json->>filename', 'missing-col-commit.xlsx')
    expect(auditRows).toHaveLength(0)
  })

  it('S6-T5a: granted/refused/blank rows persist explicit photo_consent_state + photo_publish_consent, not DB defaults -- refused stays distinct from unknown', async () => {
    const buffer = buildXlsxBuffer(
      ['Nama Lengkap', 'Nomor HP', CONSENT_HEADER],
      [
        ['Consent Granted', PHONES.CONSENT_GRANTED.replace('+62', '0'), 'Ya'],
        ['Consent Refused', PHONES.CONSENT_REFUSED.replace('+62', '0'), 'Tidak'],
        ['Consent Blank', PHONES.CONSENT_BLANK.replace('+62', '0'), null],
      ],
    )

    const outcome = await runImportCommit(
      { fileBuffer: buffer, filename: 'consent-mapping.xlsx', actorUserId: FAKE_ADMIN_ID, ipAddress: null, userAgent: null },
      svc,
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    importIdsToClean.push(outcome.importId)
    expect(outcome.result.inserted).toBe(3)

    const { data: rows } = await svc
      .from('people')
      .select('phone_e164, photo_consent_state, photo_publish_consent')
      .in('phone_e164', [PHONES.CONSENT_GRANTED, PHONES.CONSENT_REFUSED, PHONES.CONSENT_BLANK])
    const byPhone = Object.fromEntries((rows ?? []).map((r) => [r.phone_e164, r]))

    expect(byPhone[PHONES.CONSENT_GRANTED]).toMatchObject({ photo_consent_state: 'granted', photo_publish_consent: true })
    // The DB default for photo_consent_state is 'unknown' -- if this ever
    // regressed to relying on the default, this row would silently read
    // 'unknown' instead of 'refused', which is exactly the B/D2 failure
    // (33 legacy refusers becoming indistinguishable from never-asked) that
    // S6-T5a exists to prevent. Asserted explicitly, not just via toMatchObject
    // above, so a future refactor can't quietly weaken this.
    expect(byPhone[PHONES.CONSENT_REFUSED].photo_consent_state).toBe('refused')
    expect(byPhone[PHONES.CONSENT_REFUSED].photo_publish_consent).toBe(false)
    expect(byPhone[PHONES.CONSENT_BLANK]).toMatchObject({ photo_consent_state: 'unknown', photo_publish_consent: false })
  })
})

describe('insertNewPeople -- proves ON CONFLICT DO NOTHING against real Postgres', () => {
  it('a phone inserted between lookup and insert is silently skipped; batch does NOT abort; RETURNING excludes it', async () => {
    // Simulate the race window directly: pre-insert RACE_CONFLICT into the DB
    // (as if another process committed it after this commit's own lookup
    // step ran), then call insertNewPeople with a payload where classify
    // WOULD have said 'new' for all three phones (this bypasses classify on
    // purpose -- the point is to prove the insert step's own SQL semantics
    // against real Postgres, not something a mock could ever demonstrate).
    const { error: preInsertErr } = await svc
      .from('people')
      .insert({ phone_e164: PHONES.RACE_CONFLICT, full_name: 'Raced In First', nickname: 'Raced' })
    if (preInsertErr) throw preInsertErr

    const payload = [
      fakeNewRow(10, PHONES.RACE_A, 'Race A'),
      fakeNewRow(11, PHONES.RACE_CONFLICT, 'Race Conflict Attempt'),
      fakeNewRow(12, PHONES.RACE_B, 'Race B'),
    ]

    const { insertedIds } = await insertNewPeople(svc, payload)

    // Batch did not abort/throw, and RETURNING excludes the conflicting row.
    expect(insertedIds).toHaveLength(2)

    const { data: raceARow } = await svc.from('people').select('id').eq('phone_e164', PHONES.RACE_A).maybeSingle()
    expect(raceARow).not.toBeNull()
    const { data: raceBRow } = await svc.from('people').select('id').eq('phone_e164', PHONES.RACE_B).maybeSingle()
    expect(raceBRow).not.toBeNull()

    // Conflicting phone still has exactly the ORIGINAL name (not overwritten,
    // not duplicated) -- ON CONFLICT DO NOTHING, not DO UPDATE.
    const { data: conflictRows } = await svc.from('people').select('id, full_name').eq('phone_e164', PHONES.RACE_CONFLICT)
    expect(conflictRows).toHaveLength(1)
    expect(conflictRows![0].full_name).toBe('Raced In First')
  })

  it('empty rows array -> no query, empty insertedIds', async () => {
    const { insertedIds } = await insertNewPeople(svc, [])
    expect(insertedIds).toEqual([])
  })
})

async function fetchAuditRow(importId: string) {
  const { data, error } = await svc.from('audit_log').select('*').eq('entity_type', 'import').eq('entity_id', importId)
  if (error) throw error
  expect(data).toHaveLength(1)
  return data![0]
}
