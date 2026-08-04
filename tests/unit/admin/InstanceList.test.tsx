// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { groupInstances, InstanceList } from '@/app/admin/events/_components/InstanceList'
import type { EventInstanceRow, EventRow } from '@/lib/actions/events.types'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale:       () => 'en',
}))

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    <a href={href}>{children}</a>,
}))

// ── Fixtures ──────────────────────────────────────────────────────────────────

const EVENT: EventRow = {
  id: 'event-001',
  name: 'Project Day',
  name_id: 'Hari Project',
  event_type: 'friday_monthly',
  start_date: '2026-07-10',
  start_time: '18:00:00',
  duration_min: 120,
  location: 'Hotel Neo',
  description: null,
  recurrence_rule: 'FREQ=MONTHLY;BYDAY=2FR',
  active: true,
  created_by: 'user-001',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

function makeInstance(overrides: Partial<EventInstanceRow> = {}): EventInstanceRow {
  return {
    id: 'inst-001',
    event_id: 'event-001',
    scheduled_at: '2026-07-10T11:00:00Z',
    event_name_snapshot: 'Project Day',
    event_name_snapshot_id: 'Hari Project',
    status: 'scheduled',
    notes: null,
    image_url: null,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

const NOW = new Date('2026-06-13T10:00:00Z')

// Clearly past and future relative to NOW
const PAST_DATE    = '2020-01-10T11:00:00Z'
const FUTURE_DATE  = '2090-07-11T11:00:00Z'
const FUTURE_DATE2 = '2090-08-08T11:00:00Z'

// ── groupInstances unit tests ─────────────────────────────────────────────────

describe('groupInstances', () => {
  it('IL-01a: groups scheduled past instances into past', () => {
    const inst = makeInstance({ scheduled_at: PAST_DATE, status: 'scheduled' })
    const { upcoming, past, cancelled } = groupInstances([inst], NOW)
    expect(past).toHaveLength(1)
    expect(upcoming).toHaveLength(0)
    expect(cancelled).toHaveLength(0)
  })

  it('IL-01b: groups scheduled future instances into upcoming', () => {
    const inst = makeInstance({ scheduled_at: FUTURE_DATE, status: 'scheduled' })
    const { upcoming, past, cancelled } = groupInstances([inst], NOW)
    expect(upcoming).toHaveLength(1)
    expect(past).toHaveLength(0)
    expect(cancelled).toHaveLength(0)
  })

  it('IL-01c: groups cancelled instances into cancelled regardless of date', () => {
    const pastCancelled   = makeInstance({ id: 'c1', scheduled_at: PAST_DATE, status: 'cancelled' })
    const futureCancelled = makeInstance({ id: 'c2', scheduled_at: FUTURE_DATE, status: 'cancelled' })
    const { cancelled } = groupInstances([pastCancelled, futureCancelled], NOW)
    expect(cancelled).toHaveLength(2)
  })

  it('IL-02a: past sorted DESC (most recent first)', () => {
    const older  = makeInstance({ id: 'p1', scheduled_at: '2019-01-01T11:00:00Z', status: 'scheduled' })
    const newer  = makeInstance({ id: 'p2', scheduled_at: '2020-06-01T11:00:00Z', status: 'scheduled' })
    const { past } = groupInstances([older, newer], NOW)
    expect(past[0].id).toBe('p2')  // newer first
    expect(past[1].id).toBe('p1')
  })

  it('IL-02b: upcoming sorted ASC (nearest first)', () => {
    const later  = makeInstance({ id: 'u1', scheduled_at: FUTURE_DATE2, status: 'scheduled' })
    const sooner = makeInstance({ id: 'u2', scheduled_at: FUTURE_DATE,  status: 'scheduled' })
    const { upcoming } = groupInstances([later, sooner], NOW)
    expect(upcoming[0].id).toBe('u2')  // sooner first
    expect(upcoming[1].id).toBe('u1')
  })
})

// ── InstanceList component tests ──────────────────────────────────────────────

describe('InstanceList', () => {
  it('IL-01: renders three group sections', () => {
    const pastInst = makeInstance({
      id: 'p1',
      scheduled_at: PAST_DATE,
      status: 'scheduled',
    })
    const futureInst = makeInstance({
      id: 'u1',
      scheduled_at: FUTURE_DATE,
      status: 'scheduled',
    })
    const cancelledInst = makeInstance({
      id: 'c1',
      scheduled_at: PAST_DATE,
      status: 'cancelled',
    })

    render(
      <InstanceList
        instances={[pastInst, futureInst, cancelledInst]}
        event={EVENT}
        eventId="event-001"
      />,
    )

    expect(screen.getByRole('region', { name: 'group.upcoming' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'group.past' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'group.cancelled' })).toBeInTheDocument()
  })

  it('IL-03: past instance shows snapshot name; future shows live event name (EN locale)', () => {
    const pastInst = makeInstance({
      id: 'p1',
      scheduled_at: PAST_DATE,
      status: 'scheduled',
      event_name_snapshot: 'Old Name',
      event_name_snapshot_id: 'Nama Lama',
    })
    const futureInst = makeInstance({
      id: 'u1',
      scheduled_at: FUTURE_DATE,
      status: 'scheduled',
      event_name_snapshot: 'Old Name',
      event_name_snapshot_id: 'Nama Lama',
    })

    // Live name is 'Project Day' from EVENT fixture
    render(
      <InstanceList
        instances={[pastInst, futureInst]}
        event={EVENT}
        eventId="event-001"
      />,
    )

    // Past: snapshot
    expect(screen.getByText('Old Name')).toBeInTheDocument()
    // Future: live name
    expect(screen.getByText('Project Day')).toBeInTheDocument()
  })
})
