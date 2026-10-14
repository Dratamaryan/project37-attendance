import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  assertRequiredTables,
  buildManifest,
  countCopyRows,
  latestMigration,
} from '../manifest.mjs'

// ALL fixtures are invented. Never copy a row from a real dump into this suite.

const DATA_SQL = [
  'SET session_replication_role = replica;',
  '',
  'SET statement_timeout = 0;',
  '--',
  '-- Data for Name: users; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin',
  '--',
  '',
  'COPY "auth"."users" ("instance_id", "id", "email") FROM stdin;',
  '00000000-0000-0000-0000-000000000000\t11111111-1111-1111-1111-111111111111\tone@example.test',
  '00000000-0000-0000-0000-000000000000\t22222222-2222-2222-2222-222222222222\ttwo@example.test',
  '\\.',
  '',
  'COPY "public"."people" ("id", "full_name", "notes") FROM stdin;',
  'aaaa\tAlpha Test\tline one\\nline two',
  // A data row that looks like a COPY header must still count as a row.
  'COPY "public"."decoy" ("x") FROM stdin;\tBeta Test\t\\N',
  'cccc\tGamma Test\t\\N',
  '\\.',
  '',
  'COPY "public"."event_invitations" ("id") FROM stdin;',
  '\\.',
  '',
  'SELECT pg_catalog.setval(\'"public"."audit_log_id_seq"\', 3, true);',
  'RESET ALL;',
]

describe('countCopyRows', () => {
  it('counts rows per schema.table, including empty tables', async () => {
    expect(await countCopyRows(DATA_SQL)).toEqual({
      'auth.users': 2,
      'public.people': 3,
      'public.event_invitations': 0,
    })
  })

  it('accepts unquoted identifiers', async () => {
    const lines = ['COPY public.parishes (id, name) FROM stdin;', '1\tSt Test', '\\.']
    expect(await countCopyRows(lines)).toEqual({ 'public.parishes': 1 })
  })

  it('throws on an unterminated COPY block (truncated dump)', async () => {
    const lines = DATA_SQL.slice(0, 10)
    await expect(countCopyRows(lines)).rejects.toThrow('unterminated COPY block for auth.users')
  })

  it('throws on a duplicate COPY block', async () => {
    const lines = [...DATA_SQL, 'COPY "auth"."users" ("id") FROM stdin;', 'x', '\\.']
    await expect(countCopyRows(lines)).rejects.toThrow('duplicate COPY block for auth.users')
  })

  it('returns {} when there are no COPY blocks', async () => {
    expect(await countCopyRows(['SET x = 1;', 'RESET ALL;'])).toEqual({})
  })
})

describe('assertRequiredTables', () => {
  it('passes when public.people and auth.users have rows', () => {
    expect(() => assertRequiredTables({ 'public.people': 1, 'auth.users': 1 })).not.toThrow()
  })

  it('throws when a required table is missing', () => {
    expect(() => assertRequiredTables({ 'public.people': 5 })).toThrow('auth.users')
  })

  it('throws when a required table has 0 rows', () => {
    expect(() => assertRequiredTables({ 'public.people': 0, 'auth.users': 3 })).toThrow(
      'public.people',
    )
  })
})

describe('buildManifest', () => {
  let root: string
  let dumpDir: string
  let migDir: string

  const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 's8t8-manifest-'))
    dumpDir = path.join(root, 'dump')
    migDir = path.join(root, 'migrations')
    mkdirSync(dumpDir)
    mkdirSync(migDir)
    writeFileSync(path.join(dumpDir, 'roles.sql'), 'RESET ALL;\n')
    writeFileSync(path.join(dumpDir, 'schema.sql'), 'CREATE TABLE IF NOT EXISTS "public"."t" ();\n')
    writeFileSync(path.join(dumpDir, 'data.sql'), DATA_SQL.join('\n') + '\n')
    writeFileSync(path.join(migDir, '20260101000000_a.sql'), '')
    writeFileSync(path.join(migDir, '20261007120000_c.sql'), '')
    writeFileSync(path.join(migDir, '20260501000000_b.sql'), '')
    writeFileSync(path.join(migDir, 'zz-notes.md'), '')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('builds counts, sha256s, latest migration, git sha and timestamp', async () => {
    const m = await buildManifest({
      dir: dumpDir,
      migrationsDir: migDir,
      gitSha: 'deadbeef',
      now: new Date(Date.UTC(2026, 9, 18, 15, 0, 0)),
    })
    expect(m).toEqual({
      version: 1,
      createdAt: '2026-10-18T15:00:00.000Z',
      gitSha: 'deadbeef',
      latestMigration: '20261007120000_c.sql',
      required: ['public.people', 'auth.users'],
      files: {
        'roles.sql': { bytes: 11, sha256: sha256('RESET ALL;\n') },
        'schema.sql': {
          bytes: 44,
          sha256: sha256('CREATE TABLE IF NOT EXISTS "public"."t" ();\n'),
        },
        'data.sql': {
          bytes: Buffer.byteLength(DATA_SQL.join('\n') + '\n'),
          sha256: sha256(DATA_SQL.join('\n') + '\n'),
        },
      },
      tables: { 'auth.users': 2, 'public.people': 3, 'public.event_invitations': 0 },
    })
  })

  it('throws when a dump file is empty', async () => {
    writeFileSync(path.join(dumpDir, 'roles.sql'), '')
    await expect(
      buildManifest({ dir: dumpDir, migrationsDir: migDir, gitSha: 'x' }),
    ).rejects.toThrow('roles.sql is empty')
  })

  it('throws when gitSha is missing', async () => {
    await expect(
      buildManifest({ dir: dumpDir, migrationsDir: migDir, gitSha: '' }),
    ).rejects.toThrow('gitSha is required')
  })
})

describe('latestMigration', () => {
  it('throws when the directory has no .sql files', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 's8t8-mig-'))
    try {
      expect(() => latestMigration(dir)).toThrow('no migrations')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
