/**
 * S6-T2.2 — Soft-deactivate the @test.invalid app_users rows that leaked into
 * prod during S6-T2 (D1 wipe preserves app_users; audit_log.actor_user_id has
 * a NO ACTION FK to app_users, so these rows can't be hard-deleted).
 *
 * Run:
 *   Read-only preview (no writes, always safe to run):
 *     npx tsx --env-file .env.local scripts/deactivate-test-users.ts
 *   Armed (soft-deactivates every app_users row matching
 *   email LIKE '%@test.invalid' AND active=true):
 *     npx tsx --env-file .env.local scripts/deactivate-test-users.ts --confirm-deactivate
 *     (or DEACTIVATE_CONFIRM=yes npx tsx --env-file .env.local scripts/deactivate-test-users.ts)
 *
 * Architect-approved 2026-08-09 (S6-T2.2 plan). Mirrors wipe-and-reseed.ts's
 * discipline: env-guarded, one atomic transaction via the Management API
 * (SUPABASE_ACCESS_TOKEN, proven atomic in T2 — mid-body RAISE rolls back the
 * whole transaction, nothing partial persists), independent supabase-js
 * re-verify after the API reports success.
 *
 * Hardening over the first draft: before/target/emails are all captured with
 * in-SQL SELECTs inside the same DO block as the UPDATE and the assertions —
 * not pre-captured in TypeScript and interpolated as literals. This makes the
 * before/after assertion self-consistent (immune to any app_users write
 * between the read-only preview and the armed run) and avoids building the
 * emails JSON via string interpolation. Only adminId, runId, and the 3 real
 * login emails (fixed constants, never user input) are interpolated into the
 * SQL string.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PROJECT_REF = 'bftifxgdcmisasgvobuf'
const ADMIN_EMAIL = 'ashblazerr@gmail.com'
const ADMIN_UUID_EXPECTED = 'ea742388-4af3-4e08-ab60-0354d068a949'
const REAL_LOGIN_EMAILS = ['ashblazerr@gmail.com', 'hannyysaputrii@gmail.com', 'ashblazerr+t6test@gmail.com'] as const

// ---------------------------------------------------------------------------
// Env / client setup (duplicated from wipe-and-reseed.ts — each script is
// self-contained, no shared scripts/ helper module exists yet)
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var: ${name}`)
  return v
}

function assertEnvGuards() {
  const url = requireEnv('NEXT_PUBLIC_SUPABASE_URL')
  if (!url.includes(PROJECT_REF)) {
    throw new Error(
      `ENV GUARD FAILED: NEXT_PUBLIC_SUPABASE_URL does not resolve to prod (${PROJECT_REF}). Got: ${url}`
    )
  }

  const linkedRefPath = path.resolve(__dirname, '../supabase/.temp/project-ref')
  if (!existsSync(linkedRefPath)) {
    throw new Error(`ENV GUARD FAILED: ${linkedRefPath} not found — run "supabase link" against prod first.`)
  }
  const linkedRef = readFileSync(linkedRefPath, 'utf8').trim()
  if (linkedRef !== PROJECT_REF) {
    throw new Error(`ENV GUARD FAILED: linked project-ref is "${linkedRef}", expected "${PROJECT_REF}".`)
  }

  console.log(`[env-guard] OK — NEXT_PUBLIC_SUPABASE_URL and supabase/.temp/project-ref both resolve to ${PROJECT_REF}`)
}

function getAdminClient(): SupabaseClient {
  const url = requireEnv('NEXT_PUBLIC_SUPABASE_URL')
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY')
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
}

async function managementApiQuery(sql: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  const token = requireEnv('SUPABASE_ACCESS_TOKEN')
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  })
  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = await res.text()
  }
  return { ok: res.ok, status: res.status, body }
}

// ---------------------------------------------------------------------------
// Read-only preflight
// ---------------------------------------------------------------------------

type TargetRow = { email: string; role: string; active: boolean; created_at: string }

async function preview(admin: SupabaseClient): Promise<{ targets: TargetRow[]; totalActive: number }> {
  const { data: targets, error: e1 } = await admin
    .from('app_users')
    .select('email, role, active, created_at')
    .like('email', '%@test.invalid')
    .eq('active', true)
    .order('created_at')
  if (e1) throw new Error(`Preview target query failed: ${e1.message}`)

  const { count: totalActive, error: e2 } = await admin
    .from('app_users')
    .select('*', { count: 'exact', head: true })
    .eq('active', true)
  if (e2) throw new Error(`Preview total-active count failed: ${e2.message}`)

  console.log(`[preview] ${targets?.length ?? 0} target row(s) (email LIKE '%@test.invalid' AND active=true):`)
  for (const row of targets ?? []) {
    console.log(`  ${row.email}  role=${row.role}  created_at=${row.created_at}`)
  }
  console.log(`[preview] total active app_users today: ${totalActive}`)

  return { targets: (targets ?? []) as TargetRow[], totalActive: totalActive ?? 0 }
}

async function resolveAdminActor(admin: SupabaseClient): Promise<string> {
  const { data, error } = await admin
    .from('app_users')
    .select('id, email, role, active')
    .eq('email', ADMIN_EMAIL)
    .maybeSingle()
  if (error) throw new Error(`Admin actor lookup failed: ${error.message}`)
  if (!data) throw new Error(`CROSS-CHECK FAILED: no app_users row for ${ADMIN_EMAIL}`)
  if (data.role !== 'admin' || !data.active) {
    throw new Error(`CROSS-CHECK FAILED: ${ADMIN_EMAIL} is not an active admin live (role=${data.role}, active=${data.active})`)
  }
  if (data.id !== ADMIN_UUID_EXPECTED) {
    throw new Error(`CROSS-CHECK FAILED: ${ADMIN_EMAIL} resolves to ${data.id}, expected ${ADMIN_UUID_EXPECTED}`)
  }
  console.log(`[admin-actor] OK — ${ADMIN_EMAIL} resolves to expected UUID ${ADMIN_UUID_EXPECTED}`)
  return data.id
}

// ---------------------------------------------------------------------------
// Armed — one atomic transaction via the Management API
// ---------------------------------------------------------------------------

function buildDeactivateSql(adminId: string, runId: string): string {
  const realEmailsList = REAL_LOGIN_EMAILS.map((e) => `'${e}'`).join(',')
  return `
BEGIN;
DO $$
DECLARE
  v_before  int;
  v_target  int;
  v_after   int;
  v_emails  jsonb;
BEGIN
  SELECT count(*) INTO v_before FROM app_users WHERE active = true;

  SELECT count(*), coalesce(jsonb_agg(email), '[]'::jsonb) INTO v_target, v_emails
    FROM app_users WHERE active = true AND email LIKE '%@test.invalid';

  UPDATE app_users SET active = false
    WHERE active = true AND email LIKE '%@test.invalid';

  SELECT count(*) INTO v_after FROM app_users WHERE active = true;

  IF v_after <> v_before - v_target THEN
    RAISE EXCEPTION 'deactivate assert: after=% before=% target=%', v_after, v_before, v_target;
  END IF;

  IF (SELECT count(*) FROM app_users
      WHERE email IN (${realEmailsList}) AND active = true) <> 3 THEN
    RAISE EXCEPTION 'real-login guard failed: a protected account was deactivated';
  END IF;

  PERFORM log_audit(
    p_actor_user_id => '${adminId}'::uuid,
    p_action => 'data.deactivate_test_users',
    p_entity_type => 'system',
    p_entity_id => '${runId}',
    p_details_json => jsonb_build_object(
      'before_active', v_before, 'target_count', v_target, 'emails', v_emails
    )
  );

  RAISE NOTICE 'deactivated % @test.invalid app_users (active: % -> %)', v_target, v_before, v_after;
END $$;
COMMIT;
  `.trim()
}

async function stepDeactivate(admin: SupabaseClient, adminId: string, beforeAuditCount: number) {
  const runId = randomUUID()
  const sql = buildDeactivateSql(adminId, runId)

  console.log('[armed] sending deactivate transaction to the Management API...')
  const { ok, status, body } = await managementApiQuery(sql)
  if (!ok) {
    throw new Error(`ARMED RUN FAILED (rolled back — nothing changed): HTTP ${status} — ${JSON.stringify(body)}`)
  }
  console.log('[armed] Management API reported success:', JSON.stringify(body))
  console.log('[armed] independently re-verifying via supabase-js...')

  const { data: stillTargets, error: e1 } = await admin
    .from('app_users')
    .select('email')
    .like('email', '%@test.invalid')
    .eq('active', true)
  if (e1) throw new Error(`Re-verify target recount failed: ${e1.message}`)
  if ((stillTargets?.length ?? 0) !== 0) {
    throw new Error(`RE-VERIFY FAILED: ${stillTargets?.length} @test.invalid row(s) still active`)
  }

  const { data: realRows, error: e2 } = await admin
    .from('app_users')
    .select('email, active')
    .in('email', REAL_LOGIN_EMAILS as unknown as string[])
  if (e2) throw new Error(`Re-verify real-login recount failed: ${e2.message}`)
  const realActiveCount = (realRows ?? []).filter((r) => r.active).length
  if (realActiveCount !== 3) {
    throw new Error(`RE-VERIFY FAILED: expected 3 real logins active, got ${realActiveCount}`)
  }

  const { count: totalActiveAfter, error: e3 } = await admin
    .from('app_users')
    .select('*', { count: 'exact', head: true })
    .eq('active', true)
  if (e3) throw new Error(`Re-verify total-active recount failed: ${e3.message}`)

  const { count: auditLogAfter, error: e4 } = await admin
    .from('audit_log')
    .select('*', { count: 'exact', head: true })
  if (e4) throw new Error(`Re-verify audit_log recount failed: ${e4.message}`)
  if ((auditLogAfter ?? 0) < beforeAuditCount + 1) {
    throw new Error(`RE-VERIFY FAILED: audit_log=${auditLogAfter}, expected >= ${beforeAuditCount + 1}`)
  }

  console.log(
    `[armed] OK — independent recount confirms: 0 @test.invalid rows still active, ` +
      `3 real logins active, total active=${totalActiveAfter}, audit_log=${auditLogAfter} (>= ${beforeAuditCount + 1})`
  )
  return { totalActiveAfter, auditLogAfter }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const confirmed = process.argv.includes('--confirm-deactivate') || process.env.DEACTIVATE_CONFIRM === 'yes'

  console.log('=== S6-T2.2 deactivate-test-users — read-only preflight ===')
  assertEnvGuards()
  const admin = getAdminClient()

  await preview(admin)

  const { count: beforeAuditCount, error: eAudit } = await admin
    .from('audit_log')
    .select('*', { count: 'exact', head: true })
  if (eAudit) throw new Error(`audit_log baseline count failed: ${eAudit.message}`)
  console.log(`[preview] audit_log baseline: ${beforeAuditCount}`)

  if (!confirmed) {
    console.log('')
    console.log('No --confirm-deactivate / DEACTIVATE_CONFIRM=yes given — preview complete. Nothing was modified. Exiting.')
    return
  }

  const adminId = await resolveAdminActor(admin)

  console.log('')
  console.log('=== Armed: deactivating @test.invalid app_users ===')
  const result = await stepDeactivate(admin, adminId, beforeAuditCount ?? 0)

  console.log('')
  console.log('=== DONE ===')
  console.log(JSON.stringify(result, null, 2))
}

main().catch((err) => {
  console.error('')
  console.error('FATAL:', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
