'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '../supabase/server'
import { impl_uploadInstanceImage, impl_removeInstanceImage } from './event-images.impl'
import type { UploadInstanceImageResult, RemoveInstanceImageResult } from './event-images.types'

// RLS server client only — the admin-only storage policy and event_instances
// RLS are the enforcement layer; no service role here.

export async function uploadInstanceImage(
  instanceId: string,
  file: File,
): Promise<UploadInstanceImageResult> {
  const supabase = await createClient()
  const result = await impl_uploadInstanceImage({ instanceId, file }, supabase)
  if (result.status === 'uploaded') revalidatePath('/admin/events')
  return result
}

export async function removeInstanceImage(instanceId: string): Promise<RemoveInstanceImageResult> {
  const supabase = await createClient()
  const result = await impl_removeInstanceImage({ instanceId }, supabase)
  if (result.status === 'removed') revalidatePath('/admin/events')
  return result
}
