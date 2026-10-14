// S8-T8 — manifest for the scheduled prod backup (.github/workflows/db-backup.yml).
// Plain Node ESM only: no app imports, no tsx, no dependencies. Runs on the
// runner's bare `node`. Never prints dump contents — counts and hashes only.
//
// Usage: node scripts/backup/manifest.mjs --dir <dump dir> [--migrations-dir supabase/migrations]
// Writes <dump dir>/manifest.json.

import { createReadStream, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

export const DUMP_FILES = ['roles.sql', 'schema.sql', 'data.sql']

// A data dump missing either of these (or with 0 rows in them) is a failed backup,
// not a valid empty one.
export const REQUIRED_NONEMPTY = ['public.people', 'auth.users']

const IDENT = '("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)'
const COPY_RE = new RegExp(`^COPY ${IDENT}\\.${IDENT}(?: \\(.*\\))? FROM stdin;$`)

function unquote(ident) {
  return ident.startsWith('"') ? ident.slice(1, -1).replace(/""/g, '"') : ident
}

/**
 * Counts data rows per table in pg_dump COPY text. COPY escapes embedded
 * newlines, so one line inside a block is one row.
 * @param {Iterable<string> | AsyncIterable<string>} lines
 * @returns {Promise<Record<string, number>>}
 */
export async function countCopyRows(lines) {
  /** @type {Record<string, number>} */
  const counts = {}
  /** @type {string | null} */
  let current = null
  let rows = 0
  for await (const line of lines) {
    if (current === null) {
      const m = COPY_RE.exec(line)
      if (!m) continue
      current = `${unquote(m[1])}.${unquote(m[2])}`
      if (current in counts) throw new Error(`duplicate COPY block for ${current}`)
      rows = 0
    } else if (line === '\\.') {
      counts[current] = rows
      current = null
    } else {
      rows++
    }
  }
  if (current !== null) throw new Error(`unterminated COPY block for ${current}`)
  return counts
}

/** @param {Record<string, number>} tables */
export function assertRequiredTables(tables) {
  for (const t of REQUIRED_NONEMPTY) {
    if (!tables[t]) throw new Error(`required table ${t} is missing or empty in data.sql`)
  }
}

/** @param {string} dir */
export function latestMigration(dir) {
  const names = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  if (names.length === 0) throw new Error(`no migrations in ${dir}`)
  return names[names.length - 1]
}

/** @param {string} file */
export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * @param {{ dir: string, migrationsDir: string, gitSha: string, now?: Date }} opts
 */
export async function buildManifest({ dir, migrationsDir, gitSha, now = new Date() }) {
  if (!gitSha) throw new Error('gitSha is required')
  /** @type {Record<string, { bytes: number, sha256: string }>} */
  const files = {}
  for (const f of DUMP_FILES) {
    const p = path.join(dir, f)
    const { size } = statSync(p)
    if (size === 0) throw new Error(`${f} is empty`)
    files[f] = { bytes: size, sha256: await sha256File(p) }
  }
  const tables = await countCopyRows(
    createInterface({ input: createReadStream(path.join(dir, 'data.sql')), crlfDelay: Infinity }),
  )
  assertRequiredTables(tables)
  return {
    version: 1,
    createdAt: now.toISOString(),
    gitSha,
    latestMigration: latestMigration(migrationsDir),
    required: REQUIRED_NONEMPTY,
    files,
    tables,
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      dir: { type: 'string' },
      'migrations-dir': { type: 'string', default: 'supabase/migrations' },
    },
  })
  if (!values.dir) throw new Error('--dir is required')
  const manifest = await buildManifest({
    dir: values.dir,
    migrationsDir: values['migrations-dir'],
    gitSha: process.env.GITHUB_SHA ?? '',
  })
  writeFileSync(path.join(values.dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {
    mode: 0o600,
  })
  console.log(`manifest: ${Object.keys(manifest.tables).length} tables, migration ${manifest.latestMigration}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`manifest: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
