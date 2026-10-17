// S8-T10 similar-name warning helpers for the admin "Add person" form.
// Client-safe: no server-only imports, no DB access. The lookups themselves go
// through the existing lookupByName action (active people only, ≤5 per query).

import { sanitizeNameQuery, NAME_QUERY_MIN_LENGTH } from '@/lib/utils/name-query'
import type { LookupByNameResult } from '@/lib/actions/people.types'

export type NameMatch = {
  id: string
  full_name: string
  nickname: string
  phone_e164: string
}

/** Cache/acknowledgement key for a typed name: the sanitized form lookupByName searches on. */
export function nameKey(fullName: string): string {
  return sanitizeNameQuery(fullName)
}

/**
 * Queries to run for a typed full name: the whole name first, then its first
 * token when that differs and is long enough to be a valid lookup. Empty when
 * the name is too short to search at all.
 */
export function nameMatchQueries(fullName: string): string[] {
  const full = sanitizeNameQuery(fullName)
  if (full.length < NAME_QUERY_MIN_LENGTH) return []
  const first = full.split(' ')[0]
  return first !== full && first.length >= NAME_QUERY_MIN_LENGTH ? [full, first] : [full]
}

/** Dedupes by id, keeping full-name matches ahead of first-token matches. */
export function mergeMatches(results: LookupByNameResult[]): NameMatch[] {
  const seen = new Set<string>()
  const out: NameMatch[] = []
  for (const r of results) {
    if (r.status !== 'matches') continue
    for (const p of r.people) {
      if (seen.has(p.id)) continue
      seen.add(p.id)
      out.push({ id: p.id, full_name: p.full_name, nickname: p.nickname, phone_e164: p.phone_e164 })
    }
  }
  return out
}
