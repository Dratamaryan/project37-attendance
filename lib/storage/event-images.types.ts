// Shared by the server helpers and the client upload component — no imports,
// safe in Client Components.

export const EVENT_IMAGES_BUCKET = 'event-images'

export const EVENT_IMAGE_MAX_BYTES = 4 * 1024 * 1024  // 4 MB — mirrors bucket file_size_limit

export const EVENT_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const

export type EventImageMime = typeof EVENT_IMAGE_MIME_TYPES[number]

export type EventImageValidation =
  | { ok: true; mime: EventImageMime; ext: 'jpg' | 'png' | 'webp' }
  | { ok: false; reason: 'too_large' | 'invalid_type' | 'magic_mismatch' }

export type UploadInstanceImageResult =
  | { status: 'uploaded';      url: string; path: string }
  | { status: 'too_large' }
  | { status: 'invalid_type' }
  | { status: 'not_authorized' }
  | { status: 'not_found' }
  | { status: 'error';         message: string }

export type RemoveInstanceImageResult =
  | { status: 'removed' }
  | { status: 'no_image' }
  | { status: 'not_authorized' }
  | { status: 'not_found' }
  | { status: 'error';         message: string }
