// No 'use server' — imported by event-images.ts (server actions) and by tests.
// Never import this file in Client Components (use event-images.types.ts).

import type { SupabaseClient } from '@supabase/supabase-js'
import { logAudit, AUDIT_ACTIONS } from '../audit'
import { requireActiveAdmin } from '../auth/require-admin'
import {
  EVENT_IMAGES_BUCKET,
  EVENT_IMAGE_MAX_BYTES,
  type EventImageMime,
  type EventImageValidation,
  type UploadInstanceImageResult,
  type RemoveInstanceImageResult,
} from './event-images.types'

const BUCKET = EVENT_IMAGES_BUCKET

// Object paths are never overwritten (fresh uuid per upload), so a 1-year
// cache is safe; Supabase's built-in CDN serves the public bucket.
const CACHE_CONTROL_SECONDS = '31536000'

const MIME_TO_EXT: Record<EventImageMime, 'jpg' | 'png' | 'webp'> = {
  'image/jpeg': 'jpg',
  'image/png':  'png',
  'image/webp': 'webp',
}

function isAllowedMime(type: string): type is EventImageMime {
  return Object.prototype.hasOwnProperty.call(MIME_TO_EXT, type)
}

// Magic-byte signatures. Unlike people-photos (authenticated organizers,
// spoofing an accepted risk), these objects are served publicly from our
// Supabase origin — the declared MIME must match the actual bytes so a
// renamed HTML/SVG payload can't be stored as image/png.
function magicMatches(mime: EventImageMime, head: Uint8Array): boolean {
  const startsWith = (sig: number[], offset = 0) =>
    head.length >= offset + sig.length && sig.every((b, i) => head[offset + i] === b)

  switch (mime) {
    case 'image/jpeg':
      return startsWith([0xff, 0xd8, 0xff])
    case 'image/png':
      return startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    case 'image/webp':
      // 'RIFF' <4-byte size> 'WEBP'
      return startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)
  }
}

// ── validateEventImage ───────────────────────────────────────────────────────

/**
 * Size ≤ 4 MB, declared MIME in {jpeg, png, webp}, and the leading bytes must
 * match the declared type. No I/O beyond reading the first 12 bytes of the
 * blob itself — deterministic for a given input.
 */
export async function validateEventImage(file: Blob): Promise<EventImageValidation> {
  if (file.size > EVENT_IMAGE_MAX_BYTES) return { ok: false, reason: 'too_large' }

  const mime = file.type
  if (!isAllowedMime(mime)) return { ok: false, reason: 'invalid_type' }

  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer())
  if (!magicMatches(mime, head)) return { ok: false, reason: 'magic_mismatch' }

  return { ok: true, mime, ext: MIME_TO_EXT[mime] }
}

// ── uploadInstanceImage ──────────────────────────────────────────────────────

/**
 * Uploads a new image for one event instance and points image_url at its
 * public URL. The previous object (if any) is NOT deleted — invites already
 * sent embed its URL.
 *
 * Order: admin guard → validate → instance exists (so a bad id never leaves
 * an orphan object) → upload → UPDATE image_url → audit.
 */
export async function impl_uploadInstanceImage(
  input: { instanceId: string; file: Blob },
  supabase: SupabaseClient,
): Promise<UploadInstanceImageResult> {
  const guard = await requireActiveAdmin(supabase)
  if (guard.status !== 'ok') return { status: 'not_authorized' }
  const actorId = guard.actorId

  const { instanceId, file } = input

  const validation = await validateEventImage(file)
  if (!validation.ok) {
    return validation.reason === 'too_large' ? { status: 'too_large' } : { status: 'invalid_type' }
  }

  const { data: existing, error: lookupError } = await supabase
    .from('event_instances')
    .select('id')
    .eq('id', instanceId)
    .maybeSingle()
  if (lookupError) {
    console.error('[uploadInstanceImage] lookup', lookupError)
    return { status: 'error', message: lookupError.message }
  }
  if (!existing) return { status: 'not_found' }

  const path = `instances/${instanceId}/${crypto.randomUUID()}.${validation.ext}`

  const { error: uploadError } = await supabase.storage.from(BUCKET).upload(path, file, {
    contentType:  validation.mime,
    cacheControl: CACHE_CONTROL_SECONDS,
  })
  if (uploadError) {
    console.error('[uploadInstanceImage] storage.upload', uploadError)
    return { status: 'error', message: uploadError.message }
  }

  const publicUrl = supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl

  const { data: rows, error: updateError } = await supabase
    .from('event_instances')
    .update({ image_url: publicUrl })
    .eq('id', instanceId)
    .select('id')
  if (updateError || !rows || rows.length === 0) {
    // Object is already stored; an orphan is acceptable (same stance as
    // people-photos cleanup) — the row is the source of truth.
    console.error('[uploadInstanceImage] update', updateError)
    return { status: 'error', message: updateError?.message ?? 'Failed to update instance' }
  }

  await logAudit({
    actorUserId: actorId,
    action:      AUDIT_ACTIONS.EVENT_IMAGE_UPLOAD,
    entityType:  'event_instance',
    entityId:    instanceId,
    detailsJson: {
      instance_id: instanceId,
      path,
      size: file.size,
      mime: validation.mime,
    },
  }, supabase)

  return { status: 'uploaded', url: publicUrl, path }
}

// ── removeInstanceImage ──────────────────────────────────────────────────────

/**
 * Clears image_url. The storage object is NOT deleted (sent invites embed it).
 * previous_was_storage records whether the cleared value pointed into this
 * bucket or was a legacy pasted URL.
 */
export async function impl_removeInstanceImage(
  input: { instanceId: string },
  supabase: SupabaseClient,
): Promise<RemoveInstanceImageResult> {
  const guard = await requireActiveAdmin(supabase)
  if (guard.status !== 'ok') return { status: 'not_authorized' }
  const actorId = guard.actorId

  const { instanceId } = input

  const { data: existing, error: lookupError } = await supabase
    .from('event_instances')
    .select('id, image_url')
    .eq('id', instanceId)
    .maybeSingle()
  if (lookupError) {
    console.error('[removeInstanceImage] lookup', lookupError)
    return { status: 'error', message: lookupError.message }
  }
  if (!existing) return { status: 'not_found' }

  const previous = (existing as { image_url: string | null }).image_url
  if (previous === null) return { status: 'no_image' }

  const { data: rows, error: updateError } = await supabase
    .from('event_instances')
    .update({ image_url: null })
    .eq('id', instanceId)
    .select('id')
  if (updateError || !rows || rows.length === 0) {
    console.error('[removeInstanceImage] update', updateError)
    return { status: 'error', message: updateError?.message ?? 'Failed to update instance' }
  }

  const bucketPrefix = supabase.storage.from(BUCKET).getPublicUrl('').data.publicUrl

  await logAudit({
    actorUserId: actorId,
    action:      AUDIT_ACTIONS.EVENT_IMAGE_REMOVE,
    entityType:  'event_instance',
    entityId:    instanceId,
    detailsJson: {
      instance_id: instanceId,
      previous_was_storage: previous.startsWith(bucketPrefix),
    },
  }, supabase)

  return { status: 'removed' }
}
