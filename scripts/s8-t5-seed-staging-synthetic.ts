/**
 * S8-T5 — Synthetic staging seed for the attendee list / per-instance export.
 *
 * Adds ONLY synthetic data to the staging Supabase project so the S8-T5 page
 * (/checkin/[instanceId]/attendees) and export can be smoke-tested on the
 * staging deploy with first-timer YES and NO, search, children and the
 * sanitiser all exercised:
 *   - 1 event   "[SYNTH] S8-T5 Ibadah Uji" (adhoc)
 *   - 2 past instances: PREV (2026-10-02 18:00 WIB) and TARGET (2026-10-15 18:00 WIB)
 *   - 5 adults, all "[SYNTH] …" names, +62999009500x phones (normalised via
 *     normalizePhone — CLAUDE.md rule 7):
 *       A, B   first attendance at TARGET          → first-timer YES
 *       C, D   attended PREV, then TARGET          → first-timer NO
 *       E      first-timer, nickname is a formula payload → proves sheet-safe
 *   - 2 children (of A and C), both checked in at TARGET
 * Check-ins are attributed to the EXISTING staging identities from S8-T7
 * (organizer@example.com; one row to admin@example.com so the export's
 * "Checked in by" column shows two different checkers). This script never
 * creates or modifies app_users / auth.users.
 *
 * Run (tsc->node, compiled path — libphonenumber-js must not run under tsx):
 *   npx tsc -p scripts/tsconfig.s8-t5-seed.json
 *   node --env-file=.env.staging.local scripts/.build/scripts/s8-t5-seed-staging-synthetic.js
 * A local rehearsal first is supported: the guard accepts a local target.
 *
 * GUARDS (all must pass before any write):
 *   1. Shared preflight guard (branch <-> ref map).
 *   2. Staging pin: resolved ref must be STAGING_REF or local — never prod.
 *   3. Identities: organizer@example.com and admin@example.com must exist and
 *      be active in app_users, else abort (run the S8-T7 seed first).
 *   4. Idempotency: aborts if the marker event already exists, or if any of
 *      the synthetic phones is already present — never partially re-seeds.
 *   5. Every phone must normalise to exactly itself and start with +62999.
 *
 * AUDIT: every people / children / attendance / child_attendance insert
 * writes an audit_log row (CLAUDE.md rule 6) via log_audit with
 * actorUserId = null — the service_role/system path log_audit honours when
 * there is no auth.uid() (see tests/integration/log-audit-privilege.test.ts).
 * details_json carries { source, synthetic: true } only.
 *
 * OUTPUT: counts plus the TARGET instance id and its attendee page path.
 * Never prints a phone, email or name beyond the fixed synthetic strings.
 */

import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { normalizePhone } from '../lib/utils/phone'
import { AUDIT_ACTIONS, logAudit, type AuditAction } from '../lib/audit'

const STAGING_REF = 'sijfyvaodqkawbeuyrpu'
const SOURCE = 's8-t5-staging-seed'
const EVENT_NAME = '[SYNTH] S8-T5 Ibadah Uji'

// ---------------------------------------------------------------------------
// Preflight guard — same preamble as scripts/s8-t7-seed-staging-identities.ts
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
    console.error('==================== PREFLIGHT ABORT (s8-t5-seed-staging-synthetic) ====================')
    console.error(`  branch:        ${branch || '(empty/detached)'}`)
    console.error(`  op:            ${op}`)
    console.error(`  resolved ref:  ${resolved.ref ?? '(none)'} (local=${resolved.local})`)
    console.error(`  reason:        ${result.reason}`)
    console.error('==========================================================================================')
    console.error('')
    process.exit(1)
  }
  console.log(`[preflight] OK -- branch=${branch} op=${op} ref=${resolved.ref} local=${resolved.local}`)
  return resolved
}

function abort(reason: string): never {
  console.error(`[s8-t5-seed] ABORT: ${reason}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Synthetic fixture
// ---------------------------------------------------------------------------

type AdultKey = 'A' | 'B' | 'C' | 'D' | 'E'

const ADULTS: Array<{ key: AdultKey; fullName: string; nickname: string; phone: string }> = [
  { key: 'A', fullName: '[SYNTH] Andreas Uji', nickname: 'Andre', phone: '+629990095001' },
  { key: 'B', fullName: '[SYNTH] Bernadeta Uji', nickname: 'Detta', phone: '+629990095002' },
  { key: 'C', fullName: '[SYNTH] Clemens Uji', nickname: 'Clem', phone: '+629990095003' },
  { key: 'D', fullName: '[SYNTH] Dorothea Uji', nickname: 'Thea', phone: '+629990095004' },
  { key: 'E', fullName: '[SYNTH] Elisabet Uji', nickname: '=SUM(1,1)', phone: '+629990095005' },
]

const CHILDREN: Array<{ fullName: string; parent: AdultKey }> = [
  { fullName: '[SYNTH] Fransiskus Uji', parent: 'A' },
  { fullName: '[SYNTH] Gabriela Uji', parent: 'C' },
]

const PREV_AT = '2026-10-02T11:00:00Z'   // 18:00 WIB
const TARGET_AT = '2026-10-15T11:00:00Z' // 18:00 WIB

async function audit(
  supabase: SupabaseClient,
  action: AuditAction,
  entityType: string,
  entityId: string,
): Promise<void> {
  await logAudit(
    { actorUserId: null, action, entityType, entityId, detailsJson: { source: SOURCE, synthetic: true } },
    supabase,
  )
}

async function insertOne(supabase: SupabaseClient, table: string, row: Record<string, unknown>): Promise<string> {
  const { data, error } = await supabase.from(table).insert(row).select('id').single()
  if (error || !data) throw new Error(`insert ${table} failed: ${error?.message ?? 'no row'}`)
  return (data as { id: string }).id
}

async function activeAppUserId(supabase: SupabaseClient, email: string): Promise<string> {
  const { data, error } = await supabase.from('app_users').select('id, active').eq('email', email).maybeSingle()
  if (error) throw new Error(`app_users lookup failed: ${error.message}`)
  if (!data || (data as { active: boolean }).active !== true) {
    abort(`${email} missing or inactive in app_users — run scripts/s8-t7-seed-staging-identities.ts first`)
  }
  return (data as { id: string }).id
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const resolved = await runPreflightGuard('staging-synthetic-seed')
  if (resolved.ref !== STAGING_REF && !resolved.local) {
    abort(`resolved ref ${resolved.ref ?? '(none)'} is not staging (${STAGING_REF}) or local — refusing`)
  }
  console.log(`[staging-pin] OK -- ref=${resolved.ref ?? '(local)'}`)

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    abort('missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — pass --env-file explicitly')
  }
  // The env must point at the same project the guard resolved (no split-brain).
  const envRef = new URL(url).hostname.split('.')[0]
  if (!resolved.local && envRef !== STAGING_REF) abort(`env URL ref ${envRef} is not ${STAGING_REF}`)

  // Phones: normalise + synthetic-range check before touching the DB.
  for (const a of ADULTS) {
    const n = normalizePhone(a.phone, 'ID')
    if (!n.ok || n.e164 !== a.phone || !a.phone.startsWith('+62999')) {
      abort(`synthetic phone for ${a.key} failed normalisation or is outside +62999`)
    }
  }

  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })

  const organizerId = await activeAppUserId(supabase, 'organizer@example.com')
  const adminId = await activeAppUserId(supabase, 'admin@example.com')

  const { data: existingEvent, error: evErr } = await supabase.from('events').select('id').eq('name', EVENT_NAME).maybeSingle()
  if (evErr) throw new Error(`events lookup failed: ${evErr.message}`)
  if (existingEvent) abort('marker event already exists — staging is already seeded; nothing written')

  const { count: phoneHits, error: phErr } = await supabase
    .from('people')
    .select('id', { count: 'exact', head: true })
    .in('phone_e164', ADULTS.map(a => a.phone))
  if (phErr) throw new Error(`people phone check failed: ${phErr.message}`)
  if ((phoneHits ?? 0) > 0) abort(`${phoneHits} synthetic phone(s) already present — refusing to partially re-seed`)

  // ── writes ──────────────────────────────────────────────────────────────
  const eventId = await insertOne(supabase, 'events', {
    name: EVENT_NAME,
    name_id: EVENT_NAME,
    event_type: 'adhoc',
    start_date: '2026-10-02',
    start_time: '18:00',
    recurrence_rule: null,
    created_by: adminId,
  })
  await audit(supabase, AUDIT_ACTIONS.EVENT_CREATE, 'event', eventId)

  const instance = (scheduledAt: string) => ({
    event_id: eventId,
    scheduled_at: scheduledAt,
    event_name_snapshot: EVENT_NAME,
    event_name_snapshot_id: EVENT_NAME,
    status: 'completed',
  })
  const prevId = await insertOne(supabase, 'event_instances', instance(PREV_AT))
  const targetId = await insertOne(supabase, 'event_instances', instance(TARGET_AT))

  const personId: Partial<Record<AdultKey, string>> = {}
  for (const a of ADULTS) {
    const id = await insertOne(supabase, 'people', { full_name: a.fullName, nickname: a.nickname, phone_e164: a.phone })
    personId[a.key] = id
    await audit(supabase, AUDIT_ACTIONS.PEOPLE_CREATE, 'person', id)
  }
  const pid = (k: AdultKey): string => personId[k] ?? abort(`missing person ${k}`)

  const checkIn = async (k: AdultKey, instanceId: string, at: string, by: string) => {
    const id = await insertOne(supabase, 'attendance', {
      person_id: pid(k), event_instance_id: instanceId, checked_in_at: at, checked_in_by: by, source: 'volunteer_checkin',
    })
    await audit(supabase, AUDIT_ACTIONS.ATTENDANCE_CREATE, 'attendance', id)
  }
  await checkIn('C', prevId, '2026-10-02T11:04:00Z', organizerId)
  await checkIn('D', prevId, '2026-10-02T11:09:00Z', organizerId)
  await checkIn('A', targetId, '2026-10-15T10:52:00Z', organizerId)
  await checkIn('B', targetId, '2026-10-15T10:55:00Z', organizerId)
  await checkIn('C', targetId, '2026-10-15T10:58:00Z', adminId)
  await checkIn('D', targetId, '2026-10-15T11:03:00Z', organizerId)
  await checkIn('E', targetId, '2026-10-15T11:07:00Z', organizerId)

  let childCount = 0
  for (const [i, c] of CHILDREN.entries()) {
    const childId = await insertOne(supabase, 'children', { parent_person_id: pid(c.parent), full_name: c.fullName })
    await audit(supabase, AUDIT_ACTIONS.CHILD_CREATE, 'child', childId)
    const caId = await insertOne(supabase, 'child_attendance', {
      child_id: childId,
      event_instance_id: targetId,
      checked_in_at: `2026-10-15T10:5${3 + i}:00Z`,
      checked_in_by: organizerId,
      source: 'volunteer_checkin',
    })
    await audit(supabase, AUDIT_ACTIONS.CHILD_ATTENDANCE_CREATE, 'child_attendance', caId)
    childCount++
  }

  console.log('')
  console.log('[s8-t5-seed] Summary:')
  console.log(`  - events: 1, instances: 2, people: ${ADULTS.length}, attendance: 7, children: ${childCount}, child_attendance: ${childCount}`)
  console.log(`  - target instance: ${targetId}`)
  console.log(`  - attendee page:   /checkin/${targetId}/attendees`)
}

main().catch((err) => {
  console.error('[s8-t5-seed] FATAL:', err instanceof Error ? err.message : err)
  process.exit(1)
})
