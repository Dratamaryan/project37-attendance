'use server'

import { createClient } from '../supabase/server'
import { impl_searchParishes, impl_createPendingParish } from './parishes.impl'
import type {
  SearchParishOptions,
  SearchResult,
  CreateParishInput,
  CreateParishResult,
} from './parishes.types'

export async function searchParishes(
  query: string,
  options?: SearchParishOptions,
): Promise<SearchResult> {
  const supabase = await createClient()
  return impl_searchParishes(query, options ?? {}, supabase)
}

export async function createPendingParish(
  input: CreateParishInput,
): Promise<CreateParishResult> {
  const supabase = await createClient()
  return impl_createPendingParish(input, supabase)
}
