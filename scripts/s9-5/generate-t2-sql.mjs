// S9.5-T2 — renders the owner SQL for each environment from ONE template per
// direction + scripts/s9-5/t2-snapshots.json. The generated files differ from
// each other only inside the HEADER SNAPSHOT block.
//
// Plain Node ESM, no dependencies, no TypeScript (house rule: never tsx).
//   node scripts/s9-5/generate-t2-sql.mjs          write the 4 env files
//   node scripts/s9-5/generate-t2-sql.mjs --check  exit 1 if any file is stale

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const BEGIN_MARK = '-- >>> HEADER SNAPSHOT'
const END_MARK = '-- <<< HEADER SNAPSHOT'

export const TEMPLATES = {
  forward: path.join(DIR, 't2-retire-friday-series.template.sql'),
  rollback: path.join(DIR, 't2-retire-friday-series.ROLLBACK.template.sql'),
}

export function outputPath(direction, env) {
  return path.join(DIR, direction === 'forward'
    ? `t2-retire-friday-series.${env}.sql`
    : `t2-retire-friday-series.ROLLBACK.${env}.sql`)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const COUNT_KEYS = ['links', 'rsvps', 'invitations', 'attendance', 'child_attendance']

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/** Fails loudly on any snapshot that the SQL would misread. */
export function validateSnapshot(env, snap) {
  const fail = (msg) => { throw new Error(`[${env}] snapshot invalid: ${msg}`) }
  if (!/^[a-z]+$/.test(env)) fail('env must be lowercase letters')
  const e = snap?.event
  if (!e || !UUID_RE.test(e.id)) fail('event.id')
  for (const k of ['name', 'event_type', 'recurrence_rule']) if (typeof e[k] !== 'string' || !e[k]) fail(`event.${k}`)
  if (e.active !== true) fail('event.active must be true (pre-apply state)')
  if (!Array.isArray(snap.instances) || snap.instances.length === 0) fail('instances')
  if (!Array.isArray(snap.expected_dates) || snap.expected_dates.length !== snap.instances.length) {
    fail('expected_dates length must equal instances length')
  }
  for (const d of snap.expected_dates) if (!DATE_RE.test(d)) fail(`expected_dates ${d}`)
  const ids = new Set()
  for (const i of snap.instances) {
    if (!UUID_RE.test(i.id)) fail(`instance id ${i.id}`)
    if (ids.has(i.id)) fail(`duplicate instance id ${i.id}`)
    ids.add(i.id)
    if (i.wib_date !== null && !DATE_RE.test(i.wib_date)) fail(`wib_date ${i.wib_date}`)
    for (const k of COUNT_KEYS) if (!Number.isInteger(i[k]) || i[k] < 0) fail(`${i.id}.${k}`)
  }
}

function headerBlock(env, snap) {
  const pad = (s, n) => String(s).padEnd(n)
  const lines = [
    BEGIN_MARK,
    `-- env: ${env}`,
    `-- expected event: ${snap.event.id}  name=${JSON.stringify(snap.event.name)}  ` +
      `type=${snap.event.event_type}  rrule=${snap.event.recurrence_rule}  active=true`,
    `-- expected scheduled instances on/after 2026-11-01 WIB: ${snap.instances.length}`,
    `-- ${pad('instance_id', 36)}  ${pad('wib_date', 10)}  links rsvps invit atten child`,
    ...snap.instances.map((i) =>
      `-- ${i.id}  ${pad(i.wib_date ?? '(set)', 10)}  ${COUNT_KEYS.map((k) => pad(i[k], 5)).join(' ').trimEnd()}`),
    `-- expected WIB date set: ${snap.expected_dates.join(' ')}`,
    `SET LOCAL s95.env = ${sqlLiteral(env)};`,
    `SET LOCAL s95.event = ${sqlLiteral(JSON.stringify(snap.event))};`,
    `SET LOCAL s95.expected_dates = ${sqlLiteral(JSON.stringify(snap.expected_dates))};`,
    `SET LOCAL s95.instances = ${sqlLiteral(JSON.stringify(snap.instances))};`,
    END_MARK,
  ]
  return lines.join('\n')
}

/** Replaces the template's HEADER SNAPSHOT block with the env's snapshot. */
export function renderSql(template, env, snap) {
  validateSnapshot(env, snap)
  const start = template.indexOf(BEGIN_MARK)
  const end = template.indexOf(END_MARK)
  if (start < 0 || end < start || template.indexOf(BEGIN_MARK, start + 1) >= 0) {
    throw new Error('template must contain exactly one HEADER SNAPSHOT block')
  }
  return template.slice(0, start) + headerBlock(env, snap) + template.slice(end + END_MARK.length)
}

function main() {
  const check = process.argv.includes('--check')
  const snapshots = JSON.parse(readFileSync(path.join(DIR, 't2-snapshots.json'), 'utf8'))
  let stale = 0
  for (const direction of ['forward', 'rollback']) {
    const template = readFileSync(TEMPLATES[direction], 'utf8')
    for (const env of ['staging', 'prod']) {
      const out = outputPath(direction, env)
      const sql = renderSql(template, env, snapshots[env])
      if (check) {
        const current = existsSync(out) ? readFileSync(out, 'utf8') : null
        if (current !== sql) { stale++; console.error(`STALE ${path.relative(process.cwd(), out)}`) }
      } else {
        writeFileSync(out, sql)
        console.log(`wrote ${path.relative(process.cwd(), out)}`)
      }
    }
  }
  if (check) {
    if (stale) process.exit(1)
    console.log('all generated files up to date')
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
