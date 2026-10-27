// Integration tests for Sprint 9 R6 A1 — anon-surface hardening
// (20261027120000_s9_r6_anon_surface_hardening.sql, decisions D1 / D2,
// AC 5 / AC 14 / AC 17).
// Runs against local Docker Supabase only (configured in .env.test.local).
// Run: npm test -- s9-r6-anon-surface
//
// Catalog privileges are not reachable through PostgREST, so those assertions
// go through psql inside the local DB container (docker exec), as in
// rsvp-rpc.test.ts. The last-admin check runs inside a psql transaction that
// always rolls back.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'child_process'
import { randomUUID } from 'crypto'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !anonKey || !serviceRoleKey) {
  throw new Error(
    'Missing env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY',
  )
}

const { hostname } = new URL(url)
if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
  throw new Error(
    `[s9-r6-anon-surface.test.ts] NEXT_PUBLIC_SUPABASE_URL (${hostname}) is not local Docker. ` +
      `This suite creates auth users and runs psql via docker exec — local Docker only.`,
  )
}

const DB_CONTAINER = 'supabase_db_project37-rewrite'
// Same literal as supabase/seed.sql — local-only placeholder, not a secret.
const LOCAL_GATE = 'local-dev-only-rsvp-gate-not-a-secret'
// Seeded baseline admin (supabase/seed.sql) — app_users FK target for created_by.
const BASELINE_ADMIN_ID = '00000000-0000-0000-0000-000000000001'

const S3_VIEWS = [
  'attendance_summary',
  'event_attendance_trend',
  'new_vs_returning_monthly',
  'parish_breakdown',
  'person_attendance_counts',
] as const
const RSVP_TABLES = ['event_rsvp_links', 'event_rsvps'] as const
const ALL_TABLE_PRIVS = [
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN',
] as const

const POLICY_HELPERS = ['is_admin', 'is_organizer', 'is_active_app_user'] as const

function psql(sql: string): string {
  return execFileSync(
    'docker',
    ['exec', DB_CONTAINER, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atc', sql],
    { encoding: 'utf8' },
  ).trim()
}

/** Privileges `role` holds on public.<rel>, sorted; '' when none. */
function tablePrivs(role: string, rel: string): string {
  return psql(
    `SELECT coalesce(string_agg(p, ',' ORDER BY p), '') FROM unnest(array['${ALL_TABLE_PRIVS.join("','")}']) p ` +
      `WHERE has_table_privilege('${role}', 'public.${rel}', p)`,
  )
}

/** Grantee names holding EXECUTE in proacl; '' stands for PUBLIC. */
function executeGrantees(fn: string): string[] {
  const out = psql(
    `SELECT coalesce(string_agg(CASE WHEN a.grantee = 0 THEN '' ELSE a.grantee::regrole::text END, ',' ORDER BY 1), '') ` +
      `FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a ` +
      `WHERE p.oid = 'public.${fn}()'::regprocedure AND a.privilege_type = 'EXECUTE'`,
  )
  return out.split(',')
}

let serviceAdmin: SupabaseClient
let anon: SupabaseClient
let adminSession: SupabaseClient
let organizerSession: SupabaseClient

const ts = Date.now()
const authUserIds: string[] = []
const eventIds: string[] = []
const personIds: string[] = []
let openToken = ''

async function signedInAs(role: 'admin' | 'organizer'): Promise<SupabaseClient> {
  const email = `s9r6-${role}-${ts}@test.invalid`
  const password = `S9r6-${role}-${ts}!`
  const { data: created, error: createErr } = await serviceAdmin.auth.admin.createUser({
    email, password, email_confirm: true,
  })
  if (createErr || !created.user) throw new Error(`createUser ${role}: ${createErr?.message}`)
  authUserIds.push(created.user.id)

  const { error: appErr } = await serviceAdmin.from('app_users').insert({
    id: created.user.id, email, full_name: `S9R6 ${role}`, role, active: true,
  })
  if (appErr) throw new Error(`app_users insert ${role}: ${appErr.message}`)

  const tmp = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { data: signIn, error: signInErr } = await tmp.auth.signInWithPassword({ email, password })
  if (signInErr || !signIn.session) throw new Error(`signIn ${role}: ${signInErr?.message ?? 'no session'}`)
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${signIn.session.access_token}` } },
  })
}

beforeAll(async () => {
  serviceAdmin = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })
  anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })

  adminSession = await signedInAs('admin')
  organizerSession = await signedInAs('organizer')

  // One live person, so the people read has something to return.
  const { data: person, error: personErr } = await serviceAdmin
    .from('people')
    .insert({
      phone_e164: `+62999${(ts % 1_000_000).toString().padStart(6, '0')}0001`,
      full_name: 'S9R6 Test Person',
      nickname: 'S9R6',
    })
    .select('id')
    .single()
  if (personErr || !person) throw new Error(`insert person: ${personErr?.message}`)
  personIds.push((person as { id: string }).id)

  // One open RSVP link for the anon RPC regression.
  const scheduledAt = new Date(Date.now() + 5 * 86_400_000).toISOString()
  const name = `S9R6 Test Event ${randomUUID().slice(0, 8)}`
  const { data: ev, error: evErr } = await serviceAdmin
    .from('events')
    .insert({
      name,
      event_type: 'adhoc',
      start_date: scheduledAt.slice(0, 10),
      start_time: '18:00:00',
      duration_min: 120,
      active: true,
      created_by: BASELINE_ADMIN_ID,
    })
    .select('id')
    .single()
  if (evErr || !ev) throw new Error(`insert event: ${evErr?.message}`)
  eventIds.push((ev as { id: string }).id)

  const { data: inst, error: instErr } = await serviceAdmin
    .from('event_instances')
    .insert({
      event_id: (ev as { id: string }).id,
      scheduled_at: scheduledAt,
      event_name_snapshot: name,
      status: 'scheduled',
    })
    .select('id')
    .single()
  if (instErr || !inst) throw new Error(`insert instance: ${instErr?.message}`)

  const { data: link, error: linkErr } = await serviceAdmin
    .from('event_rsvp_links')
    .insert({ event_instance_id: (inst as { id: string }).id, created_by: BASELINE_ADMIN_ID })
    .select('token')
    .single()
  if (linkErr || !link) throw new Error(`insert link: ${linkErr?.message}`)
  openToken = (link as { token: string }).token
}, 60_000)

afterAll(async () => {
  if (!serviceAdmin) return
  // events → event_instances (CASCADE) → event_rsvp_links + event_rsvps (CASCADE)
  if (eventIds.length > 0) await serviceAdmin.from('events').delete().in('id', eventIds)
  if (personIds.length > 0) await serviceAdmin.from('people').delete().in('id', personIds)
  for (const id of authUserIds) {
    await serviceAdmin.from('app_users').delete().eq('id', id)
    await serviceAdmin.auth.admin.deleteUser(id)
  }
}, 60_000)

// ---------------------------------------------------------------------------
// a. whole-schema anon-EXECUTE allowlist (AC 5)
// ---------------------------------------------------------------------------

describe('anon EXECUTE allowlist (AC 5)', () => {
  it('anon can execute exactly the allowlisted non-extension functions in public + graphql_public', () => {
    const out = psql(
      `SELECT n.nspname || '.' || p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace ` +
        `WHERE n.nspname IN ('public', 'graphql_public') ` +
        `AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e') ` +
        `AND has_function_privilege('anon', p.oid, 'EXECUTE') ORDER BY 1`,
    )
    // A new function anon can run must be added here deliberately — or revoked.
    expect(out.split('\n')).toEqual(
      [
        'graphql_public.graphql',
        'public.get_default_language',
        'public.get_rsvp_context',
        // S11-T12: the three RLS policy helpers keep anon EXECUTE only while anon
        // still holds the Supabase default table grants (TO public policies call
        // them as the caller). Remove them here when S11-T12 revokes anon.
        'public.is_active_app_user',
        'public.is_admin',
        'public.is_organizer',
        'public.submit_rsvp',
      ].sort(),
    )
  })
})

// ---------------------------------------------------------------------------
// b. the four helpers — no PUBLIC entry (D2 double-grant trap)
// ---------------------------------------------------------------------------

describe('helper function EXECUTE grants (D2)', () => {
  for (const fn of [...POLICY_HELPERS, 'enforce_last_admin'] as const) {
    it(`${fn}: no PUBLIC EXECUTE entry in proacl`, () => {
      expect(executeGrantees(fn)).not.toContain('')
    })
  }

  for (const fn of POLICY_HELPERS) {
    // S11-T12 removes anon from these three.
    it(`${fn}: explicit EXECUTE for anon, authenticated and service_role`, () => {
      expect(executeGrantees(fn)).toEqual(expect.arrayContaining(['anon', 'authenticated', 'service_role']))
    })
  }

  it('enforce_last_admin: explicit EXECUTE for authenticated and service_role, not anon', () => {
    const grantees = executeGrantees('enforce_last_admin')
    expect(grantees).toEqual(expect.arrayContaining(['authenticated', 'service_role']))
    expect(grantees).not.toContain('anon')
    expect(psql(`SELECT has_function_privilege('anon', 'public.enforce_last_admin()', 'EXECUTE')`)).toBe('f')
  })
})

// ---------------------------------------------------------------------------
// c. view / RSVP table privileges (AC 17)
// ---------------------------------------------------------------------------

describe('S3 view and RSVP table privileges (AC 17)', () => {
  for (const view of S3_VIEWS) {
    it(`${view}: anon holds no privilege; authenticated holds SELECT only`, () => {
      expect(tablePrivs('anon', view)).toBe('')
      expect(tablePrivs('authenticated', view)).toBe('SELECT')
    })
  }

  for (const table of RSVP_TABLES) {
    it(`${table}: anon holds no privilege`, () => {
      expect(tablePrivs('anon', table)).toBe('')
    })
  }
})

// ---------------------------------------------------------------------------
// d. AC 14 invariant
// ---------------------------------------------------------------------------

describe('people_phone_e164_key invariant (AC 14)', () => {
  // Any migration touching this index must re-run the R2 match tests
  // (tests/integration/rsvp-match.test.ts, rsvp-rpc.test.ts "member vs newcomer"):
  // submit_rsvp's silent member match relies on at most one people row per phone.
  it('is a full unique index (indisunique, no predicate) — any migration touching this index must re-run the R2 match tests', () => {
    expect(
      psql(
        `SELECT i.indisunique || ',' || (i.indpred IS NULL) FROM pg_index i ` +
          `WHERE i.indexrelid = 'public.people_phone_e164_key'::regclass`,
      ),
    ).toBe('true,true')
  })
})

// ---------------------------------------------------------------------------
// e. regression
// ---------------------------------------------------------------------------

describe('regression after the revokes', () => {
  it('anon: get_default_language returns a language code', async () => {
    const { data, error } = await anon.rpc('get_default_language')
    expect(error).toBeNull()
    expect(['id', 'en']).toContain(data)
  })

  it('anon: get_rsvp_context — open link returns the event, unknown token {"open":false}', async () => {
    const open = await anon.rpc('get_rsvp_context', { p_token: openToken })
    expect(open.error).toBeNull()
    expect((open.data as { open: boolean }).open).toBe(true)

    const unknown = await anon.rpc('get_rsvp_context', { p_token: `nope-${ts}` })
    expect(unknown.error).toBeNull()
    expect(unknown.data).toEqual({ open: false })
  })

  it('anon: submit_rsvp — right gate ok, wrong gate unavailable', async () => {
    const args = {
      p_token: openToken,
      p_phone_e164: `+62999${(ts % 1_000_000).toString().padStart(6, '0')}0002`,
      p_name: 'S9R6 Newcomer',
      p_children_count: 0,
      p_followup_consent: false,
      p_status: 'coming',
    }
    const ok = await anon.rpc('submit_rsvp', { p_gate: LOCAL_GATE, ...args })
    expect(ok.error).toBeNull()
    expect(ok.data).toEqual({ ok: true })

    const wrong = await anon.rpc('submit_rsvp', { p_gate: `${LOCAL_GATE}-wrong`, ...args })
    expect(wrong.error).toBeNull()
    expect(wrong.data).toEqual({ ok: false, code: 'unavailable' })
  })

  it('anon: a legacy-table read still returns an empty set, not 42501 (helpers keep anon EXECUTE)', async () => {
    const { data, error } = await anon.from('people').select('id').limit(1)
    expect(error).toBeNull()
    expect(data).toEqual([])
  })

  for (const [label, client] of [
    ['admin', () => adminSession],
    ['organizer', () => organizerSession],
  ] as const) {
    for (const view of S3_VIEWS) {
      it(`${label}: ${view} is readable`, async () => {
        const { error } = await client().from(view).select('*').limit(1)
        expect(error).toBeNull()
      })
    }

    it(`${label}: a people read returns rows (RLS helpers still execute)`, async () => {
      const { data, error } = await client().from('people').select('id').eq('id', personIds[0])
      expect(error).toBeNull()
      expect(data).toHaveLength(1)
    })
  }

  it('the last-admin trigger still blocks demoting the last active admin (rolled back)', () => {
    // As postgres: leave exactly one active admin (the seeded baseline). Then,
    // as that admin through the authenticated role, try to demote them — the
    // trigger must raise. The whole transaction rolls back either way.
    const res = spawnSync(
      'docker',
      ['exec', '-i', DB_CONTAINER, 'psql', '-U', 'postgres', '-At'],
      {
        encoding: 'utf8',
        input: [
          'BEGIN;',
          `UPDATE public.app_users SET active = true, role = 'admin' WHERE id = '${BASELINE_ADMIN_ID}';`,
          `UPDATE public.app_users SET active = false WHERE role = 'admin' AND active AND id <> '${BASELINE_ADMIN_ID}';`,
          'SET LOCAL ROLE authenticated;',
          `SELECT set_config('request.jwt.claims', '{"sub":"${BASELINE_ADMIN_ID}","role":"authenticated"}', true);`,
          `UPDATE public.app_users SET role = 'organizer' WHERE id = '${BASELINE_ADMIN_ID}';`,
          'ROLLBACK;',
        ].join('\n'),
      },
    )
    expect(res.status).toBe(0)
    expect(res.stderr).toContain('last_admin: cannot remove the last active admin')
    // The baseline admin is untouched after the rollback.
    expect(psql(`SELECT role FROM public.app_users WHERE id = '${BASELINE_ADMIN_ID}'`)).toBe('admin')
  })
})
