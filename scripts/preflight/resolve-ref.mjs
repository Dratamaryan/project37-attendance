// S7-T0 — pure ref resolution for the branch/project-ref preflight guard.
// Plain Node ESM only: no app imports, no tsx, no libphonenumber-js. Must run
// on bare `node` before any app code (including phone/env helpers) loads.

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const TEMP_REF_PATH = path.resolve(process.cwd(), 'supabase/.temp/project-ref')

// CLI ops write to the DB via the `supabase` CLI, which targets whatever
// project is linked on disk — so .temp/project-ref is authoritative for them.
// Everything else is treated as a Node-write op (supabase-js / fetch against
// the Management API), which targets whatever NEXT_PUBLIC_SUPABASE_URL (and
// SUPABASE_DB_URL, if set) resolve to in the current process env.
const CLI_OPS = new Set(['db-push', 'migrate-up'])

function refFromHostname(hostname) {
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return { ref: hostname, local: true }
  }
  return { ref: hostname.split('.')[0], local: false }
}

// NOTE: this hostname.split('.')[0] parse is exact per spec, and it is exact
// for NEXT_PUBLIC_SUPABASE_URL (https://<ref>.supabase.co). It is NOT exact
// for every SUPABASE_DB_URL shape: a direct-connection DB URL
// (postgresql://postgres:***@db.<ref>.supabase.co:5432/postgres) parses to
// "db", and a pooler URL (postgresql://postgres.<ref>:***@aws-0-<region>
// .pooler.supabase.com:6543/postgres) carries the ref in the username, not
// the hostname, so this parse yields "aws-0-<region>" instead. Flagged to the
// user rather than silently special-cased — see the S7-T0 report.
function parseRefFromUrlString(raw) {
  if (!raw) return null
  try {
    const u = new URL(raw)
    return refFromHostname(u.hostname)
  } catch {
    return null
  }
}

function readTempRefFile() {
  if (!existsSync(TEMP_REF_PATH)) return null
  const raw = readFileSync(TEMP_REF_PATH, 'utf8').trim()
  if (!raw) return null
  return refFromHostname(raw)
}

/**
 * @param {{ op?: string }} args
 * @returns {{ ref: string|null, local: boolean, sources: Record<string,string|null>, disagree: boolean }}
 */
export function resolveRef({ op }) {
  const sources = {}

  const tempRef = readTempRefFile()
  sources['supabase/.temp/project-ref'] = tempRef ? tempRef.ref : null

  const envUrlRef = parseRefFromUrlString(process.env.NEXT_PUBLIC_SUPABASE_URL)
  sources['NEXT_PUBLIC_SUPABASE_URL'] = envUrlRef ? envUrlRef.ref : null

  if (process.env.SUPABASE_DB_URL) {
    const dbUrlRef = parseRefFromUrlString(process.env.SUPABASE_DB_URL)
    sources['SUPABASE_DB_URL'] = dbUrlRef ? dbUrlRef.ref : null
  }

  const authoritative = CLI_OPS.has(op) ? tempRef : envUrlRef

  const nonLocalRefs = new Set()
  for (const value of Object.values(sources)) {
    if (value && value !== 'localhost' && value !== '127.0.0.1') nonLocalRefs.add(value)
  }

  return {
    ref: authoritative ? authoritative.ref : null,
    local: authoritative ? authoritative.local : false,
    sources,
    disagree: nonLocalRefs.size > 1,
  }
}
