// No 'use server' — imported by photos.ts (server actions) and by tests.
// Never import this file in Client Components.

import type { SupabaseClient } from '@supabase/supabase-js'
import { logAudit, AUDIT_ACTIONS } from '../audit'
import type {
  UploadPhotoInput,
  UploadResult,
  SignedUrlResult,
  DeleteResult,
} from './photos.types'

const BUCKET = 'people-photos'

const MAX_BYTES = 5 * 1024 * 1024  // 5 MB

// Maps accepted MIME types to the extension used in the storage path.
// image/heif normalises to heic — iPhones may send either; stored consistently.
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png':  'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heic',
}

// The extension derived from MIME_TO_EXT must be in this set.
// image/svg+xml, image/gif, and other image/* types are rejected.
// Mime-type spoofing is an accepted risk for Sprint 1 — all uploaders are
// authenticated organizers, not anonymous. Sprint 5+ may add magic-bytes
// validation if the threat model widens.
const ALLOWED_EXTS = new Set(['jpg', 'png', 'webp', 'heic'])

// Known legacy photo URL hostnames from the Sprint 6 roster import.
// All 191 imported people have Google-served photos — pass through unchanged.
// SECURITY: checked with new URL().hostname (exact equality).
// 'https://drive.google.com.evil.com/foo' → hostname 'drive.google.com.evil.com'
// → NOT a match → returns invalid_path. startsWith would have been bypassed.
const LEGACY_HOSTS = new Set(['drive.google.com', 'lh3.googleusercontent.com'])

function derivePersonIdFromPath(path: string): string {
  return path.split('/')[0] ?? path
}

// ── uploadPhoto ──────────────────────────────────────────────────────────────

export async function impl_uploadPhoto(
  input: UploadPhotoInput,
  supabase: SupabaseClient,
): Promise<UploadResult> {
  const { data: authData } = await supabase.auth.getUser()
  const user = authData.user
  if (!user) return { status: 'not_authenticated' }

  const { personId, file, consent } = input

  if (file.size > MAX_BYTES) return { status: 'too_large' }

  const mimeType = file.type
  if (!mimeType.startsWith('image/')) return { status: 'invalid_type' }

  const ext = MIME_TO_EXT[mimeType]
  if (!ext || !ALLOWED_EXTS.has(ext)) return { status: 'invalid_extension' }

  const path = `${personId}/${crypto.randomUUID()}.${ext}`
  const now = new Date().toISOString()

  const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
    contentType: mimeType,
    metadata: {
      consent:     String(consent),
      uploaded_by: user.id,
      uploaded_at: now,
    },
  })

  if (error) {
    console.error('[uploadPhoto] storage.upload', error)
    return { status: 'error', message: error.message }
  }

  await logAudit({
    actorUserId: user.id,
    action:      AUDIT_ACTIONS.PHOTO_UPLOAD,
    entityType:  'people',
    entityId:    personId,
    detailsJson: {
      path,
      size_bytes:        file.size,
      mime_type:         mimeType,
      consent_at_upload: consent,
    },
  }, supabase)

  return { status: 'uploaded', path }
}

// ── getPhotoSignedUrl ────────────────────────────────────────────────────────

/**
 * Resolves a people.photo_url value to a displayable URL.
 *
 * Discriminator (inputs are processed in this order):
 *   null         → no_photo  (person has no photo at all)
 *   ''           → invalid_path  (empty string is not a valid path or URL)
 *   starts 'https://'  → URL branch:
 *       hostname === drive.google.com or lh3.googleusercontent.com → legacy_url (pass through)
 *       any other host  → invalid_path  (reject unknown external URLs — could be a
 *                          malicious link from a future data-import bug)
 *   anything else → treated as a Supabase Storage path → createSignedUrl called
 *
 * SECURITY: hostname check uses new URL().hostname with exact equality.
 * 'https://drive.google.com.evil.com/foo' has hostname 'drive.google.com.evil.com'
 * and correctly returns invalid_path. A startsWith check on the full URL string
 * would be bypassed by that pattern.
 *
 * NOTE ON CONSENT: photo_publish_consent controls EXTERNAL publishing (birthday
 * digests, social media — Sprint 4+). It does NOT gate in-app reads. Admins and
 * organizers can always read uploaded photos inside the app, regardless of the
 * person's consent value. The RLS policies on the bucket enforce role-based access;
 * consent is a separate application-layer concern.
 *
 * NOTE ON SIGNED URL SECURITY: The returned url is a 1-hour bearer token. Do not
 * log it, cache it server-side, or include it in audit details. Log the path
 * (the input to this function) instead.
 */
export async function impl_getPhotoSignedUrl(
  photoUrl: string | null,
  supabase: SupabaseClient,
): Promise<SignedUrlResult> {
  if (photoUrl === null) return { status: 'no_photo' }
  if (photoUrl === '') return { status: 'invalid_path' }

  if (photoUrl.startsWith('https://')) {
    let hostname: string
    try {
      hostname = new URL(photoUrl).hostname
    } catch {
      return { status: 'invalid_path' }
    }
    if (LEGACY_HOSTS.has(hostname)) {
      return { status: 'legacy_url', url: photoUrl }
    }
    return { status: 'invalid_path' }
  }

  // Treat as a storage path within the people-photos bucket.
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(photoUrl, 3600)

  if (error) {
    console.error('[getPhotoSignedUrl] createSignedUrl', error)
    return { status: 'error', message: error.message }
  }

  return { status: 'signed', url: data.signedUrl }
}

// ── deletePhoto ──────────────────────────────────────────────────────────────

/**
 * Deletes a file from the people-photos bucket. Admin-only — enforced by RLS
 * (organizers have no DELETE policy on storage.objects for this bucket).
 *
 * Not exposed in any Sprint 1 UI. Included now so the vocabulary and signature
 * are stable when Sprint 5 admin tools add photo replacement workflows.
 */
export async function impl_deletePhoto(
  path: string,
  supabase: SupabaseClient,
): Promise<DeleteResult> {
  const { data: authData } = await supabase.auth.getUser()
  const user = authData.user
  if (!user) return { status: 'not_authorized' }

  const { data, error } = await supabase.storage.from(BUCKET).remove([path])

  if (error) {
    const errAny = error as { status?: number; statusCode?: string }
    if (errAny.status === 403 || errAny.statusCode === '42501') {
      return { status: 'not_authorized' }
    }
    console.error('[deletePhoto] storage.remove', error)
    return { status: 'error', message: error.message }
  }

  // storage.remove returns [] for paths that don't exist (no error — storage
  // silently no-ops on missing files). RLS-filtered deletes may also return [].
  // Both cases are treated as not_found; the live verify script confirms behavior.
  if (!data || data.length === 0) return { status: 'not_found' }

  const personId = derivePersonIdFromPath(path)

  await logAudit({
    actorUserId: user.id,
    action:      AUDIT_ACTIONS.PHOTO_DELETE,
    entityType:  'people',
    entityId:    personId,
    detailsJson: { path },
  }, supabase)

  return { status: 'deleted' }
}
