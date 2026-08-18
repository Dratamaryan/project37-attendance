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
  branches: { main: PROD_REF, 'release/*': PROD_REF },
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
