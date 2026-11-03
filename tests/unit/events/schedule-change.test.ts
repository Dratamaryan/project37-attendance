// Unit tests for the S9.5-T5.5 Phase 2 planner (lib/events/schedule-change.ts)
// and the ID/EN confirm + refusal copy (rendered with next-intl's ICU engine).

import { describe, it, expect } from 'vitest'
import { createTranslator } from 'next-intl'
import en from '@/messages/en.json'
import id from '@/messages/id.json'
import { expandRRule } from '@/lib/events/recurrence'
import { formatJakarta, toJakartaInstant } from '@/lib/events/timezone'
import {
  classifyScheduleChange,
  planScheduleChange,
  scheduleDiffers,
  type PlanInstance,
  type ScheduleChangeRefusal,
  type ScheduleFields,
} from '@/lib/events/schedule-change'

const NOW = new Date('2026-11-03T03:00:00.000Z') // Tue 2026-11-03 10:00 WIB
const HORIZON = 12
const RULE = 'FREQ=MONTHLY;BYDAY=2SA'
const R_OLD: ScheduleFields = { start_date: '2026-07-01', start_time: '15:00:00', recurrence_rule: RULE, event_type: 'saturday_monthly' }
const r = (start_time: string): ScheduleFields => ({ ...R_OLD, start_time })

/** What the materializer would have inserted for a schedule, as rows. */
function materialized(s: ScheduleFields, now = NOW, prefix = 'r'): PlanInstance[] {
  const e = expandRRule({ recurrenceRule: s.recurrence_rule, startDate: s.start_date, startTime: s.start_time, horizonMonths: HORIZON, now })
  if (e.status !== 'ok') throw new Error('expand')
  return e.occurrences.map((d, i) => ({ id: `${prefix}${i}`, scheduled_at: d.toISOString(), status: 'scheduled' as const }))
}

const wib = (iso: string) => formatJakarta(new Date(iso), 'yyyy-MM-dd HH:mm')
const plan = (old: ScheduleFields, next: ScheduleFields, instances: PlanInstance[], now = NOW) =>
  planScheduleChange({ old, new: next, instances, horizonMonths: HORIZON, now })

describe('classify / differs', () => {
  it('SCU-01 normalizes HH:mm vs HH:mm:ss and "" vs null', () => {
    expect(scheduleDiffers(R_OLD, { ...R_OLD, start_time: '15:00' })).toBe(false)
    expect(scheduleDiffers({ ...R_OLD, recurrence_rule: null, event_type: 'adhoc' }, { ...R_OLD, recurrence_rule: '', event_type: 'adhoc' })).toBe(false)
    expect(scheduleDiffers(R_OLD, r('16:00'))).toBe(true)
  })

  it('SCU-02 shapes: R = recurring time only; A = adhoc date/time; everything else null', () => {
    expect(classifyScheduleChange(R_OLD, r('16:00'))).toBe('R')
    expect(classifyScheduleChange(R_OLD, { ...r('16:00'), start_date: '2026-07-02' })).toBeNull()
    expect(classifyScheduleChange(R_OLD, { ...R_OLD, start_date: '2026-07-02' })).toBeNull()
    expect(classifyScheduleChange(R_OLD, { ...r('16:00'), recurrence_rule: 'FREQ=MONTHLY;BYDAY=3SA' })).toBeNull()
    expect(classifyScheduleChange(R_OLD, { ...r('16:00'), event_type: 'other_recurring' })).toBeNull()
    const A: ScheduleFields = { start_date: '2026-11-13', start_time: '15:00:00', recurrence_rule: null, event_type: 'adhoc' }
    expect(classifyScheduleChange(A, { ...A, start_date: '2026-11-15' })).toBe('A')
    expect(classifyScheduleChange(A, { ...A, start_time: '17:00' })).toBe('A')
    expect(classifyScheduleChange(A, { ...A, event_type: 'friday_monthly', recurrence_rule: 'FREQ=MONTHLY;BYDAY=2FR' })).toBeNull()
  })
})

describe('R — planner', () => {
  it('SCU-R01 happy path: scheduled + cancelled rule rows move to the same WIB date at 16:00; expected = new materializer slots', () => {
    const rows = materialized(R_OLD)
    rows[3] = { ...rows[3], status: 'cancelled' }
    const p = plan(R_OLD, r('16:00'), rows)
    expect(p.status).toBe('ok')
    if (p.status !== 'ok') return
    expect(p.moved).toBe(rows.length)
    expect(p.cancelled_moved).toBe(1)
    for (const m of p.moves) {
      expect(wib(m.to_at).slice(0, 10)).toBe(wib(m.from_at).slice(0, 10))
      expect(wib(m.to_at).slice(11)).toBe('16:00')
    }
    expect(p.expected).toEqual(materialized(r('16:00')).map(x => x.scheduled_at))
    expect(new Set(p.moves.map(m => m.to_at))).toEqual(new Set(p.expected))
  })

  it('SCU-R02 T4 one-off at the old time on a non-rule date is not moved', () => {
    const rows = materialized(R_OLD)
    const oneOff: PlanInstance = { id: 'oneoff', scheduled_at: toJakartaInstant('2026-11-21', '15:00').toISOString(), status: 'scheduled' }
    const p = plan(R_OLD, r('16:00'), [...rows, oneOff])
    expect(p.status).toBe('ok')
    if (p.status === 'ok') expect(p.moves.map(m => m.id)).not.toContain('oneoff')
  })

  it('SCU-R03 one-off exactly on a new target → slot_taken', () => {
    const rows = materialized(R_OLD)
    const target = toJakartaInstant(wib(rows[2].scheduled_at).slice(0, 10), '16:00').toISOString()
    expect(plan(R_OLD, r('16:00'), [...rows, { id: 'x', scheduled_at: target, status: 'scheduled' }]))
      .toEqual({ status: 'refused', reason: 'slot_taken' })
  })

  it('SCU-R04 pre-07:00 new time → early_time (BYDAY drift: expected slots fall on Sundays)', () => {
    const drifted = materialized(r('06:00'))
    expect(new Set(drifted.map(x => formatJakarta(new Date(x.scheduled_at), 'EEE')))).toEqual(new Set(['Sun']))
    expect(plan(R_OLD, r('06:00'), materialized(R_OLD))).toEqual({ status: 'refused', reason: 'early_time' })
  })

  it('SCU-R05 pre-07:00 old time (drifted rows) → early_time', () => {
    const old = r('06:00:00')
    expect(plan(old, r('15:00'), materialized(old))).toEqual({ status: 'refused', reason: 'early_time' })
  })

  it('SCU-R06 both times ≥ 07:00 but on the 07:00 boundary still lines up', () => {
    const p = plan(R_OLD, r('07:00'), materialized(R_OLD))
    expect(p.status).toBe('ok')
  })

  it('SCU-R07 event day: today\'s occurrence started at the old time, new time ahead → in_progress', () => {
    // 2026-11-14 is 2SA. Now = 15:30 WIB that day; old 15:00 (past), new 16:00 (future).
    const now = new Date('2026-11-14T08:30:00.000Z')
    const rows = materialized(R_OLD, new Date('2026-11-01T00:00:00Z'))
    expect(plan(R_OLD, r('16:00'), rows, now)).toEqual({ status: 'refused', reason: 'in_progress' })
  })

  it('SCU-R08 event day: moving today\'s still-future occurrence behind now → in_progress', () => {
    // Now = 14:30 WIB on 2SA; old 15:00 (future), new 14:00 (past).
    const now = new Date('2026-11-14T07:30:00.000Z')
    const rows = materialized(R_OLD, new Date('2026-11-01T00:00:00Z'))
    expect(plan(R_OLD, r('14:00'), rows, now)).toEqual({ status: 'refused', reason: 'in_progress' })
  })

  it('SCU-R09 tail not materialized yet (missing slots after the last row) → horizon_edge', () => {
    const rows = materialized(R_OLD).slice(0, -2)
    expect(plan(R_OLD, r('16:00'), rows)).toEqual({ status: 'refused', reason: 'horizon_edge' })
  })

  it('SCU-R10 a scheduled row moved past the horizon would be pruned → horizon_edge', () => {
    // Horizon end = 2027-11-03 10:00 WIB. Put a fake rule-less "now" so the last
    // 2SA (2027-11-13) sits just inside when moving later is impossible: use
    // now such that the last slot at 15:00 is inside and 16:00 is outside.
    const now = new Date('2026-11-13T08:30:00.000Z') // 15:30 WIB → horizon end 2027-11-13 15:30 WIB
    const rows = materialized(R_OLD, now)
    expect(wib(rows[rows.length - 1].scheduled_at)).toBe('2027-11-13 15:00')
    expect(plan(R_OLD, r('16:00'), rows, now)).toEqual({ status: 'refused', reason: 'horizon_edge' })
  })

  it('SCU-R11 future rows exist but none on an old slot → nothing_to_move', () => {
    const only: PlanInstance = { id: 'x', scheduled_at: toJakartaInstant('2026-11-21', '15:00').toISOString(), status: 'scheduled' }
    expect(plan(R_OLD, r('16:00'), [only])).toEqual({ status: 'refused', reason: 'nothing_to_move' })
  })

  it('SCU-R12 completed future-dated row is never moved but still blocks its slot', () => {
    const rows = materialized(R_OLD)
    const target = toJakartaInstant(wib(rows[0].scheduled_at).slice(0, 10), '16:00').toISOString()
    expect(plan(R_OLD, r('16:00'), [...rows, { id: 'c', scheduled_at: target, status: 'completed' }]))
      .toEqual({ status: 'refused', reason: 'slot_taken' })
  })

  it('SCU-R13 unsupported shape → unsupported_change', () => {
    expect(plan(R_OLD, { ...r('16:00'), recurrence_rule: 'FREQ=MONTHLY;BYDAY=3SA' }, materialized(R_OLD)))
      .toEqual({ status: 'refused', reason: 'unsupported_change' })
  })
})

describe('A — planner', () => {
  const A: ScheduleFields = { start_date: '2026-11-13', start_time: '15:00:00', recurrence_rule: null, event_type: 'adhoc' }
  const row: PlanInstance = { id: 'a1', scheduled_at: toJakartaInstant('2026-11-13', '15:00').toISOString(), status: 'scheduled' }

  it('SCU-A01 date + time move; expected = the new instant', () => {
    const p = plan(A, { ...A, start_date: '2026-11-20', start_time: '17:30' }, [row])
    expect(p).toMatchObject({ status: 'ok', shape: 'A', moved: 1, cancelled_moved: 0 })
    if (p.status === 'ok') {
      expect(p.moves[0].to_at).toBe(toJakartaInstant('2026-11-20', '17:30').toISOString())
      expect(p.expected).toEqual([p.moves[0].to_at])
    }
  })

  it('SCU-A02 new instant in the past → in_progress; beyond the horizon → beyond_horizon', () => {
    expect(plan(A, { ...A, start_date: '2026-11-02' }, [row])).toEqual({ status: 'refused', reason: 'in_progress' })
    expect(plan(A, { ...A, start_date: '2027-12-13' }, [row])).toEqual({ status: 'refused', reason: 'beyond_horizon' })
  })

  it('SCU-A03 its future row is not at the old instant → nothing_to_move', () => {
    const elsewhere = { ...row, scheduled_at: toJakartaInstant('2026-11-14', '15:00').toISOString() }
    expect(plan(A, { ...A, start_time: '16:00' }, [elsewhere])).toEqual({ status: 'refused', reason: 'nothing_to_move' })
  })
})

// ── Copy (exact strings from the task prompt, rendered with next-intl) ───────

describe('confirm + refusal copy', () => {
  const tId = createTranslator({ locale: 'id', messages: id, namespace: 'admin.events.form.schedule_change' })
  const tEn = createTranslator({ locale: 'en', messages: en, namespace: 'admin.events.form.schedule_change' })

  it('SCU-C01 ID recurring: exact prompt copy (with and without cancelled)', () => {
    expect(tId('confirm_body_recurring', { count: 13, time: '16:00', cancelled: 1 })).toBe(
      '13 sesi akan dipindah ke 16:00 pada tanggal yang sama (termasuk 1 sesi yang dibatalkan). ID sesi, link RSVP dan RSVP tetap sama. Undangan yang sudah terkirim tidak diperbarui otomatis.',
    )
    expect(tId('confirm_body_recurring', { count: 12, time: '16:00', cancelled: 0 })).toBe(
      '12 sesi akan dipindah ke 16:00 pada tanggal yang sama. ID sesi, link RSVP dan RSVP tetap sama. Undangan yang sudah terkirim tidak diperbarui otomatis.',
    )
  })

  it('SCU-C02 EN recurring: plural + cancelled clause', () => {
    expect(tEn('confirm_body_recurring', { count: 13, time: '16:00', cancelled: 1 })).toBe(
      '13 sessions will move to 16:00 on the same date (including 1 cancelled). Session IDs, RSVP links and RSVPs stay the same. Invitations already sent are not updated automatically.',
    )
    expect(tEn('confirm_body_recurring', { count: 1, time: '16:00', cancelled: 0 })).toBe(
      '1 session will move to 16:00 on the same date. Session IDs, RSVP links and RSVPs stay the same. Invitations already sent are not updated automatically.',
    )
  })

  it('SCU-C03 adhoc variant ID/EN', () => {
    expect(tId('confirm_body_adhoc', { date: 'Jumat, 20 November 2026', time: '17:30' })).toBe(
      'Sesi akan dipindah ke Jumat, 20 November 2026 17:30. ID sesi, link RSVP dan RSVP tetap sama. Undangan yang sudah terkirim tidak diperbarui otomatis.',
    )
    expect(tEn('confirm_body_adhoc', { date: 'Friday, November 20, 2026', time: '17:30' })).toBe(
      'The session will move to Friday, November 20, 2026 17:30. Session ID, RSVP link and RSVPs stay the same. Invitations already sent are not updated automatically.',
    )
  })

  it('SCU-C04 every refusal reason has an ID and EN message', () => {
    const reasons: ScheduleChangeRefusal[] = [
      'not_admin', 'stale', 'unsupported_change', 'nothing_to_move', 'early_time', 'in_progress',
      'horizon_edge', 'beyond_horizon', 'slots_mismatch', 'slot_taken', 'unknown',
    ]
    for (const r of reasons) {
      for (const t of [tId, tEn]) {
        const msg = t(`errors.${r}`)
        expect(msg, r).not.toContain('errors.')
        expect(msg.length, r).toBeGreaterThan(20)
      }
    }
    expect(Object.keys(en.admin.events.form.schedule_change.errors).sort()).toEqual([...reasons].sort())
    expect(Object.keys(id.admin.events.form.schedule_change.errors).sort()).toEqual([...reasons].sort())
  })

  it('SCU-C05 organizer contact line (ID exact)', () => {
    const t = createTranslator({ locale: 'id', messages: id, namespace: 'admin.events.form' })
    expect(t('schedule_locked_contact_admin')).toBe('Hubungi admin untuk mengubah jadwal')
  })
})
