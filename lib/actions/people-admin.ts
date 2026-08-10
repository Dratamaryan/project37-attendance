'use server'

// Deliberately a SEPARATE file from people.ts: people.ts is imported by the
// public check-in flow (lookupByPhone), which has no admin session and must
// never pull in the service-role client. This file imports createAdminClient
// (lib/supabase/admin.ts, `import 'server-only'`) for the admin-only
// anonymize action — keeping that dependency out of people.ts, same split as
// parishes.ts / parishes-admin.ts.

import { createClient } from '../supabase/server'
import { createAdminClient } from '../supabase/admin'
import { impl_anonymizePerson } from './people.impl'
import type { AnonymizePersonResult } from './people.types'

export async function anonymizePerson(personId: string): Promise<AnonymizePersonResult> {
  const supabase = await createClient()
  const adminSupabase = createAdminClient()
  return impl_anonymizePerson({ supabase, adminSupabase, input: { personId } })
}
