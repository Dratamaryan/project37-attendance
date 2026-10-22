/**
 * S9-R0 — Prod live verify for the RSVP schema + anon RPCs (verification
 * ladder rung 3). READ-ONLY / NO-WRITE: anon key only, no service-role
 * client, no fixtures, no cleanup needed.
 *
 *   p1  anon SELECT on event_rsvp_links → 42501
 *   p2  anon SELECT on event_rsvps → 42501
 *   p3  get_rsvp_context('bogus-<uuid>') → exactly {"open":false}
 *   p4  get_rsvp_context(NULL) → exactly {"open":false}
 *   p5  submit_rsvp no gate + bogus token → unavailable
 *   p6  submit_rsvp wrong gate + bogus token → unavailable
 *
 * p5/p6 cannot write: submit_rsvp checks the vault gate before any token
 * lookup, so a missing/wrong gate returns before touching a table. The prod
 * gate secret is not used here and is never read from env.
 *
 * Run (tsc->node):
 *   npx tsc -p scripts/tsconfig.s9-r0-prod-verify.json
 *   node --env-file=.env.prod.local scripts/.build/scripts/s9-r0-prod-verify.js
 *
 * GUARDS (all must pass before any request):
 *   1. Shared preflight guard (branch <-> ref map), op=prod-rsvp-verify.
 *   2. Prod pin: branch main, resolved ref exactly PROD_REF, local=false.
 *   3. Env URL ref must equal PROD_REF (no split-brain).
 * SUPABASE_SERVICE_ROLE_KEY is removed from process.env at startup so no
 * code path in this process can pick it up.
 */

import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

delete process.env.SUPABASE_SERVICE_ROLE_KEY

const PROD_REF = 'bftifxgdcmisasgvobuf'
const PROD_BRANCH = 'main'

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

async function runPreflightGuard(op: string): Promise<{ branch: string; resolved: ResolvedRef }> {
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
    console.error('==================== PREFLIGHT ABORT (s9-r0-prod-verify) ====================')
    console.error(`  branch:        ${branch || '(empty/detached)'}`)
    console.error(`  op:            ${op}`)
    console.error(`  resolved ref:  ${resolved.ref ?? '(none)'} (local=${resolved.local})`)
    console.error(`  reason:        ${result.reason}`)
    console.error('==============================================================================')
    console.error('')
    process.exit(1)
  }
  console.log(`[preflight] OK -- branch=${branch} op=${op} ref=${resolved.ref} local=${resolved.local}`)
  return { branch, resolved }
}

function abort(reason: string): never {
  console.error(`[s9-r0-prod-verify] ABORT: ${reason}`)
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
  console.log(`[s9-r0-prod-verify] ${results.length - failed}/${results.length} PASS${failed ? `, ${failed} FAIL` : ''}`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { branch, resolved } = await runPreflightGuard('prod-rsvp-verify')
  if (branch !== PROD_BRANCH || resolved.local || resolved.ref !== PROD_REF) {
    abort(
      `branch=${branch} ref=${resolved.ref ?? '(none)'} local=${resolved.local} — ` +
        `requires branch ${PROD_BRANCH}, ref ${PROD_REF}, local=false`,
    )
  }
  console.log(`[prod-pin] OK -- branch=${branch} ref=${resolved.ref}`)

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) {
    abort('missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY — pass --env-file explicitly')
  }
  const envRef = new URL(url).hostname.split('.')[0]
  if (envRef !== PROD_REF) abort(`env URL ref ${envRef} is not ${PROD_REF}`)

  const anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })

  const bogusToken = `bogus-${randomUUID()}`
  const wrongGate = `wrong-${randomUUID()}`
  const phone = `+62999${(Date.now() % 10_000_000).toString().padStart(7, '0')}`
  const unavailable = '{"ok":false,"code":"unavailable"}'

  // p1/p2 — anon SELECT denied
  for (const [id, table] of [['p1', 'event_rsvp_links'], ['p2', 'event_rsvps']] as const) {
    const { error } = await anon.from(table).select('id').limit(1)
    check(id, `anon SELECT ${table} → 42501`, error?.code === '42501', `code=${error?.code ?? 'none'}`)
  }

  // p3/p4 — get_rsvp_context closed shape
  {
    const { data, error } = await anon.rpc('get_rsvp_context', { p_token: bogusToken })
    const body = error ? `error=${error.code}` : JSON.stringify(data)
    check('p3', 'get_rsvp_context(bogus) → {"open":false}', body === '{"open":false}', body)
  }
  {
    const { data, error } = await anon.rpc('get_rsvp_context', { p_token: null })
    const body = error ? `error=${error.code}` : JSON.stringify(data)
    check('p4', 'get_rsvp_context(NULL) → {"open":false}', body === '{"open":false}', body)
  }

  // p5/p6 — gate rejects before any lookup
  const submit = async (gate: string | null): Promise<string> => {
    const { data, error } = await anon.rpc('submit_rsvp', {
      p_gate: gate,
      p_token: bogusToken,
      p_phone_e164: phone,
      p_name: '[SYNTH] prod verify',
      p_children_count: 0,
      p_followup_consent: false,
      p_status: 'coming',
    })
    return error ? `error=${error.code}` : JSON.stringify(data)
  }
  const noGate = await submit(null)
  check('p5', 'submit_rsvp no gate + bogus token → unavailable', noGate === unavailable, noGate)
  const wrong = await submit(wrongGate)
  check('p6', 'submit_rsvp wrong gate + bogus token → unavailable', wrong === unavailable, wrong)

  printTable()
  if (results.some((r) => !r.pass)) process.exit(1)
}

main().catch((err) => {
  console.error('[s9-r0-prod-verify] FATAL:', err instanceof Error ? err.message : err)
  printTable()
  process.exit(1)
})
