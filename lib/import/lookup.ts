// The only DB-touching, read-only piece of the import engine's dedup logic.
// Split out from classify.ts (which must stay pure) so this remains
// independently integration-testable against a real DB.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ExistingPhoneRecord } from './classify'

/** ONE batched IN query — never .is('deleted_at', null): dup_soft_deleted
 *  classification needs to SEE soft-deleted matches, not have them filtered
 *  out. Dedupes the input phone list before querying to keep the IN-list
 *  minimal (a file can list the same phone many times). */
export async function fetchExistingPhonesByE164(
  supabase: SupabaseClient,
  phones: string[],
): Promise<Map<string, ExistingPhoneRecord>> {
  const uniquePhones = [...new Set(phones)]
  const result = new Map<string, ExistingPhoneRecord>()

  if (uniquePhones.length === 0) return result

  const { data, error } = await supabase
    .from('people')
    .select('id, phone_e164, deleted_at')
    .in('phone_e164', uniquePhones)

  if (error) throw error

  for (const person of data ?? []) {
    result.set(person.phone_e164, { id: person.id, deletedAt: person.deleted_at })
  }

  return result
}
