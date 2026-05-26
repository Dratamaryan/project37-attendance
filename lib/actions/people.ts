'use server'

import { createClient } from '../supabase/server'
import {
  impl_lookupByPhone,
  impl_createPerson,
  impl_updatePerson,
  impl_softDeletePerson,
  impl_setPhotoConsent,
} from './people.impl'
import type {
  LookupResult,
  CreatePersonInput,
  CreateResult,
  UpdatePersonInput,
  UpdateResult,
  SoftDeleteResult,
  SupportedCountry,
} from './people.types'

export async function lookupByPhone(
  rawPhone: string,
  country: SupportedCountry,
): Promise<LookupResult> {
  const supabase = await createClient()
  return impl_lookupByPhone(rawPhone, country, supabase)
}

export async function createPerson(input: CreatePersonInput): Promise<CreateResult> {
  const supabase = await createClient()
  return impl_createPerson(input, supabase)
}

export async function updatePerson(
  id: string,
  input: UpdatePersonInput,
): Promise<UpdateResult> {
  const supabase = await createClient()
  return impl_updatePerson(id, input, supabase)
}

export async function softDeletePerson(id: string): Promise<SoftDeleteResult> {
  const supabase = await createClient()
  return impl_softDeletePerson(id, supabase)
}

export async function setPhotoConsent(id: string, consent: boolean): Promise<UpdateResult> {
  const supabase = await createClient()
  return impl_setPhotoConsent(id, consent, supabase)
}
