// S7-T0 — branch/project-ref preflight guard. Plain Node ESM, runs on bare
// `node` ahead of any remote-write DB operation (CLI push/migrate, or a
// Node script that writes via supabase-js / the Management API).
//
// evaluate() is pure and side-effect-free (no fs/env/git access) so it can be
// exercised with injected fixtures in selftest.mjs. main() does all the I/O
// and is only invoked when this file is run directly, not when imported.

import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { resolveRef } from './resolve-ref.mjs'

const MAP_PATH = path.resolve(process.cwd(), 'supabase/preflight.branch-ref.json')

/** Exact key match first, then trailing-'*' prefix match (e.g. 'release/*'). */
export function matchBranchRef(branches, branch) {
  if (Object.prototype.hasOwnProperty.call(branches, branch)) return branches[branch]
  for (const [pattern, ref] of Object.entries(branches)) {
    if (pattern.endsWith('*') && branch.startsWith(pattern.slice(0, -1))) return ref
  }
  return undefined
}

/**
 * @param {{ branch: string, op: string|undefined, resolved: { ref: string|null, disagree: boolean }|null, map: unknown }} args
 * @returns {{ ok: boolean, reason: string|null }}
 */
export function evaluate({ branch, op, resolved, map }) {
  void op // op only affects how `resolved` was computed upstream; not re-checked here.

  if (!branch || branch.trim() === '' || branch === 'HEAD') {
    return { ok: false, reason: 'detached-or-empty-branch' }
  }

  if (!map || typeof map !== 'object' || !map.branches || typeof map.branches !== 'object') {
    return { ok: false, reason: 'map-missing-or-unparseable' }
  }

  const expectedRef = matchBranchRef(map.branches, branch)
  if (expectedRef === undefined) {
    if (map.denyByDefault) {
      return { ok: false, reason: 'branch-unmatched-deny-by-default' }
    }
    return { ok: true, reason: null }
  }

  if (!resolved || !resolved.ref) {
    return { ok: false, reason: 'remote-write-op-no-resolvable-ref' }
  }

  if (resolved.disagree) {
    return { ok: false, reason: 'ref-source-disagreement' }
  }

  if (resolved.ref !== expectedRef) {
    return { ok: false, reason: 'resolved-ref-mismatch' }
  }

  return { ok: true, reason: null }
}

function getBranch() {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function loadMap() {
  try {
    if (!existsSync(MAP_PATH)) return null
    return JSON.parse(readFileSync(MAP_PATH, 'utf8'))
  } catch {
    return null
  }
}

function parseOp(argv) {
  const arg = argv.find((a) => a.startsWith('--op='))
  return arg ? arg.slice('--op='.length) : undefined
}

function main() {
  const op = parseOp(process.argv.slice(2))
  const branch = getBranch()
  const map = loadMap()
  const resolved = resolveRef({ op })
  const result = evaluate({ branch, op, resolved, map })

  const expected = map && map.branches ? (matchBranchRef(map.branches, branch) ?? '(no match)') : '(map unavailable)'

  if (!result.ok) {
    console.error('')
    console.error('==================== PREFLIGHT ABORT ====================')
    console.error(`  branch:        ${branch || '(empty/detached)'}`)
    console.error(`  op:            ${op ?? '(none)'}`)
    console.error(`  resolved ref:  ${resolved && resolved.ref ? resolved.ref : '(none)'}`)
    console.error(`  expected ref:  ${expected}`)
    console.error(`  reason:        ${result.reason}`)
    console.error('===========================================================')
    console.error('')
    process.exit(1)
  }

  console.log(`\x1b[32m[preflight] OK — branch=${branch} op=${op ?? '(none)'} ref=${resolved.ref}\x1b[0m`)
  process.exit(0)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
