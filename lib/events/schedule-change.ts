// S9.5-T5.5 Phase 2 — schedule-edit propagation planner (pure, no I/O).
//
// Two moves are supported while an event has upcoming occurrences:
//   R  recurring event: start_time changes (start_date, recurrence_rule,
//      event_type unchanged) → every future occurrence on an OLD rule slot
//      moves to the same WIB date at the new time.
//   A  adhoc event: start_date and/or start_time change → its future
//      occurrence at the old start instant moves to the new instant.
//
// `expected` is the NEW schedule's slots exactly as the materializer computes
// them (expandRRule over [max(now, newStart), now + horizon]). The plan is
// refused unless every expected slot is covered by a move target or by another
// existing row — i.e. unless the next materializer run would insert 0. That
// one check covers the UTC-BYDAY drift of pre-07:00 WIB times, an occurrence
// today that has already started, and a horizon tail the materializer has not
// filled yet. public.apply_event_schedule_change() re-checks the moves and
// post-asserts the expected slots in SQL.

import { addMonths, differenceInMonths } from 'date-fns'
import { expandRRule } from './recurrence'
import { formatJakarta, toJakartaInstant } from './timezone'

export type ScheduleFields = {
  start_date: string            // YYYY-MM-DD
  start_time: string            // HH:mm or HH:mm:ss
  recurrence_rule: string | null
  event_type: string
}

export type PlanInstance = {
  id: string
  scheduled_at: string          // ISO timestamptz
  status: 'scheduled' | 'cancelled' | 'completed'
}

export type ScheduleMove = {
  id: string
  from_at: string               // ISO (UTC)
  to_at: string                 // ISO (UTC)
  status: 'scheduled' | 'cancelled'
}

export type ScheduleChangeShape = 'R' | 'A'

export type ScheduleChangeRefusal =
  | 'not_admin'
  | 'stale'
  | 'unsupported_change'
  | 'nothing_to_move'
  | 'early_time'
  | 'in_progress'
  | 'horizon_edge'
  | 'beyond_horizon'
  | 'slots_mismatch'
  | 'slot_taken'
  | 'unknown'

export type SchedulePlan =
  | {
      status: 'ok'
      shape: ScheduleChangeShape
      moves: ScheduleMove[]
      expected: string[]        // ISO (UTC), sorted
      moved: number
      cancelled_moved: number
    }
  | { status: 'refused'; reason: ScheduleChangeRefusal }

/** 'HH:mm' or 'HH:mm:ss' → 'HH:mm:ss'. */
export function normalizeTime(t: string): string {
  return t.length === 5 ? `${t}:00` : t
}

/** '' and undefined → null, otherwise the string unchanged. */
export function normalizeRule(r: string | null | undefined): string | null {
  return r === undefined || r === null || r === '' ? null : r
}

export function scheduleDiffers(a: ScheduleFields, b: ScheduleFields): boolean {
  return (
    a.start_date !== b.start_date ||
    normalizeTime(a.start_time) !== normalizeTime(b.start_time) ||
    normalizeRule(a.recurrence_rule) !== normalizeRule(b.recurrence_rule) ||
    a.event_type !== b.event_type
  )
}

/** R / A / null (any other change stays locked). Assumes `scheduleDiffers`. */
export function classifyScheduleChange(
  oldS: ScheduleFields,
  newS: ScheduleFields,
): ScheduleChangeShape | null {
  if (newS.event_type !== oldS.event_type) return null
  if (normalizeRule(newS.recurrence_rule) !== normalizeRule(oldS.recurrence_rule)) return null
  const rule = normalizeRule(oldS.recurrence_rule)
  const timeChanged = normalizeTime(newS.start_time) !== normalizeTime(oldS.start_time)
  if (oldS.event_type !== 'adhoc' && rule !== null) {
    return newS.start_date === oldS.start_date && timeChanged ? 'R' : null
  }
  if (oldS.event_type === 'adhoc' && rule === null) {
    return newS.start_date !== oldS.start_date || timeChanged ? 'A' : null
  }
  return null
}

const EARLY_WIB = '07:00:00' // before this, a WIB wall time is the previous UTC day

export function planScheduleChange(input: {
  old: ScheduleFields
  new: ScheduleFields
  /** Every row of the event (any status, any time). */
  instances: PlanInstance[]
  horizonMonths: number
  now: Date
}): SchedulePlan {
  const { old: oldS, new: newS, instances, horizonMonths, now } = input
  const shape = classifyScheduleChange(oldS, newS)
  if (!shape) return { status: 'refused', reason: 'unsupported_change' }

  const nowMs = now.getTime()
  const horizonEnd = addMonths(now, horizonMonths).getTime()
  const future = instances.filter(
    i => Date.parse(i.scheduled_at) > nowMs && (i.status === 'scheduled' || i.status === 'cancelled'),
  )
  const newTime = normalizeTime(newS.start_time)

  // ── Old slots ─────────────────────────────────────────────────────────────
  // Same expansion as the materializer, but the window is stretched to the
  // last future row so a cancelled row beyond the horizon still counts as a
  // rule slot (otherwise it would be left behind at the old time).
  let oldSlots: Set<number>
  if (shape === 'R') {
    const lastMs = future.reduce((m, i) => Math.max(m, Date.parse(i.scheduled_at)), nowMs)
    const span = Math.max(horizonMonths, differenceInMonths(new Date(lastMs), now) + 1)
    const r = expandRRule({
      recurrenceRule: oldS.recurrence_rule,
      startDate: oldS.start_date,
      startTime: oldS.start_time,
      horizonMonths: span,
      now,
    })
    if (r.status !== 'ok') return { status: 'refused', reason: 'unsupported_change' }
    oldSlots = new Set(r.occurrences.map(d => d.getTime()))
  } else {
    oldSlots = new Set([toJakartaInstant(oldS.start_date, oldS.start_time).getTime()])
  }

  // ── Moves ─────────────────────────────────────────────────────────────────
  const moves: ScheduleMove[] = []
  for (const row of future) {
    const fromMs = Date.parse(row.scheduled_at)
    if (!oldSlots.has(fromMs)) continue // T4 one-off (or any non-slot row): stays
    const to =
      shape === 'R'
        ? toJakartaInstant(formatJakarta(new Date(fromMs), 'yyyy-MM-dd'), newTime)
        : toJakartaInstant(newS.start_date, newTime)
    moves.push({
      id: row.id,
      from_at: new Date(fromMs).toISOString(),
      to_at: to.toISOString(),
      status: row.status as 'scheduled' | 'cancelled',
    })
  }
  if (moves.length === 0) return { status: 'refused', reason: 'nothing_to_move' }

  // ── Expected: the new schedule as the materializer will compute it ───────
  const exp = expandRRule({
    recurrenceRule: shape === 'R' ? newS.recurrence_rule : null,
    startDate: newS.start_date,
    startTime: newTime,
    horizonMonths,
    now,
  })
  if (exp.status !== 'ok') return { status: 'refused', reason: 'unsupported_change' }
  const expected = exp.occurrences.map(d => d.getTime()).sort((a, b) => a - b)

  // ── Pre-flight ────────────────────────────────────────────────────────────
  const movedIds = new Set(moves.map(m => m.id))
  const others = new Set(
    instances.filter(i => !movedIds.has(i.id)).map(i => Date.parse(i.scheduled_at)),
  )
  const targets = new Set(moves.map(m => Date.parse(m.to_at)))

  // A target in the past: the occurrence would move behind "now" (today,
  // earlier than the current time).
  if (moves.some(m => Date.parse(m.to_at) <= nowMs)) {
    return { status: 'refused', reason: 'in_progress' }
  }
  // Collisions: with a row that stays, or two moves onto one slot.
  if (targets.size !== moves.length || [...targets].some(t => others.has(t))) {
    return { status: 'refused', reason: 'slot_taken' }
  }
  // A scheduled row moved past the horizon would be hard-deleted by the
  // materializer's prune.
  if (moves.some(m => m.status === 'scheduled' && Date.parse(m.to_at) > horizonEnd)) {
    return { status: 'refused', reason: shape === 'A' ? 'beyond_horizon' : 'horizon_edge' }
  }

  const missing = expected.filter(s => !targets.has(s) && !others.has(s))
  if (missing.length > 0) {
    if (shape === 'R' && (normalizeTime(oldS.start_time) < EARLY_WIB || newTime < EARLY_WIB)) {
      return { status: 'refused', reason: 'early_time' }
    }
    const todayWib = formatJakarta(now, 'yyyy-MM-dd')
    if (missing.some(s => formatJakarta(new Date(s), 'yyyy-MM-dd') === todayWib)) {
      return { status: 'refused', reason: 'in_progress' }
    }
    const lastExisting = instances.reduce((m, i) => Math.max(m, Date.parse(i.scheduled_at)), 0)
    if (missing.every(s => s > lastExisting)) {
      return { status: 'refused', reason: 'horizon_edge' }
    }
    return { status: 'refused', reason: 'slots_mismatch' }
  }

  return {
    status: 'ok',
    shape,
    moves,
    expected: expected.map(s => new Date(s).toISOString()),
    moved: moves.length,
    cancelled_moved: moves.filter(m => m.status === 'cancelled').length,
  }
}
