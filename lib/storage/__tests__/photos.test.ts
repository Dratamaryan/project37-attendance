import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  impl_uploadPhoto,
  impl_getPhotoSignedUrl,
  impl_deletePhoto,
} from '../photos.impl'
import { AUDIT_ACTIONS } from '../../audit'

// ────────────────────────────────────────────────────────────────────────────
// Mock factory
//
// Storage operations use a different client shape than DB queries.
// The storage bucket mock is returned by supabase.storage.from(bucketName).
// All three impl functions also call supabase.rpc('log_audit', ...) for writes,
// so we mock that too.
// ────────────────────────────────────────────────────────────────────────────

const ACTOR_ID    = 'actor-uuid-1234'
const PERSON_ID   = 'person-uuid-5678'
const TEST_PATH   = `${PERSON_ID}/deadbeef-cafe-1234-5678-abcdef012345.jpg`
const SIGNED_URL  = 'https://storage.example.com/signed/photo.jpg?token=abc'

type BucketMock = {
  upload:          ReturnType<typeof vi.fn>
  createSignedUrl: ReturnType<typeof vi.fn>
  remove:          ReturnType<typeof vi.fn>
}

type MockSupabase = SupabaseClient & {
  _bucket: BucketMock
  rpc:     ReturnType<typeof vi.fn>
}

interface MockOptions {
  userId?:           string | null
  uploadResponse?:   { data: unknown; error: unknown }
  signedResponse?:   { data: unknown; error: unknown }
  removeResponse?:   { data: unknown; error: unknown }
  rpcResponse?:      { data: unknown; error: unknown }
}

function makeMockSupabase({
  userId           = ACTOR_ID,
  uploadResponse   = { data: { path: TEST_PATH }, error: null },
  signedResponse   = { data: { signedUrl: SIGNED_URL }, error: null },
  removeResponse   = { data: [{ name: TEST_PATH }],  error: null },
  rpcResponse      = { data: null, error: null },
}: MockOptions = {}): MockSupabase {
  const bucket: BucketMock = {
    upload:          vi.fn().mockResolvedValue(uploadResponse),
    createSignedUrl: vi.fn().mockResolvedValue(signedResponse),
    remove:          vi.fn().mockResolvedValue(removeResponse),
  }

  const mock = {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: userId ? { id: userId } : null },
        error: null,
      }),
    },
    storage: {
      from: vi.fn().mockReturnValue(bucket),
    },
    rpc: vi.fn().mockResolvedValue(rpcResponse),
    _bucket: bucket,
  }

  return mock as unknown as MockSupabase
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function jpeg1KB() {
  return new Blob([new Uint8Array(1024)], { type: 'image/jpeg' })
}

// Use a plain object cast for size-only checks — avoids allocating 5 MB in tests.
function oversizedJpeg(): Blob {
  return { size: 5 * 1024 * 1024 + 1, type: 'image/jpeg' } as unknown as Blob
}

// ────────────────────────────────────────────────────────────────────────────
// impl_uploadPhoto — 8 cases
// ────────────────────────────────────────────────────────────────────────────

describe('impl_uploadPhoto', () => {
  it('1 — happy path: 1 KB jpeg → uploaded, path matches {personId}/{uuid}.jpg', async () => {
    const supabase = makeMockSupabase()
    const result = await impl_uploadPhoto(
      { personId: PERSON_ID, file: jpeg1KB(), consent: true },
      supabase,
    )
    expect(result.status).toBe('uploaded')
    if (result.status !== 'uploaded') return
    expect(result.path).toMatch(new RegExp(`^${PERSON_ID}/[0-9a-f-]{36}\\.jpg$`))
    expect(supabase._bucket.upload).toHaveBeenCalledOnce()
  })

  it('2 — logAudit called with PHOTO_UPLOAD; details include path and consent_at_upload', async () => {
    const supabase = makeMockSupabase()
    const result = await impl_uploadPhoto(
      { personId: PERSON_ID, file: jpeg1KB(), consent: false },
      supabase,
    )
    expect(result.status).toBe('uploaded')
    expect(supabase.rpc).toHaveBeenCalledWith('log_audit', expect.objectContaining({
      p_action:    AUDIT_ACTIONS.PHOTO_UPLOAD,
      p_entity_id: PERSON_ID,
    }))
    const details = (supabase.rpc as ReturnType<typeof vi.fn>).mock.calls[0][1].p_details_json
    expect(details).toHaveProperty('path')
    expect(details).toHaveProperty('consent_at_upload', false)
    expect(details).toHaveProperty('mime_type', 'image/jpeg')
  })

  it('3 — file > 5 MB → too_large; storage.upload NOT called', async () => {
    const supabase = makeMockSupabase()
    const result = await impl_uploadPhoto(
      { personId: PERSON_ID, file: oversizedJpeg(), consent: true },
      supabase,
    )
    expect(result.status).toBe('too_large')
    expect(supabase._bucket.upload).not.toHaveBeenCalled()
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('4 — mime type text/plain → invalid_type; storage.upload NOT called', async () => {
    const supabase = makeMockSupabase()
    const textBlob = new Blob(['hello'], { type: 'text/plain' })
    const result = await impl_uploadPhoto(
      { personId: PERSON_ID, file: textBlob, consent: true },
      supabase,
    )
    expect(result.status).toBe('invalid_type')
    expect(supabase._bucket.upload).not.toHaveBeenCalled()
  })

  it('5 — mime type image/svg+xml → invalid_extension; storage.upload NOT called', async () => {
    const supabase = makeMockSupabase()
    const svgBlob = new Blob(['<svg/>'], { type: 'image/svg+xml' })
    const result = await impl_uploadPhoto(
      { personId: PERSON_ID, file: svgBlob, consent: true },
      supabase,
    )
    expect(result.status).toBe('invalid_extension')
    expect(supabase._bucket.upload).not.toHaveBeenCalled()
  })

  it('6 — consent=true written to storage metadata as string "true"', async () => {
    const supabase = makeMockSupabase()
    await impl_uploadPhoto({ personId: PERSON_ID, file: jpeg1KB(), consent: true }, supabase)
    const [, , opts] = (supabase._bucket.upload as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(opts.metadata).toMatchObject({ consent: 'true' })
  })

  it('7 — consent=false written to storage metadata as string "false"', async () => {
    const supabase = makeMockSupabase()
    await impl_uploadPhoto({ personId: PERSON_ID, file: jpeg1KB(), consent: false }, supabase)
    const [, , opts] = (supabase._bucket.upload as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(opts.metadata).toMatchObject({ consent: 'false' })
  })

  it('8 — unauthenticated session → not_authenticated; no storage call', async () => {
    const supabase = makeMockSupabase({ userId: null })
    const result = await impl_uploadPhoto(
      { personId: PERSON_ID, file: jpeg1KB(), consent: true },
      supabase,
    )
    expect(result.status).toBe('not_authenticated')
    expect(supabase._bucket.upload).not.toHaveBeenCalled()
    expect(supabase.rpc).not.toHaveBeenCalled()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// impl_getPhotoSignedUrl — 8 cases (#9 – #13b)
// ────────────────────────────────────────────────────────────────────────────

describe('impl_getPhotoSignedUrl', () => {
  let supabase: MockSupabase

  beforeEach(() => { supabase = makeMockSupabase() })

  it('9 — null → no_photo; createSignedUrl NOT called', async () => {
    const result = await impl_getPhotoSignedUrl(null, supabase)
    expect(result.status).toBe('no_photo')
    expect(supabase._bucket.createSignedUrl).not.toHaveBeenCalled()
  })

  it('10 — drive.google.com URL → legacy_url; url passes through unchanged', async () => {
    const url = 'https://drive.google.com/open?id=1abc'
    const result = await impl_getPhotoSignedUrl(url, supabase)
    expect(result.status).toBe('legacy_url')
    if (result.status !== 'legacy_url') return
    expect(result.url).toBe(url)
    expect(supabase._bucket.createSignedUrl).not.toHaveBeenCalled()
  })

  it('11 — lh3.googleusercontent.com URL → legacy_url; url passes through unchanged', async () => {
    const url = 'https://lh3.googleusercontent.com/d/1abc=w400'
    const result = await impl_getPhotoSignedUrl(url, supabase)
    expect(result.status).toBe('legacy_url')
    if (result.status !== 'legacy_url') return
    expect(result.url).toBe(url)
    expect(supabase._bucket.createSignedUrl).not.toHaveBeenCalled()
  })

  it('12 — raw storage path → signed; createSignedUrl called with path and TTL 3600', async () => {
    const storagePath = `${PERSON_ID}/some-uuid.jpg`
    const result = await impl_getPhotoSignedUrl(storagePath, supabase)
    expect(result.status).toBe('signed')
    if (result.status !== 'signed') return
    expect(result.url).toBe(SIGNED_URL)
    expect(supabase._bucket.createSignedUrl).toHaveBeenCalledWith(storagePath, 3600)
  })

  it('12b — empty string "" → invalid_path; createSignedUrl NOT called', async () => {
    const result = await impl_getPhotoSignedUrl('', supabase)
    expect(result.status).toBe('invalid_path')
    expect(supabase._bucket.createSignedUrl).not.toHaveBeenCalled()
  })

  it('13 — https://evil.com/photo.jpg → invalid_path (unknown host)', async () => {
    const result = await impl_getPhotoSignedUrl('https://evil.com/photo.jpg', supabase)
    expect(result.status).toBe('invalid_path')
    expect(supabase._bucket.createSignedUrl).not.toHaveBeenCalled()
  })

  it('13b — https://drive.google.com.evil.com/foo → invalid_path (subdomain spoof; hostname !== drive.google.com)', async () => {
    const result = await impl_getPhotoSignedUrl('https://drive.google.com.evil.com/foo', supabase)
    expect(result.status).toBe('invalid_path')
    expect(supabase._bucket.createSignedUrl).not.toHaveBeenCalled()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// impl_deletePhoto — 1 case (#14)
// ────────────────────────────────────────────────────────────────────────────

describe('impl_deletePhoto', () => {
  it('14 — success: deleted + logAudit with PHOTO_DELETE; entityId = personId from path', async () => {
    const supabase = makeMockSupabase()
    const result = await impl_deletePhoto(TEST_PATH, supabase)
    expect(result.status).toBe('deleted')
    expect(supabase._bucket.remove).toHaveBeenCalledWith([TEST_PATH])
    expect(supabase.rpc).toHaveBeenCalledWith('log_audit', expect.objectContaining({
      p_action:    AUDIT_ACTIONS.PHOTO_DELETE,
      p_entity_id: PERSON_ID,  // derived from first path segment
    }))
    const details = (supabase.rpc as ReturnType<typeof vi.fn>).mock.calls[0][1].p_details_json
    expect(details).toEqual({ path: TEST_PATH })
  })
})
