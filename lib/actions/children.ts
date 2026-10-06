'use server'

import { createClient } from '../supabase/server'
import {
  impl_listChildrenByParent,
  impl_lookupChildByName,
  impl_createChild,
  impl_updateChild,
  impl_softDeleteChild,
} from './children.impl'
import type {
  ListChildrenByParentResult,
  LookupChildByNameResult,
  CreateChildInput,
  CreateChildResult,
  UpdateChildInput,
  UpdateChildResult,
  SoftDeleteChildResult,
} from './children.types'

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

export async function createChild(input: CreateChildInput): Promise<CreateChildResult> {
  const supabase = await createClient()
  return impl_createChild(input, supabase)
}

export async function updateChild(id: string, input: UpdateChildInput): Promise<UpdateChildResult> {
  const supabase = await createClient()
  return impl_updateChild(id, input, supabase)
}

export async function softDeleteChild(id: string): Promise<SoftDeleteChildResult> {
  const supabase = await createClient()
  return impl_softDeleteChild(id, supabase)
}
