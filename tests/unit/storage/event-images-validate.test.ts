import { describe, it, expect } from 'vitest'
import { validateEventImage } from '@/lib/storage/event-images.impl'
import { EVENT_IMAGE_MAX_BYTES } from '@/lib/storage/event-images.types'

const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]
const PNG_HEAD  = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]
// 'RIFF' + 4-byte little-endian size + 'WEBP'
const WEBP_HEAD = [0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]

function blob(head: number[], type: string, padTo = 64): Blob {
  const bytes = new Uint8Array(Math.max(head.length, padTo))
  bytes.set(head)
  return new Blob([bytes], { type })
}

describe('validateEventImage', () => {
  it('accepts JPEG with matching magic bytes → ext jpg', async () => {
    expect(await validateEventImage(blob(JPEG_HEAD, 'image/jpeg')))
      .toEqual({ ok: true, mime: 'image/jpeg', ext: 'jpg' })
  })

  it('accepts PNG with matching magic bytes → ext png', async () => {
    expect(await validateEventImage(blob(PNG_HEAD, 'image/png')))
      .toEqual({ ok: true, mime: 'image/png', ext: 'png' })
  })

  it('accepts WebP with RIFF....WEBP header → ext webp', async () => {
    expect(await validateEventImage(blob(WEBP_HEAD, 'image/webp')))
      .toEqual({ ok: true, mime: 'image/webp', ext: 'webp' })
  })

  it('accepts a file of exactly 4 MB', async () => {
    expect((await validateEventImage(blob(PNG_HEAD, 'image/png', EVENT_IMAGE_MAX_BYTES))).ok).toBe(true)
  })

  it('rejects > 4 MB as too_large (checked before type)', async () => {
    expect(await validateEventImage(blob(PNG_HEAD, 'image/png', EVENT_IMAGE_MAX_BYTES + 1)))
      .toEqual({ ok: false, reason: 'too_large' })
  })

  it('rejects declared PNG whose bytes are JPEG → magic_mismatch', async () => {
    expect(await validateEventImage(blob(JPEG_HEAD, 'image/png')))
      .toEqual({ ok: false, reason: 'magic_mismatch' })
  })

  it('rejects declared JPEG whose bytes are HTML → magic_mismatch', async () => {
    const html = Array.from(new TextEncoder().encode('<html><script>alert(1)</script>'))
    expect(await validateEventImage(blob(html, 'image/jpeg')))
      .toEqual({ ok: false, reason: 'magic_mismatch' })
  })

  it('rejects RIFF container that is not WEBP (e.g. WAVE) → magic_mismatch', async () => {
    const wave = [0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]
    expect(await validateEventImage(blob(wave, 'image/webp')))
      .toEqual({ ok: false, reason: 'magic_mismatch' })
  })

  it('rejects a file shorter than the signature → magic_mismatch', async () => {
    expect(await validateEventImage(blob([0x89, 0x50], 'image/png', 2)))
      .toEqual({ ok: false, reason: 'magic_mismatch' })
  })

  it('rejects SVG → invalid_type', async () => {
    const svg = Array.from(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))
    expect(await validateEventImage(blob(svg, 'image/svg+xml')))
      .toEqual({ ok: false, reason: 'invalid_type' })
  })

  it('rejects HEIC → invalid_type', async () => {
    const heic = [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]
    expect(await validateEventImage(blob(heic, 'image/heic')))
      .toEqual({ ok: false, reason: 'invalid_type' })
  })

  it('rejects text/html even with PNG magic bytes → invalid_type', async () => {
    expect(await validateEventImage(blob(PNG_HEAD, 'text/html')))
      .toEqual({ ok: false, reason: 'invalid_type' })
  })

  it('rejects an empty declared type → invalid_type', async () => {
    expect(await validateEventImage(blob(PNG_HEAD, '')))
      .toEqual({ ok: false, reason: 'invalid_type' })
  })
})
