import 'server-only'
// No 'use server' — imported by the /checkin/[instanceId]/attendees page and the
// admin instance export route only. SERVER client (RLS) by contract: the caller
// passes its createClient() session; this module never imports lib/supabase/admin.
// Organizer visibility therefore comes from RLS:
//   attendance_organizer_select / child_attendance_organizer_select (active users)
//   organizer_select / children_organizer_select (deleted_at IS NULL)
// Soft-deleted people/children are ALSO excluded explicitly (S8-T5 D2), so admins
// and organizers see the same list. Phones are masked HERE, so no full number is
// ever returned to a caller.

import type { SupabaseClient } from '@supabase/supabase-js'
import { maskPhoneLast4 } from '@/lib/utils/mask-phone'
import type {
  GetInstanceAttendeesResult,
  InstanceAdultAttendee,
  InstanceChildAttendee,
  InstanceHeader,
} from './instance-attendees.types'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PAGE_SIZE = 500          // below PostgREST max_rows=1000, same reasoning as export.impl.ts
const IN_CHUNK = 100           // keep .in() URLs short

type AdultRow = {
  id: string
  checked_in_at: string
  checked_in_by: string
  person_id: string
  person: { full_name: string; nickname: string | null; phone_e164: string }
}
type ChildRow = {
  id: string
  checked_in_at: string
  child: { full_name: string; parent: { full_name: string; phone_e164: string } | null }
}

async function fetchAllPages<T>(
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<T[] | null> {
  const rows: T[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1)
    if (error) {
      console.error('[getInstanceAttendees] page', error)
      return null
    }
    const page = (data ?? []) as T[]
    rows.push(...page)
    if (page.length < PAGE_SIZE) return rows
  }
}

export async function impl_getInstanceAttendees(
  { supabase, instanceId, includeCheckerEmail = false }:
  { supabase: SupabaseClient; instanceId: string; includeCheckerEmail?: boolean },
): Promise<GetInstanceAttendeesResult> {
  if (!UUID_RE.test(instanceId)) return { status: 'invalid_input' }

  const { data: instance, error: instErr } = await supabase
    .from('event_instances')
    .select('id, scheduled_at, status, event_name_snapshot')
    .eq('id', instanceId)
    .maybeSingle()
  if (instErr) {
    console.error('[getInstanceAttendees] instance', instErr)
    return { status: 'error', message: 'Failed to fetch instance' }
  }
  if (!instance) return { status: 'not_found' }

  // Adults — !inner: rows whose person RLS hides are dropped; soft-deleted people
  // are excluded explicitly for every role (D2).
  const adults = await fetchAllPages<AdultRow>((from, to) =>
    supabase
      .from('attendance')
      .select('id, checked_in_at, checked_in_by, person_id, person:people!inner(full_name, nickname, phone_e164)')
      .eq('event_instance_id', instanceId)
      .is('person.deleted_at', null)
      .order('checked_in_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  )

  // Children — child !inner (soft-deleted children excluded); parent is a LEFT
  // embed so a child whose parent is soft-deleted (or RLS-hidden) still appears,
  // with the parent nulled out — the same result for admin and organizer.
  const kids = await fetchAllPages<ChildRow>((from, to) =>
    supabase
      .from('child_attendance')
      .select('id, checked_in_at, child:children!inner(full_name, parent:people!parent_person_id(full_name, phone_e164))')
      .eq('event_instance_id', instanceId)
      .is('child.deleted_at', null)
      .is('child.parent.deleted_at', null)
      .order('checked_in_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  )
  if (!adults || !kids) return { status: 'error', message: 'Failed to fetch attendees' }

  // First-timer: this check-in IS the person's first non-cancelled attendance
  // (person_attendance_counts.first_attended_at). Compared as instants, not strings.
  const firstByPerson = new Map<string, number>()
  const personIds = [...new Set(adults.map(a => a.person_id))]
  for (let i = 0; i < personIds.length; i += IN_CHUNK) {
    const { data, error } = await supabase
      .from('person_attendance_counts')
      .select('person_id, first_attended_at')
      .in('person_id', personIds.slice(i, i + IN_CHUNK))
    if (error) {
      console.error('[getInstanceAttendees] first-attendance', error)
      return { status: 'error', message: 'Failed to fetch first-attendance' }
    }
    for (const r of (data ?? []) as Array<{ person_id: string; first_attended_at: string | null }>) {
      if (r.first_attended_at) firstByPerson.set(r.person_id, new Date(r.first_attended_at).getTime())
    }
  }

  // Checker emails — admin export only (organizers can't read others' app_users anyway).
  const emailById = new Map<string, string>()
  if (includeCheckerEmail) {
    const ids = [...new Set(adults.map(a => a.checked_in_by))]
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const { data, error } = await supabase.from('app_users').select('id, email').in('id', ids.slice(i, i + IN_CHUNK))
      if (error) {
        console.error('[getInstanceAttendees] checker emails', error)
        return { status: 'error', message: 'Failed to fetch checker emails' }
      }
      for (const u of (data ?? []) as Array<{ id: string; email: string }>) emailById.set(u.id, u.email)
    }
  }

  const adultRows: InstanceAdultAttendee[] = adults.map(a => ({
    attendance_id: a.id,
    full_name: a.person.full_name,
    nickname: a.person.nickname,
    phone_masked: maskPhoneLast4(a.person.phone_e164),
    checked_in_at: a.checked_in_at,
    is_first_timer: firstByPerson.get(a.person_id) === new Date(a.checked_in_at).getTime(),
    checker_email: includeCheckerEmail ? (emailById.get(a.checked_in_by) ?? null) : null,
  }))

  const childRows: InstanceChildAttendee[] = kids.map(k => ({
    child_attendance_id: k.id,
    child_name: k.child.full_name,
    parent_name: k.child.parent?.full_name ?? null,
    parent_phone_masked: k.child.parent ? maskPhoneLast4(k.child.parent.phone_e164) : null,
    checked_in_at: k.checked_in_at,
  }))

  return { status: 'ok', instance: instance as InstanceHeader, adults: adultRows, children: childRows }
}
