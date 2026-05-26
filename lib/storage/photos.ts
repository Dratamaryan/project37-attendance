'use server'

import { createClient } from '../supabase/server'
import {
  impl_uploadPhoto,
  impl_getPhotoSignedUrl,
  impl_deletePhoto,
} from './photos.impl'
import type {
  UploadPhotoInput,
  UploadResult,
  SignedUrlResult,
  DeleteResult,
} from './photos.types'

export async function uploadPhoto(input: UploadPhotoInput): Promise<UploadResult> {
  const supabase = await createClient()
  return impl_uploadPhoto(input, supabase)
}

export async function getPhotoSignedUrl(photoUrl: string | null): Promise<SignedUrlResult> {
  const supabase = await createClient()
  return impl_getPhotoSignedUrl(photoUrl, supabase)
}

export async function deletePhoto(path: string): Promise<DeleteResult> {
  const supabase = await createClient()
  return impl_deletePhoto(path, supabase)
}
