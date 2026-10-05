'use server'

import { createClient } from '../supabase/server'
import { impl_listChildrenByParent, impl_lookupChildByName } from './children.impl'
import type { ListChildrenByParentResult, LookupChildByNameResult } from './children.types'

export async function listChildrenByParent(
  parentPersonId: string,
): Promise<ListChildrenByParentResult> {
  const supabase = await createClient()
  return impl_listChildrenByParent(parentPersonId, supabase)
}

export async function lookupChildByName(query: string): Promise<LookupChildByNameResult> {
  const supabase = await createClient()
  return impl_lookupChildByName(query, supabase)
}
