// Pure upload validation — no supabase, no SheetJS. Checked before any parse
// so an oversized/wrong-type file never reaches XLSX.read().

export const MAX_FILE_BYTES = 5 * 1024 * 1024 // 5 MiB (matches lib/storage/photos.impl.ts convention)

const ALLOWED_EXTS = new Set(['csv', 'xlsx'])

export type ValidateUploadResult =
  | { ok: true }
  | { ok: false; error: 'file_too_large'; maxBytes: number; actualBytes: number }
  | { ok: false; error: 'unsupported_extension'; extension: string | null }

function extensionOf(filename: string): string | null {
  const dot = filename.lastIndexOf('.')
  if (dot < 0 || dot === filename.length - 1) return null
  return filename.slice(dot + 1).toLowerCase()
}

export function validateUpload(file: { name: string; size: number }): ValidateUploadResult {
  if (file.size > MAX_FILE_BYTES) {
    return { ok: false, error: 'file_too_large', maxBytes: MAX_FILE_BYTES, actualBytes: file.size }
  }

  const ext = extensionOf(file.name)
  if (!ext || !ALLOWED_EXTS.has(ext)) {
    return { ok: false, error: 'unsupported_extension', extension: ext }
  }

  return { ok: true }
}
