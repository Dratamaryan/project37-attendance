/**
 * S9-P0 — Prod live verify for the event-images public bucket (verification
 * ladder rung 3). Copy of scripts/s9-p0-staging-smoke.ts with the PROD pin.
 * ANON KEY ONLY: SUPABASE_SERVICE_ROLE_KEY is deleted from process.env at
 * startup and no service client is ever constructed.
 *
 * Input: the public URL of the poster the owner uploaded through the prod UI
 * (argv[2]). Must start with
 *   https://<PROD_REF>.supabase.co/storage/v1/object/public/event-images/instances/
 *
 * Proves against the live prod project:
 *   s1  GET url (no auth) → 200, content-type image/(png|jpeg|webp),
 *       cache-control contains max-age=31536000
 *   s2  anon upload of a 1×1 PNG to a fresh instances/<uuid>/<uuid>.png →
 *       error (RLS); a second anon GET of that would-be public URL → 4xx
 *   s3  anon list('instances') → empty or error (bucket not enumerable)
 *   s4  anon upload of text/html → error
 *
 * Writes nothing — every write attempt here must be refused. No audit rows
 * (nothing is mutated). The real poster object is only read, never touched.
 *
 * Run (tsc->node, compiled path — house style for scripts/ that hit a real
 * Supabase project):
 *   npx tsc -p scripts/tsconfig.s9-p0-prod-verify.json
 *   node --env-file=.env.prod.local scripts/.build/scripts/s9-p0-prod-verify.js <public-url>
 *
 * GUARDS (all must pass before any request):
 *   1. Shared preflight guard (branch <-> ref map).
 *   2. Prod pin: branch must be main, resolved ref exactly PROD_REF, local=false.
 *   3. Env URL ref must equal PROD_REF (no split-brain).
 *   4. argv[2] must start with the prod event-images public prefix.
 *
 * SECRETS: the anon key is only passed to createClient — never printed.
 */

import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

// Anon only — drop the service key before anything else can read it.
delete process.env.SUPABASE_SERVICE_ROLE_KEY

const PROD_REF = 'bftifxgdcmisasgvobuf'
const BUCKET = 'event-images'
const PUBLIC_PREFIX = `https://${PROD_REF}.supabase.co/storage/v1/object/public/${BUCKET}/instances/`

// Real 1×1 PNG.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

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
    console.error('==================== PREFLIGHT ABORT (s9-p0-prod-verify) ======================')
    console.error(`  branch:        ${branch || '(empty/detached)'}`)
    console.error(`  op:            ${op}`)
    console.error(`  resolved ref:  ${resolved.ref ?? '(none)'} (local=${resolved.local})`)
    console.error(`  reason:        ${result.reason}`)
    console.error('=================================================================================')
    console.error('')
    process.exit(1)
  }
  console.log(`[preflight] OK -- branch=${branch} op=${op} ref=${resolved.ref} local=${resolved.local}`)
  return { branch, resolved }
}

function abort(reason: string): never {
  console.error(`[s9-p0-prod-verify] ABORT: ${reason}`)
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
  console.log(`[s9-p0-prod-verify] ${results.length - failed}/${results.length} PASS${failed ? `, ${failed} FAIL` : ''}`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { branch, resolved } = await runPreflightGuard('prod-anon-verify')

  if (branch !== 'main' || resolved.local || resolved.ref !== PROD_REF) {
    abort(`prod pin: branch=${branch} ref=${resolved.ref ?? '(none)'} local=${resolved.local}; expected main / ${PROD_REF} / local=false`)
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) {
    abort('missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY — pass --env-file explicitly')
  }
  if (new URL(url).hostname !== `${PROD_REF}.supabase.co`) {
    abort('NEXT_PUBLIC_SUPABASE_URL is not the prod project')
  }
  console.log(`[prod-pin] OK -- branch=main ref=${PROD_REF}; service key removed from env: ${process.env.SUPABASE_SERVICE_ROLE_KEY === undefined}`)

  const imageUrl = process.argv[2]
  if (!imageUrl) abort('usage: … s9-p0-prod-verify.js <public-image-url>')
  if (!imageUrl.startsWith(PUBLIC_PREFIX)) abort(`image URL must start with ${PUBLIC_PREFIX}`)
  console.log(`[input] OK -- …/instances/${imageUrl.slice(PUBLIC_PREFIX.length)}`)

  const anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })

  // s1 — public GET of the uploaded image
  {
    const res = await fetch(imageUrl)
    const type = res.headers.get('content-type') ?? ''
    const cache = res.headers.get('cache-control') ?? ''
    await res.arrayBuffer()
    check('s1a', 'public GET status 200', res.status === 200, `status=${res.status}`)
    check('s1b', 'content-type image/(png|jpeg|webp)', /^image\/(png|jpeg|webp)$/.test(type), `content-type=${type}`)
    check('s1c', 'cache-control max-age=31536000', cache.includes('max-age=31536000'), `cache-control=${cache}`)
  }

  // s2 — anon upload refused; the would-be object does not exist
  {
    const objectPath = `instances/${randomUUID()}/${randomUUID()}.png`
    const { error } = await anon.storage
      .from(BUCKET)
      .upload(objectPath, new Blob([PNG_BYTES], { type: 'image/png' }), { contentType: 'image/png' })
    check('s2a', 'anon PNG upload refused', error !== null, error ? `error=${error.message}` : 'upload SUCCEEDED')

    const wouldBe = anon.storage.from(BUCKET).getPublicUrl(objectPath).data.publicUrl
    const res = await fetch(wouldBe)
    await res.arrayBuffer()
    check('s2b', 'would-be public URL 4xx', res.status >= 400 && res.status < 500, `status=${res.status}`)
  }

  // s3 — bucket not enumerable by anon
  {
    const { data, error } = await anon.storage.from(BUCKET).list('instances')
    const names = (data ?? []).map((o) => o.name)
    check(
      's3',
      'anon list(instances) empty or error',
      error !== null || names.length === 0,
      error ? `error=${error.message}` : `entries=${names.length}`,
    )
  }

  // s4 — anon text/html upload refused
  {
    const { error } = await anon.storage
      .from(BUCKET)
      .upload(`instances/${randomUUID()}/${randomUUID()}.html`, new Blob(['<html></html>'], { type: 'text/html' }), {
        contentType: 'text/html',
      })
    check('s4', 'anon text/html upload refused', error !== null, error ? `error=${error.message}` : 'upload SUCCEEDED')
  }

  printTable()
  const failed = results.some((r) => !r.pass)
  console.log(`EXIT ${failed ? 1 : 0}`)
  if (failed) process.exit(1)
}

main().catch((err) => {
  console.error('[s9-p0-prod-verify] FATAL:', err instanceof Error ? err.message : err)
  process.exit(1)
})
