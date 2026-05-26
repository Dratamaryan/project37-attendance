// No 'use server' — imported by parishes.ts (server actions) and by tests.
// Never import this file in Client Components.

import type { SupabaseClient } from '@supabase/supabase-js'
import { logAudit, AUDIT_ACTIONS } from '../audit'
import type {
  SearchParishOptions,
  SearchResult,
  CreateParishInput,
  CreateParishResult,
  ParishSearchResult,
} from './parishes.types'

const PARISH_FIELDS = 'id, name, city, region, status'

// ── searchParishes ───────────────────────────────────────────────────────────

export async function impl_searchParishes(
  query: string,
  options: SearchParishOptions,
  supabase: SupabaseClient,
): Promise<SearchResult> {
  const trimmed = query.trim()
  const includePending = options.includePending ?? true

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = supabase.from('parishes').select(PARISH_FIELDS)

  if (!includePending) {
    q = q.eq('status', 'approved')
  }

  if (!trimmed) {
    // Default dropdown (no input): most-recently-approved first so relevant
    // parishes surface immediately without typing.
    q = q.order('created_at', { ascending: false }).limit(20)
  } else {
    // Typed query: case-insensitive substring match, alphabetical order.
    q = q.ilike('name', `%${trimmed}%`).order('name', { ascending: true }).limit(20)
  }

  const { data, error } = await q

  if (error) {
    console.error('[searchParishes]', error)
    return { status: 'error', message: 'Failed to search parishes' }
  }

  return { status: 'success', parishes: (data ?? []) as ParishSearchResult[] }
}

// ── createPendingParish ──────────────────────────────────────────────────────

/**
 * Creates a parish with status='pending'. Admin approves via Sprint 5 Settings.
 *
 * Duplicate pre-check uses ILIKE (case-insensitive) to catch "Paroki Santa Maria"
 * vs "paroki santa maria". The DB-level UNIQUE constraint on parishes.name is
 * case-sensitive, so two concurrent entries with different casing (e.g. "santa maria"
 * and "Santa Maria") can both pass the ILIKE pre-check and both succeed — they have
 * different canonical names at the DB level. Accepted for Sprint 1; admins merge
 * near-duplicates in Sprint 5. Do not add CITEXT or a functional index now.
 */
export async function impl_createPendingParish(
  input: CreateParishInput,
  supabase: SupabaseClient,
): Promise<CreateParishResult> {
  // Normalize: collapse internal whitespace, strip leading/trailing
  const name = input.name.replace(/\s+/g, ' ').trim()
  const city   = input.city?.trim()   || null
  const region = input.region?.trim() || null

  // Validate
  const fieldErrors: Record<string, string> = {}
  if (!name)          fieldErrors.name = 'Required'
  if (name.length > 100) fieldErrors.name = 'Name must be 100 characters or fewer'

  if (Object.keys(fieldErrors).length > 0) {
    return { status: 'validation_error', field_errors: fieldErrors }
  }

  // Pre-check for duplicate (case-insensitive, any status).
  // Uses .limit(1) direct-await rather than .single() to avoid PGRST116-vs-
  // multiple-rows ambiguity — we only care whether any match exists.
  const { data: existingRows, error: dupErr } = await supabase
    .from('parishes')
    .select('id, name, status')
    .ilike('name', name)
    .limit(1)

  if (dupErr) {
    console.error('[createPendingParish] dup check', dupErr)
    return { status: 'error', message: 'Database error during duplicate check' }
  }

  if (existingRows && existingRows.length > 0) {
    const dup = existingRows[0]
    return {
      status:   'duplicate',
      existing: { id: dup.id, name: dup.name, status: dup.status },
    }
  }

  // Auth check — actor needed for audit log
  const { data: authData } = await supabase.auth.getUser()
  const user = authData.user
  if (!user) return { status: 'error', message: 'Not authenticated' }

  // Insert — status explicitly set to 'pending'; RLS organizer_insert policy
  // also enforces this at the DB level (WITH CHECK status = 'pending').
  const { data: created, error: insertErr } = await supabase
    .from('parishes')
    .insert({ name, city, region, status: 'pending' })
    .select(PARISH_FIELDS)
    .single()

  if (insertErr) {
    if (insertErr.code === '23505') {
      // TOCTOU race: case-sensitive unique violation — the UNIQUE constraint on
      // parishes.name is exact-match, so the conflicting row has the same casing.
      const { data: conflicting } = await supabase
        .from('parishes')
        .select('id, name, status')
        .eq('name', name)
        .single()
      return {
        status:   'duplicate',
        existing: conflicting
          ? { id: conflicting.id, name: conflicting.name, status: conflicting.status }
          : { id: '', name, status: 'pending' },
      }
    }
    console.error('[createPendingParish] insert', insertErr)
    return { status: 'error', message: 'Failed to create parish' }
  }

  await logAudit({
    actorUserId: user.id,
    action:      AUDIT_ACTIONS.PARISH_CREATE,
    entityType:  'parishes',
    entityId:    created.id,
    detailsJson: { name, city, region },
  }, supabase)

  return { status: 'created', parish: created as ParishSearchResult }
}
