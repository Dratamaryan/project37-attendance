/**
 * Sprint 6 T10a — live verification: the real people-roster export code path
 * (impl_getRosterRows, mapRosterRowToExportRow, the same SheetJS assembly and
 * logAudit call app/api/admin/export/people/route.ts uses) run against LIVE
 * PROD with a real admin session — not a bypass, and not the Next.js route
 * wrapper directly, since that wrapper's createClient() calls next/headers
 * cookies() which has no request-scoped context outside the Next.js runtime
 * (same reason tests/integration/admin-api-active-check.test.ts mocks
 * '@/lib/supabase/server' rather than invoking it for real). This script
 * proves what the local-Docker vitest suite structurally cannot: that the
 * live `admin_select_all` RLS policy actually grants the real admin session
 * full-roster visibility, and that a real export.create audit row lands in
 * live audit_log.
 *
 * Does NOT insert synthetic soft-deleted/anonymized fixture rows into the
 * live `people` table — live prod currently has 0 soft-deleted and 0
 * anonymized rows (confirmed below), and manufacturing fake tombstoned PII
 * rows in the real roster to exercise that branch is worse than just noting
 * the gap. Scope-filter correctness (soft-deleted included, anonymized
 * excluded) is fully proven against synthetic fixtures + an independent
 * service-role recount in tests/integration/people-export-actions.test.ts
 * (local Docker). This script proves the RLS/client decision and the audit
 * write against real data instead.
 *
 * No PII is printed to stdout — only row counts and label-value tallies. The
 * assembled workbook is written to the scratchpad dir for optional manual
 * inspection, never to the repo.
 *
 * Run: npx tsx --env-file .env.local scripts/s6-t10a-people-export-live-test.ts
 */

import { writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import * as XLSX from 'xlsx'
import { requireActiveAdmin } from '../lib/auth/require-admin'
import { AUDIT_ACTIONS, logAudit } from '../lib/audit'
import { impl_getRosterRows, mapRosterRowToExportRow } from '../lib/actions/people-export.impl'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const ADMIN_EMAIL = 'ashblazerr@gmail.com' // confirmed live: role=admin, active=true

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY')
  process.exit(1)
}
if (!SUPABASE_URL.includes('bftifxgdcmisasgvobuf')) {
  console.error(`Expected the live prod project (bftifxgdcmisasgvobuf), got: ${SUPABASE_URL}`)
  process.exit(1)
}

const serviceAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const anonClient = createClient(SUPABASE_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

async function getAdminSession() {
  const { data: linkData, error: linkErr } = await serviceAdmin.auth.admin.generateLink({
    type: 'magiclink',
    email: ADMIN_EMAIL,
  })
  if (linkErr) throw linkErr

  const { data: verifyData, error: verifyErr } = await anonClient.auth.verifyOtp({
    token_hash: linkData.properties.hashed_token,
    type: 'magiclink',
  })
  if (verifyErr) throw verifyErr
  if (!verifyData.session) throw new Error('verifyOtp succeeded but returned no session')
  return verifyData.session
}

async function main() {
  console.log('\n=== S6-T10a — live people-roster export test ===\n')

  const { count: gtTotal, error: gtErr } = await serviceAdmin
    .from('people')
    .select('id', { count: 'exact', head: true })
    .is('anonymized_at', null)
  if (gtErr) throw new Error(`ground-truth count failed: ${gtErr.message}`)

  const { count: gtSoftDeleted } = await serviceAdmin
    .from('people')
    .select('id', { count: 'exact', head: true })
    .not('deleted_at', 'is', null)
    .is('anonymized_at', null)

  const { count: gtAnonymized } = await serviceAdmin
    .from('people')
    .select('id', { count: 'exact', head: true })
    .not('anonymized_at', 'is', null)

  console.log('Ground truth (service-role recount):')
  console.log('  in-scope (anonymized_at IS NULL):     ', gtTotal)
  console.log('  of which soft-deleted:                 ', gtSoftDeleted)
  console.log('  excluded (anonymized):                 ', gtAnonymized)
  if ((gtSoftDeleted ?? 0) === 0 && (gtAnonymized ?? 0) === 0) {
    console.log(
      '  NOTE: live prod currently has 0 soft-deleted and 0 anonymized people rows — the ' +
        'scope-filter branches cannot be exercised against real data. Proven against synthetic ' +
        'fixtures + independent recount in tests/integration/people-export-actions.test.ts instead.',
    )
  }

  const session = await getAdminSession()
  const sessionClient = createClient(SUPABASE_URL!, ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { error: setSessionErr } = await sessionClient.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  })
  if (setSessionErr) throw setSessionErr

  const guard = await requireActiveAdmin(sessionClient)
  console.log('\nrequireActiveAdmin(live admin session):', guard.status)
  if (guard.status !== 'ok') {
    console.log('\n✗ FAIL — real live admin session was not recognized as an active admin')
    process.exit(1)
  }

  const result = await impl_getRosterRows({ supabase: sessionClient })
  if (result.status !== 'ok') {
    console.log(`\n✗ FAIL — impl_getRosterRows: ${result.message}`)
    process.exit(1)
  }

  console.log('\nimpl_getRosterRows (real RLS-applied session client):')
  console.log('  rows returned:                         ', result.data.length)

  const scopeMatches = result.data.length === (gtTotal ?? -1)
  console.log('  matches ground-truth in-scope count:   ', scopeMatches)

  const exportRows = result.data.map(mapRosterRowToExportRow)

  const consentTally = { granted: 0, refused: 0, unknown: 0 } as Record<string, number>
  const publishTally = { Yes: 0, No: 0 } as Record<string, number>
  const statusTally = { active: 0, 'inactive/soft-deleted': 0 } as Record<string, number>
  for (const row of exportRows) {
    consentTally[row['Photo consent']] = (consentTally[row['Photo consent']] ?? 0) + 1
    publishTally[row['Can publish']] = (publishTally[row['Can publish']] ?? 0) + 1
    statusTally[row.Status] = (statusTally[row.Status] ?? 0) + 1
  }
  console.log('\nLabel tallies (aggregate only — no PII):')
  console.log('  Photo consent: ', consentTally)
  console.log('  Can publish:   ', publishTally)
  console.log('  Status:        ', statusTally)

  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(exportRows), 'People Roster')
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer

  const outPath = `/private/tmp/claude-501/-Users-ryandratama-dev-project37-attendance-project37-rewrite/5291c376-f4c0-4eab-9936-4098cf4bb88a/scratchpad/s6-t10a-live-export-${Date.now()}.xlsx`
  writeFileSync(outPath, buffer)
  console.log('\nWorkbook written (scratchpad, not repo, for manual inspection):', outPath)

  const exportId = randomUUID()
  await logAudit(
    {
      actorUserId: guard.actorId,
      action: AUDIT_ACTIONS.EXPORT_CREATE,
      entityType: 'export',
      entityId: exportId,
      detailsJson: { export_kind: 'people_roster', row_count: exportRows.length },
      ipAddress: null,
      userAgent: 's6-t10a-live-test-script',
    },
    sessionClient,
  )

  const { data: auditRow, error: auditErr } = await serviceAdmin
    .from('audit_log')
    .select('actor_user_id, action, entity_type, entity_id, details_json')
    .eq('entity_id', exportId)
    .single()
  if (auditErr || !auditRow) throw new Error(`audit readback failed: ${auditErr?.message}`)

  console.log('\nAudit row readback (service-role, live):')
  console.log('  action:      ', auditRow.action)
  console.log('  entity_type: ', auditRow.entity_type)
  console.log('  entity_id:   ', auditRow.entity_id)
  console.log('  details_json:', JSON.stringify(auditRow.details_json))
  console.log('  actor matches guard.actorId:', auditRow.actor_user_id === guard.actorId)

  const detailsKeys = Object.keys(auditRow.details_json as Record<string, unknown>).sort()
  const detailsOk = JSON.stringify(detailsKeys) === JSON.stringify(['export_kind', 'row_count'])
  console.log('  details_json has exactly {export_kind, row_count}, no PII:', detailsOk)

  const allOk =
    guard.status === 'ok' &&
    result.status === 'ok' &&
    scopeMatches &&
    auditRow.action === AUDIT_ACTIONS.EXPORT_CREATE &&
    auditRow.actor_user_id === guard.actorId &&
    detailsOk

  console.log(allOk ? '\n✓ PASS' : '\n✗ FAIL')
  process.exit(allOk ? 0 : 1)
}

main().catch(err => {
  console.error('\n✗ FAIL — unhandled error:', err)
  process.exit(1)
})
