'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '../supabase/server'
import { createAdminClient } from '../supabase/admin'
import {
  impl_createEvent,
  impl_updateEvent,
  impl_cancelInstance,
  impl_updateInstance,
  impl_listEvents,
  impl_listInstancesForEvent,
  impl_listNearestInstances,
} from './events.impl'
import type {
  EventInput,
  UpdateEventInput,
  UpdateInstanceInput,
  CreateEventResult,
  UpdateEventResult,
  CancelInstanceResult,
  UpdateInstanceResult,
  ListEventsFilters,
  ListEventsResult,
  ListInstancesResult,
  ListNearestResult,
} from './events.types'

export async function createEvent(input: EventInput): Promise<CreateEventResult> {
  const supabase = await createClient()
  const adminSupabase = createAdminClient()
  const result = await impl_createEvent({ supabase, adminSupabase, input })
  if (result.status === 'ok') revalidatePath('/admin/events')
  return result
}

export async function updateEvent(
  eventId: string,
  input: UpdateEventInput,
): Promise<UpdateEventResult> {
  const supabase = await createClient()
  const adminSupabase = createAdminClient()
  const result = await impl_updateEvent({ supabase, adminSupabase, eventId, input })
  if (result.status === 'ok') revalidatePath('/admin/events')
  return result
}

export async function cancelInstance(
  instanceId: string,
  reason?: string,
): Promise<CancelInstanceResult> {
  const supabase = await createClient()
  const adminSupabase = createAdminClient()
  const result = await impl_cancelInstance({ supabase, adminSupabase, instanceId, reason })
  if (result.status === 'ok') revalidatePath('/admin/events')
  return result
}

export async function updateInstance(
  instanceId: string,
  input: UpdateInstanceInput,
): Promise<UpdateInstanceResult> {
  const supabase = await createClient()
  const adminSupabase = createAdminClient()
  const result = await impl_updateInstance({ supabase, adminSupabase, instanceId, input })
  if (result.status === 'ok') revalidatePath('/admin/events')
  return result
}

export async function listEvents(filters?: ListEventsFilters): Promise<ListEventsResult> {
  const supabase = await createClient()
  return impl_listEvents({ supabase, filters })
}

export async function listNearestInstances({
  limit,
  windowDays,
}: { limit?: number; windowDays?: number } = {}): Promise<ListNearestResult> {
  const supabase = await createClient()
  return impl_listNearestInstances({ supabase, limit, windowDays })
}

export async function listInstancesForEvent(
  eventId: string,
  range?: { from: Date; to: Date },
): Promise<ListInstancesResult> {
  const supabase = await createClient()
  return impl_listInstancesForEvent({ supabase, eventId, range })
}
