/**
 * S8-T7 — Staging identity seed.
 *
 * Provisions two synthetic, login-capable identities in a staging Supabase
 * project: admin@example.com (role=admin) and organizer@example.com
 * (role=organizer). These are the same placeholder emails already hardcoded
 * in scripts/t8-playwright-import.mjs:51-52, so those live-test scripts can
 * assume the identities exist rather than provisioning their own.
 *
 * Run (tsc->node, compiled path):
 *   npx tsc -p scripts/tsconfig.s8-t7-seed.json
 *   node --env-file=.env.staging.local scripts/.build/scripts/s8-t7-seed-staging-identities.js
 *
 * (a) tsc->node here is HOUSE-STYLE / CONSISTENCY, not a libphonenumber-js
 *     requirement — this script has no phone handling at all (no import of
 *     lib/utils/phone.ts or any normalizePhone call), unlike
 *     scripts/repair-roster-birthdates.ts / s6-t6-import-commit.ts /
 *     s7-t3-roster-remigrate.ts, which forbid tsx for a real, documented
 *     silent-failure reason. This script simply follows the same compiled-
 *     path convention for uniformity across scripts/ that write to a real
 *     Supabase project.
 *
 * (b) Operational order is migrations-BEFORE-seed. On a FRESH staging DB,
 *     supabase/migrations/20260525121802_seed_admin_user.sql inserts NOTHING
 *     — it's gated on a pre-existing auth.users row for admin@example.com,
 *     which won't exist yet at migration-apply time on a brand-new project.
 *     This script is what actually creates that auth.users row (and the
 *     organizer one) on staging. If migrations are ever re-applied to
 *     staging AFTER this script has run (so admin@example.com's auth.users
 *     row already exists), that old migration would insert an app_users row
 *     carrying a real person's name into full_name — this script's UPSERT
 *     (see reconcileAppUser) self-heals that on its next run by overwriting
 *     full_name with the synthetic 'Staging Admin' value.
 *
 * (c) Guard-gated + staging-pinned. The shared preflight guard
 *     (scripts/preflight/guard.mjs + resolve-ref.mjs) only proves
 *     branch<->ref agreement per supabase/preflight.branch-ref.json — it
 *     would PASS if this script were run from `main` with the environment
 *     pointed at prod, because that's exactly what the guard is designed to
 *     allow for main. A second, script-local assertion (STAGING_REF below)
 *     pins THIS script to the staging project (or a local rehearsal) so it
 *     can never create synthetic accounts in prod even by accident.
 *     Hardcoding the staging ref literal is fine here — it's a project ref
 *     (already public in supabase/preflight.branch-ref.json and
 *     scripts/preflight/selftest.mjs), not a secret.
 *
 * NO AUDIT LOGGING: this script deliberately does not import or call
 * lib/audit.ts. This is throwaway-environment provisioning — the staging
 * audit_log table is itself synthetic, and the closest existing action
 * (AUDIT_ACTIONS.APP_USER_INVITE) would misreport "invited" for accounts
 * that were never emailed an invite. Dropping the audit import is also why
 * this script's tsconfig includes nothing from lib/.
 *
 * ENV: reads process.env.NEXT_PUBLIC_SUPABASE_URL and
 * process.env.SUPABASE_SERVICE_ROLE_KEY directly. Does NOT auto-load any
 * .env file and does NOT fall back to any default URL (see the
 * scripts/t8-playwright-import.mjs:48 prod-ref-fallback anti-pattern this
 * deliberately avoids) — pass --env-file explicitly at the call site.
 *
 * OUTPUT: a role-keyed summary only (e.g. "admin: auth already_existed,
 * app_users upserted"). Never prints an email, id, name, or any value beyond
 * the two fixed synthetic placeholder strings baked into IDENTITIES below.
 */

import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Staging pin -- see header (c). Not a secret; already public in
// supabase/preflight.branch-ref.json and scripts/preflight/selftest.mjs.
// ---------------------------------------------------------------------------
const STAGING_REF = 'sijfyvaodqkawbeuyrpu'

// ---------------------------------------------------------------------------
// Preflight guard -- dynamic-imports the real guard.mjs/resolve-ref.mjs
// (plain Node ESM, not compiled by this script's tsconfig) rather than
// duplicating evaluate()/resolveRef(). getBranch()/loadMap() ARE duplicated
// below (tiny, ~10 lines total) because guard.mjs does not export them --
// only evaluate and matchBranchRef are exported for library use.
// Mirrors scripts/s7-t3-roster-remigrate.ts's proven preamble.
// ---------------------------------------------------------------------------

interface ResolvedRef {
  ref: string | null
  local: boolean
  sources: Record<string, string | null>
  disagree: boolean
}
interface EvaluateArgs {
  branch: string
  op?: string
  resolved: ResolvedRef | null
  map: unknown
}
interface EvaluateResult {
  ok: boolean
  reason: string | null
}
type EvaluateFn = (args: EvaluateArgs) => EvaluateResult
type ResolveRefFn = (args: { op?: string }) => ResolvedRef

function getBranch(): string {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function loadMap(): unknown {
  const mapPath = path.resolve(process.cwd(), 'supabase/preflight.branch-ref.json')
  try {
    if (!existsSync(mapPath)) return null
    return JSON.parse(readFileSync(mapPath, 'utf8'))
  } catch {
    return null
  }
}

async function runPreflightGuard(op: string): Promise<ResolvedRef> {
  // Plain absolute filesystem paths, NOT file:// URLs -- module=commonjs
  // compiles this dynamic import() to require(), and Node's require()
  // accepts a bare absolute path but not a file:// URL string.
  const guardPath = path.resolve(process.cwd(), 'scripts/preflight/guard.mjs')
  const resolveRefPath = path.resolve(process.cwd(), 'scripts/preflight/resolve-ref.mjs')

  const guardMod = (await import(guardPath)) as { evaluate: EvaluateFn }
  const resolveRefMod = (await import(resolveRefPath)) as { resolveRef: ResolveRefFn }

  const branch = getBranch()
  const map = loadMap()
  const resolved = resolveRefMod.resolveRef({ op })
  const result = guardMod.evaluate({ branch, op, resolved, map })

  if (!result.ok) {
    console.error('')
    console.error('==================== PREFLIGHT ABORT (s8-t7-seed-staging-identities) ====================')
    console.error(`  branch:        ${branch || '(empty/detached)'}`)
    console.error(`  op:            ${op}`)
    console.error(`  resolved ref:  ${resolved.ref ?? '(none)'} (local=${resolved.local})`)
    console.error(`  reason:        ${result.reason}`)
    console.error('============================================================================================')
    console.error('')
    process.exit(1)
  }
  console.log(`[preflight] OK -- branch=${branch} op=${op} ref=${resolved.ref} local=${resolved.local}`)
  return resolved
}

// ---------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------

type Role = 'admin' | 'organizer'

interface IdentitySpec {
  email: string
  role: Role
  fullName: string
}

const IDENTITIES: IdentitySpec[] = [
  { email: 'admin@example.com', role: 'admin', fullName: 'Staging Admin' },
  { email: 'organizer@example.com', role: 'organizer', fullName: 'Staging Organizer' },
]

async function ensureAuthUser(
  supabase: SupabaseClient,
  email: string
): Promise<{ id: string; created: boolean }> {
  // No server-side email filter on admin.listUsers() in this SDK version
  // (same documented limitation as lib/actions/admin-users.impl.ts) -- list
  // and filter client-side.
  const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 })
  if (error) throw new Error(`listUsers failed: ${error.message}`)

  const existing = data.users.find((u) => u.email === email)
  if (existing) return { id: existing.id, created: false }

  // Password auth is never used by this app (magic-link only), but
  // createUser requires a value. Generated, never logged, discarded.
  const password = randomBytes(24).toString('base64url')

  const { data: created, error: createErr } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (createErr || !created.user) {
    throw new Error(`createUser failed: ${createErr?.message ?? 'no user returned'}`)
  }
  return { id: created.user.id, created: true }
}

async function reconcileAppUser(supabase: SupabaseClient, id: string, spec: IdentitySpec): Promise<void> {
  // No DB-level FK from app_users.id -> auth.users.id (verified live: only a
  // self-ref FK on invited_by exists), so auth.users and app_users can drift.
  // app_users.email is UNIQUE, and we upsert on `id` — so a stale row owning
  // this email under a DIFFERENT id (e.g. an auth user deleted + recreated)
  // would collide on the email unique constraint instead of reconciling.
  // Delete any such stale-by-email row first to keep this script re-runnable.
  const { error: delErr } = await supabase
    .from('app_users')
    .delete()
    .eq('email', spec.email)
    .neq('id', id)
  if (delErr) throw new Error(`stale app_users cleanup failed: ${delErr.message}`)

  const { error } = await supabase
    .from('app_users')
    .upsert(
      { id, email: spec.email, role: spec.role, active: true, full_name: spec.fullName },
      { onConflict: 'id' }
    )
  if (error) throw new Error(`app_users upsert failed: ${error.message}`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const resolved = await runPreflightGuard('staging-identity-seed')

  // STAGING PIN (mandatory backstop, on top of the shared guard) -- see
  // header (c) for rationale.
  if (resolved.ref !== STAGING_REF && !resolved.local) {
    console.error('')
    console.error('==================== STAGING PIN ABORT ====================')
    console.error(`  resolved ref: ${resolved.ref ?? '(none)'} (local=${resolved.local})`)
    console.error(`  expected:     ${STAGING_REF} (or a local target)`)
    console.error('  reason:       this script only ever creates synthetic accounts')
    console.error('                against the staging project or a local rehearsal --')
    console.error('                never against prod, even if the shared guard passed.')
    console.error('=============================================================')
    console.error('')
    process.exit(1)
  }
  console.log(`[staging-pin] OK -- ref=${resolved.ref ?? '(local)'} pinned to staging or local`)

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error(
      'FATAL: missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in process.env. ' +
        'This script does not auto-load any .env file and never falls back to a default URL -- ' +
        'pass --env-file explicitly (see the header run command).'
    )
    process.exit(1)
  }

  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })

  const summary: string[] = []
  for (const spec of IDENTITIES) {
    const { id, created } = await ensureAuthUser(supabase, spec.email)
    await reconcileAppUser(supabase, id, spec)
    summary.push(`${spec.role}: auth ${created ? 'created' : 'already_existed'}, app_users upserted`)
  }

  console.log('')
  console.log('[s8-t7-seed] Summary:')
  for (const line of summary) console.log(`  - ${line}`)
}

main().catch((err) => {
  console.error('[s8-t7-seed] FATAL:', err instanceof Error ? err.message : err)
  process.exit(1)
})
