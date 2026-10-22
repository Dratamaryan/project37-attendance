/**
 * S9-R0 — Staging smoke for the RSVP schema + anon RPCs (verification ladder
 * rung 2). Synthetic data only: [SYNTH] names, +62999 phones.
 *
 * Proves against the live staging project (20261020120000_sprint9_r0_rsvp.sql
 * pushed, vault secret 'rsvp_gate' created out-of-band):
 *   a. anon has no table access to event_rsvp_links / event_rsvps (42501)
 *   b. get_rsvp_context: valid token → open:true with exactly 7 keys;
 *      bogus token → exactly {"open":false}
 *   c. submit_rsvp gate: no gate / wrong gate / wrong gate + bogus token →
 *      unavailable; right gate + bogus token → closed
 *   d. member vs newcomer: byte-identical {"ok":true}; member row person_id +
 *      NULL name; newcomer row name + NULL person_id; no people row created
 *   e. newcomer resubmit (maybe, no name) → still one row, name kept
 * then deletes everything it created and asserts zero residue.
 *
 * Run (tsc->node, compiled path — libphonenumber-js must not run under tsx):
 *   npx tsc -p scripts/tsconfig.s9-r0-smoke.json
 *   node --env-file=.env.staging.local scripts/.build/scripts/s9-r0-staging-smoke.js
 *
 * GUARDS (all must pass before any write):
 *   1. Shared preflight guard (branch <-> ref map).
 *   2. Staging pin: resolved ref must be exactly STAGING_REF — no local, no prod.
 *   3. Env URL ref must equal STAGING_REF (no split-brain).
 *   4. Synthetic phones normalise to exactly themselves, start with +62999,
 *      and are absent from people before any write.
 *
 * SECRETS: RSVP_GATE_SECRET is read from env and only ever sent as the
 * p_gate RPC argument — never printed, logged or interpolated into output.
 * Tokens are printed truncated to 6 chars.
 *
 * AUDIT (CLAUDE.md rule 6): the synthetic person's create writes
 * people.create; the cleanup hard-delete writes data.wipe. Both via log_audit
 * with actorUserId = null (service_role/system path). audit_log rows are
 * append-only and intentionally excluded from the residue check.
 *
 * submit_rsvp itself never touches people / attendance / audit_log.
 */

import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { normalizePhone } from '../lib/utils/phone'
import { AUDIT_ACTIONS, logAudit, type AuditAction } from '../lib/audit'

const STAGING_REF = 'sijfyvaodqkawbeuyrpu'
const SOURCE = 's9-r0-staging-smoke'
const RUN_ID = Date.now()
const EVENT_NAME = `[SYNTH] S9-R0 RSVP Smoke ${RUN_ID}`
const NEWCOMER_NAME = '[SYNTH] S9-R0 Pendatang Uji'
const MEMBER_NAME = '[SYNTH] S9-R0 Anggota Uji'
const CONTEXT_KEYS = ['duration_min', 'event_name', 'event_name_id', 'image_url', 'location', 'open', 'scheduled_at']

// ---------------------------------------------------------------------------
// Preflight guard — same preamble as scripts/s8-t5-seed-staging-synthetic.ts
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
    console.error('==================== PREFLIGHT ABORT (s9-r0-staging-smoke) ====================')
    console.error(`  branch:        ${branch || '(empty/detached)'}`)
    console.error(`  op:            ${op}`)
    console.error(`  resolved ref:  ${resolved.ref ?? '(none)'} (local=${resolved.local})`)
    console.error(`  reason:        ${result.reason}`)
    console.error('=================================================================================')
    console.error('')
    process.exit(1)
  }
  console.log(`[preflight] OK -- branch=${branch} op=${op} ref=${resolved.ref} local=${resolved.local}`)
  return resolved
}

function abort(reason: string): never {
  console.error(`[s9-r0-smoke] ABORT: ${reason}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Assertion table
// ---------------------------------------------------------------------------

type Result = { id: string; label: string; pass: boolean; detail: string }
const results: Result[] = []

function check(id: string, label: string, pass: boolean, detail: string): void {
  results.push({ id, label, pass, detail })
}

function printTable(): void {
  const idW = Math.max(2, ...results.map((r) => r.id.length))
  const labelW = Math.max(9, ...results.map((r) => r.label.length))
  console.log('')
  console.log(`${'ID'.padEnd(idW)}  ${'ASSERTION'.padEnd(labelW)}  RESULT  DETAIL`)
  console.log(`${'-'.repeat(idW)}  ${'-'.repeat(labelW)}  ------  ------`)
  for (const r of results) {
    console.log(`${r.id.padEnd(idW)}  ${r.label.padEnd(labelW)}  ${(r.pass ? 'PASS' : 'FAIL').padEnd(6)}  ${r.detail}`)
  }
  const failed = results.filter((r) => !r.pass).length
  console.log('')
  console.log(`[s9-r0-smoke] ${results.length - failed}/${results.length} PASS${failed ? `, ${failed} FAIL` : ''}`)
}

const short = (token: string) => `${token.slice(0, 6)}…`

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

async function countWhere(
  supabase: SupabaseClient,
  table: string,
  column: string,
  values: string[],
): Promise<number> {
  const { count, error } = await supabase.from(table).select('id', { count: 'exact', head: true }).in(column, values)
  if (error || count === null) throw new Error(`count ${table} failed: ${error?.message ?? 'null count'}`)
  return count
}

type SubmitArgs = {
  p_gate: string | null
  p_token: string
  p_phone_e164: string
  p_name: string | null
  p_children_count: number
  p_followup_consent: boolean
  p_status: string
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const resolved = await runPreflightGuard('staging-rsvp-smoke')
  if (resolved.local || resolved.ref !== STAGING_REF) {
    abort(`resolved ref ${resolved.ref ?? '(none)'} (local=${resolved.local}) is not staging (${STAGING_REF}) — refusing`)
  }
  console.log(`[staging-pin] OK -- ref=${resolved.ref}`)

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const gate = process.env.RSVP_GATE_SECRET
  if (!url || !serviceKey || !anonKey || !gate) {
    abort('missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY / RSVP_GATE_SECRET — pass --env-file explicitly')
  }
  const envRef = new URL(url).hostname.split('.')[0]
  if (envRef !== STAGING_REF) abort(`env URL ref ${envRef} is not ${STAGING_REF}`)

  // Fresh synthetic phones, same 12-digit +62999 shape as the S8-T5 seed.
  const suffix = (RUN_ID % 10_000_000).toString().padStart(7, '0')
  const memberPhone = `+62999${suffix}`
  const newcomerPhone = `+62999${((RUN_ID + 1) % 10_000_000).toString().padStart(7, '0')}`
  for (const p of [memberPhone, newcomerPhone]) {
    const n = normalizePhone(p, 'ID')
    if (!n.ok || n.e164 !== p || !p.startsWith('+62999')) abort('synthetic phone failed normalisation or is outside +62999')
  }

  const service = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })

  if ((await countWhere(service, 'people', 'phone_e164', [memberPhone, newcomerPhone])) > 0) {
    abort('a synthetic phone is already present in people — refusing')
  }
  const adminId = await activeAppUserId(service, 'admin@example.com')

  const wrongGate = `wrong-${randomUUID()}`
  const bogusToken = `bogus-${randomUUID()}`

  let eventId: string | null = null
  let instanceId: string | null = null
  let memberId: string | null = null

  try {
    // ── setup (service role) ──────────────────────────────────────────────
    const scheduledAt = new Date(Date.now() + 5 * 86_400_000)
    scheduledAt.setUTCHours(11, 0, 0, 0) // 18:00 WIB
    eventId = await insertOne(service, 'events', {
      name: EVENT_NAME,
      name_id: EVENT_NAME,
      event_type: 'adhoc',
      start_date: scheduledAt.toISOString().slice(0, 10),
      start_time: '18:00',
      duration_min: 120,
      location: '[SYNTH] Aula Uji',
      recurrence_rule: null,
      created_by: adminId,
    })
    await audit(service, AUDIT_ACTIONS.EVENT_CREATE, 'event', eventId)

    instanceId = await insertOne(service, 'event_instances', {
      event_id: eventId,
      scheduled_at: scheduledAt.toISOString(),
      event_name_snapshot: EVENT_NAME,
      event_name_snapshot_id: EVENT_NAME,
      status: 'scheduled',
    })

    const { data: link, error: linkErr } = await service
      .from('event_rsvp_links')
      .insert({ event_instance_id: instanceId, created_by: adminId })
      .select('id, token')
      .single()
    if (linkErr || !link) throw new Error(`insert link failed: ${linkErr?.message ?? 'no row'}`)
    const token = (link as { token: string }).token

    memberId = await insertOne(service, 'people', {
      full_name: MEMBER_NAME,
      nickname: 'Anggota',
      phone_e164: memberPhone,
    })
    await audit(service, AUDIT_ACTIONS.PEOPLE_CREATE, 'person', memberId)

    console.log(`[setup] event + scheduled instance (+5d), link token=${short(token)}, 1 [SYNTH] member`)

    // ── a. anon table access ──────────────────────────────────────────────
    for (const table of ['event_rsvp_links', 'event_rsvps']) {
      const sel = await anon.from(table).select('id').limit(1)
      const ins = await anon.from(table).insert({ event_instance_id: instanceId })
      const upd = await anon.from(table).update({ created_at: new Date().toISOString() }).eq('id', randomUUID())
      const del = await anon.from(table).delete().eq('id', randomUUID())
      const codes = [sel, ins, upd, del].map((r) => r.error?.code ?? 'none')
      check(
        'a',
        `anon S/I/U/D on ${table} → 42501`,
        codes.every((c) => c === '42501'),
        `codes=${codes.join(',')}`,
      )
    }

    // ── b. get_rsvp_context ───────────────────────────────────────────────
    {
      const { data, error } = await anon.rpc('get_rsvp_context', { p_token: token })
      const ctx = (data ?? {}) as Record<string, unknown>
      const keys = Object.keys(ctx).sort()
      check(
        'b1',
        `context(valid ${short(token)}) → open:true, 7 keys`,
        !error && ctx.open === true && JSON.stringify(keys) === JSON.stringify(CONTEXT_KEYS),
        error ? `error=${error.code}` : `keys=${keys.join(',')}`,
      )
    }
    {
      const { data, error } = await anon.rpc('get_rsvp_context', { p_token: bogusToken })
      const body = JSON.stringify(data)
      check('b2', 'context(bogus) → exactly {"open":false}', !error && body === '{"open":false}', error ? `error=${error.code}` : body)
    }

    // ── c. gate ───────────────────────────────────────────────────────────
    const baseArgs = (overrides: Partial<SubmitArgs>): SubmitArgs => ({
      p_gate: gate,
      p_token: token,
      p_phone_e164: newcomerPhone,
      p_name: NEWCOMER_NAME,
      p_children_count: 0,
      p_followup_consent: false,
      p_status: 'coming',
      ...overrides,
    })
    const rpcSubmit = async (args: SubmitArgs): Promise<string> => {
      const { data, error } = await anon.rpc('submit_rsvp', args)
      return error ? `error=${error.code}` : JSON.stringify(data)
    }
    const unavailable = '{"ok":false,"code":"unavailable"}'
    const closed = '{"ok":false,"code":"closed"}'

    const noGate = await rpcSubmit(baseArgs({ p_gate: null }))
    check('c1', 'submit no gate → unavailable', noGate === unavailable, noGate)
    const wrong = await rpcSubmit(baseArgs({ p_gate: wrongGate }))
    check('c2', 'submit wrong gate → unavailable', wrong === unavailable, wrong)
    const wrongBogus = await rpcSubmit(baseArgs({ p_gate: wrongGate, p_token: bogusToken }))
    check('c3', 'submit wrong gate + bogus token → unavailable', wrongBogus === unavailable, wrongBogus)
    const rightBogus = await rpcSubmit(baseArgs({ p_token: bogusToken }))
    check('c4', 'submit right gate + bogus token → closed', rightBogus === closed, rightBogus)

    const { count: afterGate, error: agErr } = await service
      .from('event_rsvps')
      .select('id', { count: 'exact', head: true })
      .eq('event_instance_id', instanceId)
    check('c5', 'no rsvp rows written by c1–c4', !agErr && afterGate === 0, agErr ? `error=${agErr.code}` : `rows=${afterGate}`)

    // ── d. member vs newcomer (raw bodies) ────────────────────────────────
    const rawSubmit = async (args: SubmitArgs): Promise<{ status: number; body: string }> => {
      const res = await fetch(`${url}/rest/v1/rpc/submit_rsvp`, {
        method: 'POST',
        headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      })
      return { status: res.status, body: await res.text() }
    }
    const newcomerRes = await rawSubmit(baseArgs({ p_phone_e164: newcomerPhone, p_name: NEWCOMER_NAME, p_children_count: 1 }))
    const memberRes = await rawSubmit(baseArgs({ p_phone_e164: memberPhone, p_name: MEMBER_NAME }))
    check(
      'd1',
      'member/newcomer raw bodies byte-identical {"ok":true}',
      newcomerRes.status === 200 &&
        memberRes.status === 200 &&
        newcomerRes.body === memberRes.body &&
        JSON.stringify(JSON.parse(memberRes.body)) === '{"ok":true}',
      `status=${newcomerRes.status}/${memberRes.status} bodies=${newcomerRes.body}|${memberRes.body}`,
    )

    const readRows = async () => {
      const { data, error } = await service
        .from('event_rsvps')
        .select('phone_e164, name, person_id, status')
        .eq('event_instance_id', instanceId as string)
      if (error) throw new Error(`read rsvps failed: ${error.message}`)
      return data as { phone_e164: string; name: string | null; person_id: string | null; status: string }[]
    }
    const rows = await readRows()
    const memberRow = rows.find((r) => r.phone_e164 === memberPhone)
    const newcomerRow = rows.find((r) => r.phone_e164 === newcomerPhone)
    check(
      'd2',
      'member row: person_id set, name NULL',
      !!memberRow && memberRow.person_id === memberId && memberRow.name === null,
      memberRow ? `person_id=${memberRow.person_id === memberId ? 'member' : String(memberRow.person_id)} name=${memberRow.name === null ? 'NULL' : 'set'}` : 'missing',
    )
    check(
      'd3',
      'newcomer row: name set, person_id NULL',
      !!newcomerRow && newcomerRow.name === NEWCOMER_NAME && newcomerRow.person_id === null,
      newcomerRow ? `name=${newcomerRow.name === NEWCOMER_NAME ? '[SYNTH] ok' : String(newcomerRow.name)} person_id=${newcomerRow.person_id ?? 'NULL'}` : 'missing',
    )
    const newcomerPeople = await countWhere(service, 'people', 'phone_e164', [newcomerPhone])
    check('d4', 'no people row for newcomer phone', newcomerPeople === 0, `people=${newcomerPeople}`)

    // ── e. newcomer resubmit ──────────────────────────────────────────────
    const resub = await rpcSubmit(baseArgs({ p_phone_e164: newcomerPhone, p_name: null, p_status: 'maybe' }))
    const afterResub = (await readRows()).filter((r) => r.phone_e164 === newcomerPhone)
    check(
      'e1',
      'newcomer resubmit (maybe, no name) → 1 row, name kept',
      resub === '{"ok":true}' &&
        afterResub.length === 1 &&
        afterResub[0].status === 'maybe' &&
        afterResub[0].name === NEWCOMER_NAME,
      `resp=${resub} rows=${afterResub.length} status=${afterResub[0]?.status} name=${afterResub[0]?.name === NEWCOMER_NAME ? 'kept' : 'changed'}`,
    )
  } finally {
    // ── cleanup + residue ─────────────────────────────────────────────────
    console.log('[cleanup] deleting synthetic event (cascades instance/link/rsvps) and person')
    if (eventId) {
      const { error } = await service.from('events').delete().eq('id', eventId)
      if (error) console.error(`[cleanup] event delete failed: ${error.message}`)
    }
    if (memberId) {
      const { error } = await service.from('people').delete().eq('id', memberId)
      if (error) console.error(`[cleanup] person delete failed: ${error.message}`)
      else await audit(service, AUDIT_ACTIONS.DATA_WIPE, 'person', memberId)
    }

    const residue: Record<string, number> = {
      events: eventId ? await countWhere(service, 'events', 'id', [eventId]) : 0,
      event_instances: eventId ? await countWhere(service, 'event_instances', 'event_id', [eventId]) : 0,
      event_rsvp_links: instanceId ? await countWhere(service, 'event_rsvp_links', 'event_instance_id', [instanceId]) : 0,
      event_rsvps: instanceId ? await countWhere(service, 'event_rsvps', 'event_instance_id', [instanceId]) : 0,
      people: await countWhere(service, 'people', 'phone_e164', [memberPhone, newcomerPhone]),
    }
    const total = Object.values(residue).reduce((a, b) => a + b, 0)
    check(
      'z',
      'zero residue after cleanup',
      total === 0,
      Object.entries(residue).map(([k, v]) => `${k}=${v}`).join(' '),
    )
    printTable()
  }

  if (results.some((r) => !r.pass)) process.exit(1)
}

main().catch((err) => {
  console.error('[s9-r0-smoke] FATAL:', err instanceof Error ? err.message : err)
  printTable()
  process.exit(1)
})
