'use server'

import { createClient } from '../supabase/server'
import { createAdminClient } from '../supabase/admin'
import { impl_getSettings, impl_updateSettings, impl_getHorizonImpact } from './settings.impl'
import type {
  UpdateSettingsInput,
  GetSettingsResult,
  UpdateSettingsResult,
  HorizonImpactResult,
} from './settings.types'

export async function getSettings(): Promise<GetSettingsResult> {
  const supabase = await createClient()
  const adminSupabase = createAdminClient()
  return impl_getSettings({ supabase, adminSupabase })
}

export async function updateSettings(input: UpdateSettingsInput): Promise<UpdateSettingsResult> {
  const supabase = await createClient()
  const adminSupabase = createAdminClient()
  return impl_updateSettings({ supabase, adminSupabase, input })
}

export async function getHorizonImpact(newHorizonMonths: number): Promise<HorizonImpactResult> {
  const supabase = await createClient()
  const adminSupabase = createAdminClient()
  return impl_getHorizonImpact({ supabase, adminSupabase, input: { newHorizonMonths } })
}
