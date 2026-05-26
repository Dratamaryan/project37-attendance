export type UploadPhotoInput = {
  personId: string
  /** Accept both for Server Action (File from browser) and Node test (Blob) compatibility. */
  file: File | Blob
  /** photo_publish_consent at upload time — captured in storage metadata as the audit trail. */
  consent: boolean
}

export type UploadResult =
  | { status: 'uploaded';            path: string }
  | { status: 'too_large' }
  | { status: 'invalid_type' }
  | { status: 'invalid_extension' }
  | { status: 'not_authenticated' }
  | { status: 'error';               message: string }

export type SignedUrlResult =
  | { status: 'signed';     url: string }
  | { status: 'legacy_url'; url: string }
  | { status: 'no_photo' }
  | { status: 'invalid_path' }
  | { status: 'error';      message: string }

export type DeleteResult =
  | { status: 'deleted' }
  | { status: 'not_found' }
  | { status: 'not_authorized' }
  | { status: 'error';         message: string }
