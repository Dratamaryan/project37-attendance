// S7-T0 — selftest for the preflight guard's evaluate(). Pure fixtures only:
// no real supabase/.temp/project-ref or env reads, no git calls. Run with
// `npm run preflight:selftest` (plain `node`, no tsx).

import { evaluate } from './guard.mjs'

const PROD_REF = 'bftifxgdcmisasgvobuf'
const STAGING_REF = 'sijfyvaodqkawbeuyrpu'

const map = {
  version: 1,
  prodRef: PROD_REF,
  denyByDefault: true,
  branches: { main: PROD_REF, 'release/*': PROD_REF, staging: STAGING_REF },
}

function resolved(ref, overrides = {}) {
  return { ref, local: false, sources: {}, disagree: false, ...overrides }
}

const cases = [
  {
    name: 'branch=main, op=migrate-up, resolved=prod => ok',
    input: { branch: 'main', op: 'migrate-up', resolved: resolved(PROD_REF), map },
    check: (r) => r.ok === true,
  },
  {
    name: 'branch=main, resolved=staging => abort (resolved-ref-mismatch)',
    input: { branch: 'main', op: 'migrate-up', resolved: resolved(STAGING_REF), map },
    check: (r) => r.ok === false && r.reason === 'resolved-ref-mismatch',
  },
  {
    name: 'branch=feature/x, resolved=prod => abort (branch-unmatched-deny-by-default)',
    input: { branch: 'feature/x', op: 'migrate-up', resolved: resolved(PROD_REF), map },
    check: (r) => r.ok === false && r.reason === 'branch-unmatched-deny-by-default',
  },
  {
    name: 'branch=HEAD (detached), resolved=prod => abort (detached-or-empty-branch)',
    input: { branch: 'HEAD', op: 'migrate-up', resolved: resolved(PROD_REF), map },
    check: (r) => r.ok === false && r.reason === 'detached-or-empty-branch',
  },
  {
    name: 'map=null => abort (map-missing-or-unparseable)',
    input: { branch: 'main', op: 'migrate-up', resolved: resolved(PROD_REF), map: null },
    check: (r) => r.ok === false && r.reason === 'map-missing-or-unparseable',
  },
  {
    name: 'branch=main, resolved matches expected but disagree=true => abort (ref-source-disagreement)',
    input: { branch: 'main', op: 'migrate-up', resolved: resolved(PROD_REF, { disagree: true }), map },
    check: (r) => r.ok === false && r.reason === 'ref-source-disagreement',
  },
  {
    name: 'branch=main, resolved.ref=null => abort (remote-write-op-no-resolvable-ref)',
    input: { branch: 'main', op: 'migrate-up', resolved: { ref: null, local: false, sources: {}, disagree: false }, map },
    check: (r) => r.ok === false && r.reason === 'remote-write-op-no-resolvable-ref',
  },
  {
    name: 'branch=feature/x, op=roster-apply, resolved=local(127.0.0.1) => ok (local bypasses branch-deny)',
    input: { branch: 'feature/x', op: 'roster-apply', resolved: resolved('127.0.0.1', { local: true }), map },
    check: (r) => r.ok === true,
  },
  {
    name: 'branch=staging, op=db-push, resolved=staging => ok',
    input: { branch: 'staging', op: 'db-push', resolved: resolved(STAGING_REF), map },
    check: (r) => r.ok === true,
  },
  {
    name: 'branch=staging, resolved=prod => abort (resolved-ref-mismatch)',
    input: { branch: 'staging', op: 'db-push', resolved: resolved(PROD_REF), map },
    check: (r) => r.ok === false && r.reason === 'resolved-ref-mismatch',
  },
]

let failures = 0
for (const c of cases) {
  const result = evaluate(c.input)
  const pass = c.check(result)
  console.log(`${pass ? 'PASS' : 'FAIL'} — ${c.name} -> ${JSON.stringify(result)}`)
  if (!pass) failures++
}

console.log('')
if (failures > 0) {
  console.error(`${failures} of ${cases.length} preflight selftest case(s) FAILED`)
  process.exit(1)
}
console.log(`All ${cases.length} preflight selftest case(s) passed.`)
process.exit(0)