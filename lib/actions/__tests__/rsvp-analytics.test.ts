// Unit tests for S9-R7 RSVP analytics pure helpers: pooled KPIs (Σ/Σ, null on
// zero denominators, funnel over invited > 0) and Asia/Jakarta date bounds.
import { describe, it, expect } from 'vitest'
import { jakartaScheduledRange, poolRsvpMetrics } from '../rsvp-analytics.impl'
import type { RsvpInstanceMetricsRow } from '../rsvp-analytics.types'

function row(over: Partial<RsvpInstanceMetricsRow>): RsvpInstanceMetricsRow {
  return {
    event_instance_id: 'i', event_id: 'e', event_type: 'adhoc',
    scheduled_at: '2026-10-02T12:00:00+00:00', ended_at: '2026-10-02T14:00:00+00:00',
    coming_people: 0, coming_headcount: 0, coming_came: 0, coming_no_show: 0,
    walk_ins: 0, actual_adults: 0, actual_children: 0, newcomer_rsvps: 0, became_members: 0,
    invited: 0, invited_responded: 0, invited_attended: 0,
    ...over,
  }
}

describe('poolRsvpMetrics', () => {
  it('pools Σ numerator / Σ denominator, not a mean of per-instance rates', () => {
    const kpis = poolRsvpMetrics([
      row({ coming_people: 1, coming_came: 1, coming_headcount: 3, actual_adults: 1, walk_ins: 0 }),
      row({ coming_people: 9, coming_came: 0, coming_no_show: 9, coming_headcount: 9, actual_adults: 3, walk_ins: 3 }),
    ])
    // mean of per-instance show-up rates would be (1 + 0) / 2 = 0.5
    expect(kpis.show_up_rate).toBeCloseTo(1 / 10)
    expect(kpis.no_show_rate).toBeCloseTo(9 / 10)
    expect(kpis.walk_in_share).toBeCloseTo(3 / 4)
    expect(kpis.coming_headcount).toBe(12)
    expect(kpis.coming_people).toBe(10)
    expect(kpis.instances).toBe(2)
  })

  it('recon I1 + I2 rows pool to the hand numbers', () => {
    const kpis = poolRsvpMetrics([
      row({
        coming_people: 3, coming_headcount: 6, coming_came: 2, coming_no_show: 1,
        walk_ins: 2, actual_adults: 5, actual_children: 3, newcomer_rsvps: 2, became_members: 1,
        invited: 4, invited_responded: 2, invited_attended: 2,
      }),
      row({ walk_ins: 1, actual_adults: 1 }),
    ])
    expect(kpis).toEqual({
      instances: 2,
      coming_headcount: 6,
      coming_people: 3,
     
      actual_adults: 6,
      actual_children: 3,
      show_up_rate: 2 / 3,
      no_show_rate: 1 / 3,
      walk_in_share: 3 / 6,
      newcomer_rsvps: 2,
      became_members: 1,
      funnel_response_rate: 2 / 4,
      funnel_attendance_rate: 2 / 4,
    })
  })

  it('zero denominators -> null rates; counts stay 0', () => {
    const kpis = poolRsvpMetrics([row({})])
    expect(kpis.show_up_rate).toBeNull()
    expect(kpis.no_show_rate).toBeNull()
    expect(kpis.walk_in_share).toBeNull()
    expect(kpis.funnel_response_rate).toBeNull()
    expect(kpis.funnel_attendance_rate).toBeNull()
    expect(kpis.coming_headcount).toBe(0)
  })

  it('no rows -> instances 0 and every rate null', () => {
    const kpis = poolRsvpMetrics([])
    expect(kpis.instances).toBe(0)
    expect([kpis.show_up_rate, kpis.no_show_rate, kpis.walk_in_share,
      kpis.funnel_response_rate, kpis.funnel_attendance_rate]).toEqual([null, null, null, null, null])
  })

  it('funnel rates only pool instances with invited > 0', () => {
    const kpis = poolRsvpMetrics([
      row({ invited: 2, invited_responded: 1, invited_attended: 2 }),
      row({ invited: 0, coming_people: 5, coming_came: 5 }),
    ])
    expect(kpis.funnel_response_rate).toBe(0.5)
    expect(kpis.funnel_attendance_rate).toBe(1)
    expect(kpis.show_up_rate).toBe(1)
  })
})

describe('jakartaScheduledRange', () => {
  it('from -> 00:00 WIB that day; to -> 00:00 WIB the next day (exclusive)', () => {
    expect(jakartaScheduledRange({ from: '2026-10-01', to: '2026-10-31' })).toEqual({
      gte: '2026-09-30T17:00:00.000Z',
      lt: '2026-10-31T17:00:00.000Z',
    })
  })

  it('an instance at 2026-10-31 23:30 WIB is inside to=2026-10-31; 2026-11-01 00:00 WIB is not', () => {
    const { lt } = jakartaScheduledRange({ to: '2026-10-31' })
    const lateEvening = new Date('2026-10-31T23:30:00+07:00').getTime()
    const nextMidnight = new Date('2026-11-01T00:00:00+07:00').getTime()
    expect(lateEvening < Date.parse(lt!)).toBe(true)
    expect(nextMidnight < Date.parse(lt!)).toBe(false)
  })

  it('an instance at 2026-10-01 00:30 WIB (Sep 30 UTC) is inside from=2026-10-01', () => {
    const { gte } = jakartaScheduledRange({ from: '2026-10-01' })
    const earlyMorning = new Date('2026-10-01T00:30:00+07:00').getTime()
    expect(earlyMorning >= Date.parse(gte!)).toBe(true)
    expect(new Date('2026-09-30T23:59:00+07:00').getTime() >= Date.parse(gte!)).toBe(false)
  })

  it('month-end rollover: to=2026-12-31 -> 2027-01-01 00:00 WIB', () => {
    expect(jakartaScheduledRange({ to: '2026-12-31' })).toEqual({ lt: '2026-12-31T17:00:00.000Z' })
  })

  it('no filters -> no bounds', () => {
    expect(jakartaScheduledRange({})).toEqual({})
  })
})
