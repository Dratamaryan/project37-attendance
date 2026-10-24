'use server'

import { createClient } from '@/lib/supabase/server'
import {
  impl_getOrCreateRsvpLink,
  impl_deactivateRsvpLink,
  impl_getInstanceRsvpPanel,
  impl_deleteRsvp,
} from './admin.impl'
import type {
  GetOrCreateRsvpLinkResult,
  DeactivateRsvpLinkResult,
  GetInstanceRsvpPanelResult,
  DeleteRsvpResult,
} from './admin.types'

export async function getOrCreateRsvpLink(instanceId: string): Promise<GetOrCreateRsvpLinkResult> {
  const supabase = await createClient()
  return impl_getOrCreateRsvpLink(instanceId, supabase)
}

export async function deactivateRsvpLink(instanceId: string): Promise<DeactivateRsvpLinkResult> {
  const supabase = await createClient()
  return impl_deactivateRsvpLink(instanceId, supabase)
}

export async function getInstanceRsvpPanel(instanceId: string): Promise<GetInstanceRsvpPanelResult> {
  const supabase = await createClient()
  return impl_getInstanceRsvpPanel(instanceId, supabase)
}

export async function deleteRsvp(rsvpId: string): Promise<DeleteRsvpResult> {
  const supabase = await createClient()
  return impl_deleteRsvp(rsvpId, supabase)
}
