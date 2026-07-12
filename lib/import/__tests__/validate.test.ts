import { describe, it, expect } from 'vitest'
import { validateUpload, MAX_FILE_BYTES } from '../validate'

describe('validateUpload', () => {
  it('valid .xlsx under 5MiB -> ok', () => {
    expect(validateUpload({ name: 'roster.xlsx', size: 1024 })).toEqual({ ok: true })
  })

  it('valid .csv under 5MiB -> ok', () => {
    expect(validateUpload({ name: 'roster.csv', size: 1024 })).toEqual({ ok: true })
  })

  it('exactly 5MiB -> ok (inclusive boundary)', () => {
    expect(validateUpload({ name: 'roster.xlsx', size: MAX_FILE_BYTES })).toEqual({ ok: true })
  })

  it('5MiB + 1 byte -> rejected, names actual vs max bytes', () => {
    const result = validateUpload({ name: 'roster.xlsx', size: MAX_FILE_BYTES + 1 })
    expect(result).toEqual({
      ok: false,
      error: 'file_too_large',
      maxBytes: MAX_FILE_BYTES,
      actualBytes: MAX_FILE_BYTES + 1,
    })
  })

  it('disallowed extension .txt -> rejected, names the extension', () => {
    const result = validateUpload({ name: 'roster.txt', size: 100 })
    expect(result).toEqual({ ok: false, error: 'unsupported_extension', extension: 'txt' })
  })

  it('disallowed extension .pdf -> rejected', () => {
    const result = validateUpload({ name: 'roster.pdf', size: 100 })
    expect(result).toEqual({ ok: false, error: 'unsupported_extension', extension: 'pdf' })
  })

  it('no extension -> rejected, extension null', () => {
    const result = validateUpload({ name: 'roster', size: 100 })
    expect(result).toEqual({ ok: false, error: 'unsupported_extension', extension: null })
  })

  it('oversized AND wrong extension -> size check wins (checked first)', () => {
    const result = validateUpload({ name: 'roster.txt', size: MAX_FILE_BYTES + 1 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('file_too_large')
  })
})
