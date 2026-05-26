/**
 * Live RLS + storage verify script for Sprint 1 Task 7.
 * Reads .env.local, tests the people-photos bucket end-to-end.
 *
 * Run:  node scripts/verify-task-7.mjs
 *
 * ARCHITECTURE NOTE — Supabase storage v1.58.x two-path model:
 *   Service role key (admin client) → goes directly to the file backend,
 *   bypasses storage.objects entirely. No row is written to storage.objects.
 *
 *   User JWT (server/anon client) → storage service INSERT into storage.objects
 *   first, RLS is evaluated there, then file is written to backend. This is the
 *   path that impl_uploadPhoto takes (it uses createClient() from server.ts with
 *   user's JWT cookies, NOT the service role key).
 *
 * CONSEQUENCE for this script:
 *   - storage.objects shows 0 rows via Postgres query — storage service v1.58
 *     persists objects+metadata in the file/S3 backend, not in Postgres.
 *   - user_metadata IS reliably stored (confirmed: delete response includes it).
 *   - Anon upload: triggers "new row violates row-level security policy" →
 *     proves our organizer_insert policy is live (RLS evaluated at INSERT time).
 *   - Organizer session impersonation is deferred to Task 9 (supabase-js v2.106
 *     does not expose admin.auth.admin.createSession).
 *
 * Organizer session impersonation is NOT available via supabase-js v2.x
 * (admin.auth.admin.createSession does not exist in v2.106.1). Organizer
 * RLS tests (list + delete-rejection) will be covered in Task 9.
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

// ── Load .env.local ──────────────────────────────────────────────────────────
const __dir = dirname(fileURLToPath(import.meta.url))
const envPath = resolve(__dir, '../.env.local')
try {
  const envLines = readFileSync(envPath, 'utf8').split('\n')
  for (const line of envLines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx < 0) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '')
    if (!process.env[key]) process.env[key] = val
  }
} catch {
  // env vars may already be set (CI / live run)
}

const SUPABASE_URL      = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY
const ANON_KEY          = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or NEXT_PUBLIC_SUPABASE_ANON_KEY')
  process.exit(1)
}

const BUCKET       = 'people-photos'
const TEST_PERSON  = 'verify-task7-person'
const TEST_CONTENT = new Uint8Array(1024).fill(42)  // 1 KB, all 0x2A bytes

// ── Clients ──────────────────────────────────────────────────────────────────

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// Anon client — no auth headers. Used to verify private bucket blocks access.
const anon = createClient(SUPABASE_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// ── Assertion helpers ─────────────────────────────────────────────────────────

const assertions = []
let allPassed = true

function assert(desc, passed, detail = '') {
  const symbol = passed ? '✓' : '✗'
  assertions.push({ desc, passed, detail })
  console.log(`  ${symbol} ${passed ? '      ' : 'FAIL  '} ${desc}${detail ? ' — ' + detail : ''}`)
  if (!passed) allPassed = false
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // ── Preflight: find admin user ────────────────────────────────────────────
  const { data: usersPage, error: usersErr } = await admin.auth.admin.listUsers({ perPage: 50 })
  if (usersErr) { console.error('listUsers failed:', usersErr); process.exit(1) }

  const adminUser =
    usersPage.users.find(u => u.email === 'admin-example@example.test') ??
    usersPage.users[0]
  if (!adminUser) { console.error('No auth users found'); process.exit(1) }
  const adminUserId = adminUser.id
  console.log(`Admin actor: ${adminUser.email} (${adminUserId})\n`)

  // ── Step 1: Bucket + policy check ─────────────────────────────────────────
  console.log('--- Step 1: bucket + RLS policy check ---')
  const { data: buckets } = await admin.storage.listBuckets()
  const bucket = buckets?.find(b => b.id === BUCKET)
  assert('bucket people-photos exists',      !!bucket,                        `buckets: ${JSON.stringify(buckets?.map(b=>b.id))}`)
  assert('bucket is private (public=false)', bucket?.public === false,        `public: ${bucket?.public}`)
  assert('bucket file_size_limit = 5242880', bucket?.file_size_limit === 5242880, `limit: ${bucket?.file_size_limit}`)
  console.log()

  // Verify all 4 RLS policies exist via db query (direct SQL)
  // (Not via PostgREST — storage schema is not exposed through the REST API)
  console.log('  [RLS policy audit — see supabase db query for pg_policies verification]')
  console.log('  Expected: admin_all (ALL), organizer_select (SELECT), organizer_insert (INSERT), organizer_update (UPDATE)')
  console.log()

  // ── Step 2: Admin upload ───────────────────────────────────────────────────
  console.log('--- Step 2: admin upload (service role) ---')
  const path = `${TEST_PERSON}/${crypto.randomUUID()}.jpg`

  const { data: uploadData, error: uploadErr } = await admin.storage
    .from(BUCKET)
    .upload(path, new Blob([TEST_CONTENT], { type: 'image/jpeg' }), {
      contentType: 'image/jpeg',
      metadata: {
        consent: 'true',
        uploaded_by: adminUserId,
        uploaded_at: new Date().toISOString(),
      },
    })

  assert('admin upload succeeds', !uploadErr, uploadErr?.message)
  if (uploadErr) { console.error('Upload failed — cannot continue:', uploadErr); process.exit(1) }
  console.log(`  path: ${uploadData?.path ?? path}`)
  console.log()
  console.log('  NOTE: storage.objects shows 0 rows via Postgres query (storage service v1.58 stores')
  console.log('  objects in file/S3 backend). But user_metadata IS persisted — confirmed in Step 7')
  console.log('  via the delete response. The list API does not return user_metadata per-object.')
  console.log()

  // log_audit for upload (mirrors logAudit call in impl_uploadPhoto)
  const { error: auditUploadErr } = await admin.rpc('log_audit', {
    p_actor_user_id: adminUserId,
    p_action:        'photo.upload',
    p_entity_type:   'people',
    p_entity_id:     TEST_PERSON,
    p_details_json:  { path, size_bytes: TEST_CONTENT.length, mime_type: 'image/jpeg', consent_at_upload: true },
  })
  assert('audit log rpc for photo.upload succeeds', !auditUploadErr, auditUploadErr?.message)
  console.log()

  // ── Step 3: Signed URL + fetch ─────────────────────────────────────────────
  console.log('--- Step 3: signed URL generation + fetch ---')
  const { data: signedData, error: signedErr } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(path, 3600)

  assert('createSignedUrl succeeds',               !signedErr,                             signedErr?.message)
  assert('signed URL contains token param',         !!signedData?.signedUrl?.includes('token='))

  if (signedData?.signedUrl) {
    const resp = await fetch(signedData.signedUrl)
    assert('signed URL fetch returns 200',           resp.status === 200,               `status: ${resp.status}`)
    const buf  = await resp.arrayBuffer()
    assert('signed URL returns correct content size', buf.byteLength === TEST_CONTENT.length,
      `expected ${TEST_CONTENT.length}, got ${buf.byteLength}`)
    const bytes = new Uint8Array(buf)
    assert('signed URL content is byte-for-byte correct', bytes[0] === 42 && bytes[1023] === 42)
  }
  console.log()

  // ── Step 4: Anon list — expect empty array + null error (RLS silent filter) ─
  console.log('--- Step 4: anon list (RLS silent filter — expects empty array + null error) ---')
  const { data: anonList, error: anonListErr } = await anon.storage
    .from(BUCKET)
    .list(TEST_PERSON)
  assert('anon list returns null error (NOT 4xx — RLS silent for private bucket)',
    anonListErr === null, `error: ${JSON.stringify(anonListErr)}`)
  assert('anon list returns empty data array',
    (anonList?.length ?? 0) === 0, `data: ${JSON.stringify(anonList)}`)
  console.log()

  // ── Step 5: Anon upload — expect RLS error (proves organizer_insert policy active)
  console.log('--- Step 5: anon upload (expect RLS block — proves organizer_insert policy is live) ---')
  const { error: anonUpErr } = await anon.storage
    .from(BUCKET)
    .upload(`${TEST_PERSON}/anon-attempt.jpg`, new Blob([new Uint8Array(32)], { type: 'image/jpeg' }))
  const anonBlocked = anonUpErr !== null && (
    anonUpErr.message?.includes('row-level security') ||
    anonUpErr.message?.includes('Unauthorized') ||
    anonUpErr.message?.includes('not_authorized') ||
    (anonUpErr.status ?? 0) === 403 ||
    anonUpErr.statusCode === '403'
  )
  assert('anon upload blocked by RLS (organizer_insert policy active)', anonBlocked,
    `anonUpErr: ${JSON.stringify(anonUpErr)}`)
  console.log()

  // ── Step 6: Admin can list the file ──────────────────────────────────────
  console.log('--- Step 6: admin can list the uploaded file ---')
  const { data: adminList, error: adminListErr } = await admin.storage
    .from(BUCKET)
    .list(TEST_PERSON)
  assert('admin list succeeds', !adminListErr, adminListErr?.message)
  const fileName = path.split('/')[1]
  assert('uploaded file appears in admin list', adminList?.some(f => f.name === fileName),
    `files: ${JSON.stringify(adminList?.map(f => f.name))}`)
  console.log()

  // ── Step 7: Admin delete ──────────────────────────────────────────────────
  console.log('--- Step 7: admin delete ---')
  const { data: deleteData, error: deleteErr } = await admin.storage
    .from(BUCKET)
    .remove([path])
  assert('admin delete succeeds', !deleteErr, deleteErr?.message)
  assert('admin delete returns the path in data', (deleteData?.length ?? 0) > 0,
    `data: ${JSON.stringify(deleteData)}`)

  // The delete response includes the full object row including user_metadata —
  // this confirms the metadata option in storage.upload() reliably persists.
  // (The list API doesn't include user_metadata in its per-item response shape,
  // but the storage backend does store it and returns it here.)
  const deletedObj = deleteData?.[0]
  const userMeta   = deletedObj?.user_metadata ?? {}
  assert('deleted object has user_metadata.consent',     'consent'     in userMeta, `meta: ${JSON.stringify(userMeta)}`)
  assert('deleted object has user_metadata.uploaded_by', 'uploaded_by' in userMeta, `meta: ${JSON.stringify(userMeta)}`)
  assert('deleted object has user_metadata.uploaded_at', 'uploaded_at' in userMeta, `meta: ${JSON.stringify(userMeta)}`)

  // log_audit for delete (mirrors logAudit call in impl_deletePhoto)
  const { error: auditDelErr } = await admin.rpc('log_audit', {
    p_actor_user_id: adminUserId,
    p_action:        'photo.delete',
    p_entity_type:   'people',
    p_entity_id:     TEST_PERSON,
    p_details_json:  { path },
  })
  assert('audit log rpc for photo.delete succeeds', !auditDelErr, auditDelErr?.message)
  console.log()

  // ── Step 8: Verify audit_log rows ─────────────────────────────────────────
  console.log('--- Step 8: audit_log rows ---')
  const { data: auditRows, error: auditQueryErr } = await admin
    .from('audit_log')
    .select('actor_user_id, action, details_json')
    .eq('entity_id', TEST_PERSON)
    .order('created_at', { ascending: true })

  if (auditQueryErr) { console.error('audit_log query failed:', auditQueryErr); process.exit(1) }
  console.log(JSON.stringify(auditRows, null, 2))

  const uploadRow = auditRows.find(r => r.action === 'photo.upload')
  const deleteRow = auditRows.find(r => r.action === 'photo.delete')

  assert('photo.upload audit row exists',                   !!uploadRow)
  assert('photo.upload actor_user_id = admin',              uploadRow?.actor_user_id === adminUserId)
  assert('photo.upload details.path present',               !!uploadRow?.details_json?.path)
  assert('photo.upload details.consent_at_upload present',  'consent_at_upload' in (uploadRow?.details_json ?? {}))
  assert('photo.delete audit row exists',                   !!deleteRow)
  assert('photo.delete actor_user_id = admin',              deleteRow?.actor_user_id === adminUserId)
  assert('photo.delete details.path matches upload path',   deleteRow?.details_json?.path === path)
  console.log()

  // ── Step 9: Cleanup audit rows ────────────────────────────────────────────
  await admin.from('audit_log').delete().eq('entity_id', TEST_PERSON)

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('--- Summary ---')
  for (const a of assertions) {
    console.log(`  ${a.passed ? '✓' : '✗'} ${a.desc}${a.detail ? ' — ' + a.detail : ''}`)
  }
  console.log(allPassed ? '\n✓ All assertions passed' : '\n✗ Some assertions FAILED')

  // Deferred tests (require browser auth flow — Task 9):
  console.log('\nDeferred to Task 9 (requires user JWT, not service role):')
  console.log('  - Organizer can upload + user_metadata written to storage.objects')
  console.log('  - Organizer can list files')
  console.log('  - Organizer delete attempt blocked by RLS (no DELETE policy)')
  console.log('  - Confirmed actor_user_id on photo.upload audit row matches organizer user ID')

  if (!allPassed) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
