import 'server-only'
// No 'use server' — imported by lib/rsvp/admin.ts (server actions), the admin
// instance page, and tests. Never import this file in Client Components.
//
// S9-R3 admin RSVP panel. SERVER client (RLS) by contract: callers pass their
// createClient() session; this module never imports lib/supabase/admin.
// event_rsvps / event_rsvp_links are admin-only by RLS (R0) and the
// rsvp_checkin_crosstab view returns rows only when is_admin(), so the
// requireActiveAdmin check at the top of every action is the primary control
// and RLS is the backstop. Phones are masked HERE — no full number is ever
// returned to a caller.

import type { SupabaseClient } from '@supabase/supabase-js'
import { requireActiveAdmin } from '@/lib/auth/require-admin'
import { AUDIT_ACTIONS, logAudit } from '@/lib/audit'
import { maskPhoneLast4 } from '@/lib/utils/mask-phone'
import { displayInstanceName } from '@/lib/events/display'
import { isRsvpPublicEnabled } from './config'
import {
  RSVP_BUCKETS,
  type DeactivateRsvpLinkResult,
  type DeleteRsvpResult,
  type GetInstanceRsvpExportResult,
  type GetInstanceRsvpPanelResult,
  type GetOrCreateRsvpLinkResult,
  type ListPersonRsvpHistoryResult,
  type PersonRsvpHistoryRow,
  type RsvpExportRow,
  type RsvpBucket,
  type RsvpPanelRow,
  type RsvpPanelTotals,
  type RsvpStatus,
} from './admin.types'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PAGE_SIZE = 500          // below PostgREST max_rows=1000, same as instance-attendees.impl.ts
const IN_CHUNK = 100           // keep .in() URLs short

// ── config ───────────────────────────────────────────────────────────────────

// isRsvpPublicEnabled lives in ./config (shared with the public RSVP page);
// re-exported here so existing importers/tests keep working.
export { isRsvpPublicEnabled }

/** NEXT_PUBLIC_APP_URL as an http(s) origin, or null when unset/unparseable. */
function appBaseUrl(): string | null {
  const raw = process.env.NEXT_PUBLIC_APP_URL
  if (!raw) return null
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return parsed.origin
}

/**
 * Absolute public RSVP URL for a link token. Built from NEXT_PUBLIC_APP_URL
 * only — never from request Host headers, which a client controls.
 */
export function buildRsvpUrl(token: string): string | 'misconfigured' {
  const base = appBaseUrl()
  if (!base) return 'misconfigured'
  return `${base}/rsvp/${encodeURIComponent(token)}`
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function fetchAllPages<T>(
  label: string,
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<T[] | null> {
  const rows: T[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1)
    if (error) {
      console.error(`[rsvp-admin] ${label}`, error)
      return null
    }
    const page = (data ?? []) as T[]
    rows.push(...page)
    if (page.length < PAGE_SIZE) return rows
  }
}

type ActiveLink = { id: string; token: string }

async function selectActiveLink(
  supabase: SupabaseClient,
  instanceId: string,
): Promise<{ link: ActiveLink | null; error: unknown }> {
  const { data, error } = await supabase
    .from('event_rsvp_links')
    .select('id, token')
    .eq('event_instance_id', instanceId)
    .eq('is_active', true)
    .maybeSingle()
  return { link: (data as ActiveLink | null) ?? null, error }
}

// ── getOrCreateRsvpLink ──────────────────────────────────────────────────────

/**
 * On-demand link for a scheduled instance: returns the active link, or
 * inserts one (token from the DB default, created_by = actor). The partial
 * unique index allows one active link per instance, so a concurrent insert
 * fails 23505 and we re-select the winner. Audits only when a row was
 * inserted — IDs only, never the token.
 */
export async function impl_getOrCreateRsvpLink(
  instanceId: string,
  supabase: SupabaseClient,
): Promise<GetOrCreateRsvpLinkResult> {
  const guard = await requireActiveAdmin(supabase)
  if (guard.status !== 'ok') return { status: 'not_authorized' }
  if (!UUID_RE.test(instanceId)) return { status: 'invalid_input' }
  if (!isRsvpPublicEnabled()) return { status: 'disabled' }
  // Checked before any insert, so a misconfigured deploy never mints a link
  // it can't hand out.
  if (!appBaseUrl()) return { status: 'misconfigured' }

  const { data: instance, error: instErr } = await supabase
    .from('event_instances')
    .select('id, status')
    .eq('id', instanceId)
    .maybeSingle()
  if (instErr) {
    console.error('[getOrCreateRsvpLink] instance', instErr)
    return { status: 'error', message: 'Failed to fetch instance' }
  }
  if (!instance) return { status: 'not_found' }
  if ((instance as { status: string }).status !== 'scheduled') return { status: 'closed' }

  const existing = await selectActiveLink(supabase, instanceId)
  if (existing.error) {
    console.error('[getOrCreateRsvpLink] select', existing.error)
    return { status: 'error', message: 'Failed to fetch link' }
  }

  let link = existing.link
  let created = false
  if (!link) {
    const { data: inserted, error: insertErr } = await supabase
      .from('event_rsvp_links')
      .insert({ event_instance_id: instanceId, created_by: guard.actorId })
      .select('id, token')
      .single()

    if (insertErr) {
      if ((insertErr as { code?: string }).code !== '23505') {
        console.error('[getOrCreateRsvpLink] insert', insertErr)
        return { status: 'error', message: 'Failed to create link' }
      }
      // Lost the race to a concurrent create — use the winner's link.
      const raced = await selectActiveLink(supabase, instanceId)
      if (raced.error || !raced.link) {
        console.error('[getOrCreateRsvpLink] re-select after 23505', raced.error)
        return { status: 'error', message: 'Failed to fetch link' }
      }
      link = raced.link
    } else {
      link = inserted as ActiveLink
      created = true
    }
  }

  if (created) {
    await logAudit({
      actorUserId: guard.actorId,
      action:      AUDIT_ACTIONS.RSVP_LINK_CREATE,
      entityType:  'event_rsvp_link',
      entityId:    link.id,
      detailsJson: { instance_id: instanceId, link_id: link.id },
    }, supabase)
  }

  const url = buildRsvpUrl(link.token)
  if (url === 'misconfigured') return { status: 'misconfigured' }
  return { status: 'ok', url, linkId: link.id, created }
}

// ── deactivateRsvpLink ───────────────────────────────────────────────────────

/** Deactivates the instance's active link; its token stops working at once. */
export async function impl_deactivateRsvpLink(
  instanceId: string,
  supabase: SupabaseClient,
): Promise<DeactivateRsvpLinkResult> {
  const guard = await requireActiveAdmin(supabase)
  if (guard.status !== 'ok') return { status: 'not_authorized' }
  if (!UUID_RE.test(instanceId)) return { status: 'invalid_input' }

  const { data, error } = await supabase
    .from('event_rsvp_links')
    .update({ is_active: false })
    .eq('event_instance_id', instanceId)
    .eq('is_active', true)
    .select('id')
  if (error) {
    console.error('[deactivateRsvpLink]', error)
    return { status: 'error', message: 'Failed to deactivate link' }
  }
  const rows = (data ?? []) as Array<{ id: string }>
  if (rows.length === 0) return { status: 'no_link' }
  const linkId = rows[0]!.id

  await logAudit({
    actorUserId: guard.actorId,
    action:      AUDIT_ACTIONS.RSVP_LINK_DEACTIVATE,
    entityType:  'event_rsvp_link',
    entityId:    linkId,
    detailsJson: { instance_id: instanceId, link_id: linkId },
  }, supabase)

  return { status: 'ok', linkId }
}

// ── shared RSVP data (panel + export) ────────────────────────────────────────

type RsvpRow = {
  id: string
  phone_e164: string | null
  name: string | null
  children_count: number
  followup_consent: boolean
  status: RsvpStatus
  person_id: string | null
  anonymized_at: string | null
  created_at: string
  updated_at: string
}
type CrosstabRow = {
  rsvp_id: string | null
  resolved_person_id: string | null
  attended: boolean
  bucket: RsvpBucket
}
type PersonRow = {
  id: string
  full_name: string
  deleted_at: string | null
  anonymized_at: string | null
}

/** One RSVP after resolution — the phone shape is chosen by the caller. */
type DerivedRsvpRow<P> = {
  rsvp_id: string
  display_kind: RsvpPanelRow['display_kind']
  display_name: string | null
  status: RsvpStatus
  children_count: number
  followup_consent: boolean
  phone: P
  created_at: string
  updated_at: string
  attended: boolean
  anonymized: boolean
}

type InstanceRsvpData = {
  totals: RsvpPanelTotals
  buckets: Record<RsvpBucket, number>
  children: { expected: number; checked_in: number }
  /** The single row derivation shared by panel and export, so they can't drift. */
  deriveRows: <P>(phone: (phoneE164: string | null, followupConsent: boolean) => P) => Array<DerivedRsvpRow<P>>
}

/**
 * Loads everything the panel and the export show for one instance: the
 * instance's RSVPs, its rsvp_checkin_crosstab rows (admin session only — the
 * view is is_admin()-filtered, a service-role client would read zero rows),
 * the roster rows of every resolved person, and the child check-in count.
 * Read-only. Caller has already run requireActiveAdmin + the UUID check.
 */
async function loadInstanceRsvpData(
  instanceId: string,
  supabase: SupabaseClient,
): Promise<{ status: 'ok'; data: InstanceRsvpData } | { status: 'error'; message: string }> {
  const rsvps = await fetchAllPages<RsvpRow>('rsvps', (from, to) =>
    supabase
      .from('event_rsvps')
      .select('id, phone_e164, name, children_count, followup_consent, status, person_id, anonymized_at, created_at, updated_at')
      .eq('event_instance_id', instanceId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  )
  const crosstab = await fetchAllPages<CrosstabRow>('crosstab', (from, to) =>
    supabase
      .from('rsvp_checkin_crosstab')
      .select('rsvp_id, resolved_person_id, attended, bucket')
      .eq('event_instance_id', instanceId)
      .order('rsvp_id', { ascending: true, nullsFirst: true })
      .order('attendance_id', { ascending: true, nullsFirst: true })
      .range(from, to),
  )
  if (!rsvps || !crosstab) return { status: 'error', message: 'Failed to fetch RSVPs' }

  // Same embeds + filters as impl_getInstanceAttendees, so this number always
  // equals the Children list on the same page: child !inner with soft-deleted
  // children excluded; parent a LEFT embed (a child whose parent is
  // soft-deleted still counts there, so it counts here too).
  const { count: childCheckins, error: childErr } = await supabase
    .from('child_attendance')
    .select('id, child:children!inner(id, parent:people!parent_person_id(id))', { count: 'exact', head: true })
    .eq('event_instance_id', instanceId)
    .is('child.deleted_at', null)
    .is('child.parent.deleted_at', null)
  if (childErr) {
    console.error('[rsvp-admin] child_attendance', childErr)
    return { status: 'error', message: 'Failed to count child check-ins' }
  }

  const unitByRsvp = new Map<string, CrosstabRow>()
  const buckets = Object.fromEntries(RSVP_BUCKETS.map(b => [b, 0])) as Record<RsvpBucket, number>
  for (const u of crosstab) {
    buckets[u.bucket] += 1
    if (u.rsvp_id) unitByRsvp.set(u.rsvp_id, u)
  }

  // Roster rows for every resolved person — admin RLS sees soft-deleted rows,
  // which is what distinguishes 'removed_member' from 'member'.
  const personById = new Map<string, PersonRow>()
  const personIds = [...new Set(crosstab.map(u => u.resolved_person_id).filter((id): id is string => id !== null))]
  for (let i = 0; i < personIds.length; i += IN_CHUNK) {
    const { data, error } = await supabase
      .from('people')
      .select('id, full_name, deleted_at, anonymized_at')
      .in('id', personIds.slice(i, i + IN_CHUNK))
    if (error) {
      console.error('[rsvp-admin] people', error)
      return { status: 'error', message: 'Failed to fetch people' }
    }
    for (const p of (data ?? []) as PersonRow[]) personById.set(p.id, p)
  }

  const totals: RsvpPanelTotals = {
    responses: rsvps.length,
    coming_people: 0,
    coming_headcount: 0,
    coming_children: 0,
    maybe_people: 0,
    maybe_headcount: 0,
    not_coming_people: 0,
  }
  for (const r of rsvps) {
    if (r.status === 'coming') {
      totals.coming_people += 1
      totals.coming_headcount += 1 + r.children_count
      totals.coming_children += r.children_count
    } else if (r.status === 'maybe') {
      totals.maybe_people += 1
      totals.maybe_headcount += 1 + r.children_count
    } else {
      totals.not_coming_people += 1
    }
  }

  function deriveRows<P>(phone: (phoneE164: string | null, followupConsent: boolean) => P): Array<DerivedRsvpRow<P>> {
    return rsvps!.map(r => {
      const unit = unitByRsvp.get(r.id)
      const resolvedId = unit?.resolved_person_id ?? null
      const person = resolvedId ? personById.get(resolvedId) : undefined
      let display_kind: RsvpPanelRow['display_kind']
      let display_name: string | null
      if (!resolvedId) {
        display_kind = 'newcomer'
        display_name = r.name
      } else if (person && person.deleted_at === null && person.anonymized_at === null) {
        display_kind = 'member'
        display_name = person.full_name
      } else {
        display_kind = 'removed_member'
        display_name = null
      }
      return {
        rsvp_id: r.id,
        display_kind,
        display_name,
        status: r.status,
        children_count: r.children_count,
        followup_consent: r.followup_consent,
        phone: phone(r.phone_e164, r.followup_consent),
        created_at: r.created_at,
        updated_at: r.updated_at,
        attended: unit?.attended ?? false,
        anonymized: r.anonymized_at !== null,
      }
    })
  }

  return {
    status: 'ok',
    data: {
      totals,
      buckets,
      children: { expected: totals.coming_children, checked_in: childCheckins ?? 0 },
      deriveRows,
    },
  }
}

// ── getInstanceRsvpPanel ─────────────────────────────────────────────────────

/**
 * Read-only aggregation for the admin instance page: link state, totals
 * (headcount = Σ 1 + children_count), cross-tab bucket counts from
 * rsvp_checkin_crosstab, expected vs checked-in children, and the per-RSVP
 * list. Never writes. Phones always masked.
 */
export async function impl_getInstanceRsvpPanel(
  instanceId: string,
  supabase: SupabaseClient,
): Promise<GetInstanceRsvpPanelResult> {
  const guard = await requireActiveAdmin(supabase)
  if (guard.status !== 'ok') return { status: 'not_authorized' }
  if (!UUID_RE.test(instanceId)) return { status: 'invalid_input' }

  const publicEnabled = isRsvpPublicEnabled()

  const active = await selectActiveLink(supabase, instanceId)
  if (active.error) {
    console.error('[getInstanceRsvpPanel] link', active.error)
    return { status: 'error', message: 'Failed to fetch link' }
  }

  const loaded = await loadInstanceRsvpData(instanceId, supabase)
  if (loaded.status === 'error') return loaded
  const { totals, buckets, children } = loaded.data

  const rows: RsvpPanelRow[] = loaded.data
    .deriveRows(phoneE164 => (phoneE164 ? maskPhoneLast4(phoneE164) : null))
    .map(r => ({
      rsvp_id: r.rsvp_id,
      display_kind: r.display_kind,
      display_name: r.display_name,
      status: r.status,
      children_count: r.children_count,
      followup_consent: r.followup_consent,
      phone_masked: r.phone,
      created_at: r.created_at,
      updated_at: r.updated_at,
      attended: r.attended,
      anonymized: r.anonymized,
    }))

  let url: string | null = null
  if (publicEnabled && active.link) {
    const built = buildRsvpUrl(active.link.token)
    url = built === 'misconfigured' ? null : built
  }

  return {
    status: 'ok',
    panel: {
      link: { active: active.link !== null, url },
      publicEnabled,
      totals,
      buckets,
      children,
      rows,
    },
  }
}

// ── getInstanceRsvpExport ────────────────────────────────────────────────────

/**
 * Data for the admin RSVP .xlsx export. Same rows/totals/buckets/children as
 * the panel (shared loader + row builder), differing only in the phone rule:
 * follow-up consent given -> full E.164 (the admin may contact them);
 * otherwise last-4 mask; no phone -> ''. Not gated by RSVP_PUBLIC_ENABLED —
 * existing RSVPs stay exportable after the public form is switched off.
 */
export async function impl_getInstanceRsvpExport(
  instanceId: string,
  supabase: SupabaseClient,
): Promise<GetInstanceRsvpExportResult> {
  const guard = await requireActiveAdmin(supabase)
  if (guard.status !== 'ok') return { status: 'not_authorized' }
  if (!UUID_RE.test(instanceId)) return { status: 'invalid_input' }

  const { data: instance, error: instErr } = await supabase
    .from('event_instances')
    .select('id, scheduled_at')
    .eq('id', instanceId)
    .maybeSingle()
  if (instErr) {
    console.error('[getInstanceRsvpExport] instance', instErr)
    return { status: 'error', message: 'Failed to fetch instance' }
  }
  if (!instance) return { status: 'not_found' }

  const loaded = await loadInstanceRsvpData(instanceId, supabase)
  if (loaded.status === 'error') return loaded
  const { totals, buckets, children } = loaded.data

  const rows: RsvpExportRow[] = loaded.data.deriveRows((phoneE164, followupConsent) => {
    if (!phoneE164) return ''
    return followupConsent ? phoneE164 : maskPhoneLast4(phoneE164)
  })

  return {
    status: 'ok',
    instance: instance as { id: string; scheduled_at: string },
    totals,
    buckets,
    children,
    rows,
    full_phone_rows: rows.filter(r => r.followup_consent && r.phone !== '').length,
  }
}

// ── listPersonRsvpHistory ────────────────────────────────────────────────────

type HistoryUnit = {
  rsvp_id: string
  event_instance_id: string
  rsvp_status: RsvpStatus
  children_count: number
  attended: boolean
}
type HistoryInstance = {
  id: string
  event_id: string
  scheduled_at: string
  status: string
  event_name_snapshot: string
  event_name_snapshot_id: string | null
  event: { name: string; name_id: string | null } | null
}

/**
 * Every RSVP that resolves to this person — matched at submit (person_id) OR
 * via a later phone match — read from rsvp_checkin_crosstab on the admin
 * session (the view is is_admin()-filtered; never the service role).
 * Newest occurrence first. No phone is selected or returned.
 */
export async function impl_listPersonRsvpHistory(
  personId: string,
  supabase: SupabaseClient,
  locale: 'en' | 'id',
): Promise<ListPersonRsvpHistoryResult> {
  const guard = await requireActiveAdmin(supabase)
  if (guard.status !== 'ok') return { status: 'not_authorized' }
  if (!UUID_RE.test(personId)) return { status: 'invalid_input' }

  const units = await fetchAllPages<HistoryUnit>('history', (from, to) =>
    supabase
      .from('rsvp_checkin_crosstab')
      .select('rsvp_id, event_instance_id, rsvp_status, children_count, attended')
      .eq('resolved_person_id', personId)
      .not('rsvp_id', 'is', null)
      .order('rsvp_id', { ascending: true })
      .range(from, to),
  )
  if (!units) return { status: 'error', message: 'Failed to fetch RSVP history' }

  const instanceById = new Map<string, HistoryInstance>()
  const instanceIds = [...new Set(units.map(u => u.event_instance_id))]
  for (let i = 0; i < instanceIds.length; i += IN_CHUNK) {
    const { data, error } = await supabase
      .from('event_instances')
      .select('id, event_id, scheduled_at, status, event_name_snapshot, event_name_snapshot_id, event:events(name, name_id)')
      .in('id', instanceIds.slice(i, i + IN_CHUNK))
    if (error) {
      console.error('[listPersonRsvpHistory] instances', error)
      return { status: 'error', message: 'Failed to fetch occurrences' }
    }
    for (const inst of (data ?? []) as unknown as HistoryInstance[]) instanceById.set(inst.id, inst)
  }

  const rows: PersonRsvpHistoryRow[] = []
  for (const u of units) {
    const inst = instanceById.get(u.event_instance_id)
    if (!inst) continue
    rows.push({
      rsvp_id: u.rsvp_id,
      instance_id: inst.id,
      event_id: inst.event_id,
      scheduled_at: inst.scheduled_at,
      instance_status: inst.status,
      display_name: displayInstanceName({
        scheduledAt: new Date(inst.scheduled_at),
        snapshot:    inst.event_name_snapshot,
        snapshotId:  inst.event_name_snapshot_id,
        liveName:    inst.event?.name ?? inst.event_name_snapshot,
        liveNameId:  inst.event?.name_id ?? null,
        locale,
      }),
      rsvp_status: u.rsvp_status,
      children_count: u.children_count,
      attended: u.attended,
    })
  }
  rows.sort((a, b) =>
    new Date(b.scheduled_at).getTime() - new Date(a.scheduled_at).getTime() || a.rsvp_id.localeCompare(b.rsvp_id))

  return { status: 'ok', rows }
}

// ── deleteRsvp ───────────────────────────────────────────────────────────────

/**
 * Junk-delete one RSVP (hard delete — an RSVP is not a `people` row). The
 * audit carries instance, status and whether it was matched at submit —
 * never the phone or name.
 */
export async function impl_deleteRsvp(
  rsvpId: string,
  supabase: SupabaseClient,
): Promise<DeleteRsvpResult> {
  const guard = await requireActiveAdmin(supabase)
  if (guard.status !== 'ok') return { status: 'not_authorized' }
  if (!UUID_RE.test(rsvpId)) return { status: 'invalid_input' }

  const { data: before, error: selErr } = await supabase
    .from('event_rsvps')
    .select('id, event_instance_id, status, person_id')
    .eq('id', rsvpId)
    .maybeSingle()
  if (selErr) {
    console.error('[deleteRsvp] select', selErr)
    return { status: 'error', message: 'Failed to fetch RSVP' }
  }
  if (!before) return { status: 'not_found' }
  const row = before as { id: string; event_instance_id: string; status: RsvpStatus; person_id: string | null }

  const { data: deleted, error: delErr } = await supabase
    .from('event_rsvps')
    .delete()
    .eq('id', rsvpId)
    .select('id')
  if (delErr) {
    console.error('[deleteRsvp] delete', delErr)
    return { status: 'error', message: 'Failed to delete RSVP' }
  }
  if (((deleted ?? []) as unknown[]).length === 0) return { status: 'not_found' }

  await logAudit({
    actorUserId: guard.actorId,
    action:      AUDIT_ACTIONS.RSVP_DELETE,
    entityType:  'event_rsvp',
    entityId:    rsvpId,
    detailsJson: {
      instance_id: row.event_instance_id,
      status: row.status,
      was_matched: row.person_id !== null,
    },
  }, supabase)

  return { status: 'ok' }
}
