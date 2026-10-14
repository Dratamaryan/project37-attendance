// Types for manifest.mjs (plain ESM, run on bare `node` in db-backup.yml).
// Keep in sync with the exports there.

export interface ManifestFile {
  bytes: number
  sha256: string
}

export interface BackupManifest {
  version: 1
  createdAt: string
  gitSha: string
  latestMigration: string
  required: string[]
  files: Record<string, ManifestFile>
  tables: Record<string, number>
}

export declare const DUMP_FILES: string[]
export declare const REQUIRED_NONEMPTY: string[]

export declare function countCopyRows(
  lines: Iterable<string> | AsyncIterable<string>,
): Promise<Record<string, number>>

export declare function assertRequiredTables(tables: Record<string, number>): void

export declare function latestMigration(dir: string): string

export declare function sha256File(file: string): Promise<string>

export declare function buildManifest(opts: {
  dir: string
  migrationsDir: string
  gitSha: string
  now?: Date
}): Promise<BackupManifest>
