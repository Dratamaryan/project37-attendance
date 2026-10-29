// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RsvpSection } from '../RsvpSection'
import { RsvpKpiCards } from '../RsvpKpiCards'
import type { RsvpAnalytics, RsvpKpis } from '@/lib/actions/rsvp-analytics.types'

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))
// The chart is a dynamic(ssr:false) Recharts import — stub the client boundary.
vi.mock('../AnalyticsCharts', () => ({
  AnalyticsRsvpChart: ({ data }: { data: unknown[] }) => <div data-testid="rsvp-chart-stub">{data.length}</div>,
}))

const KPIS: RsvpKpis = {
  instances: 2,
  coming_headcount: 6,
  coming_people: 3,
 
  actual_adults: 6,
  actual_children: 3,
  show_up_rate: 2 / 3,
  no_show_rate: 1 / 3,
  walk_in_share: 0.5,
  newcomer_rsvps: 2,
  became_members: 1,
  funnel_response_rate: null,
  funnel_attendance_rate: 0.5,
}

const DATA: RsvpAnalytics = {
  kpis: KPIS,
  rows: [
    {
      event_instance_id: 'i1', event_id: 'e', event_type: 'adhoc',
      scheduled_at: '2026-10-02T12:00:00+00:00', ended_at: '2026-10-02T14:00:00+00:00', scheduled_date: '2026-10-02',
      coming_people: 3, coming_headcount: 6, coming_came: 2, coming_no_show: 1,
      walk_ins: 2, actual_adults: 5, actual_children: 3, newcomer_rsvps: 2, became_members: 1,
      invited: 4, invited_responded: 2, invited_attended: 2,
    },
  ],
}

describe('RsvpKpiCards', () => {
  it('renders counts, rounded percentages, and — for a null rate', () => {
    render(<RsvpKpiCards data={KPIS} hasError={false} />)
    expect(screen.getByTestId('rsvp-kpi-coming-headcount')).toHaveTextContent('6')
    expect(screen.getByTestId('rsvp-kpi-actual-children')).toHaveTextContent('3')
    expect(screen.getByTestId('rsvp-kpi-show-up-rate')).toHaveTextContent('67%')
    expect(screen.getByTestId('rsvp-kpi-no-show-rate')).toHaveTextContent('33%')
    expect(screen.getByTestId('rsvp-kpi-walk-in-share')).toHaveTextContent('50%')
    expect(screen.getByTestId('rsvp-kpi-funnel-response-rate')).toHaveTextContent('—')
    expect(screen.getByTestId('rsvp-kpi-funnel-attendance-rate')).toHaveTextContent('50%')
  })

  it('S9.5-T5: no Maybe card — coming-derived figures only', () => {
    render(<RsvpKpiCards data={KPIS} hasError={false} />)
    expect(screen.queryByTestId('rsvp-kpi-maybe-people')).toBeNull()
    expect(screen.queryByText('kpi.maybe_people')).toBeNull()
    expect(screen.getByTestId('rsvp-kpi-coming-people')).toHaveTextContent('3')
  })

  it('show-up and no-show always sum to 100%: 2/3 vs 1/3 -> 67% / 33%; 0.125 vs 0.875 -> 13% / 87%', () => {
    const { unmount } = render(<RsvpKpiCards data={KPIS} hasError={false} />)
    expect(screen.getByTestId('rsvp-kpi-show-up-rate')).toHaveTextContent('67%')
    expect(screen.getByTestId('rsvp-kpi-no-show-rate')).toHaveTextContent('33%')
    unmount()
    // independent rounding would give 13% + 88% = 101%
    render(<RsvpKpiCards data={{ ...KPIS, show_up_rate: 0.125, no_show_rate: 0.875 }} hasError={false} />)
    expect(screen.getByTestId('rsvp-kpi-show-up-rate')).toHaveTextContent('13%')
    expect(screen.getByTestId('rsvp-kpi-no-show-rate')).toHaveTextContent('87%')
  })

  it('became_members carries the "as of last submit" subtitle', () => {
    render(<RsvpKpiCards data={KPIS} hasError={false} />)
    const card = screen.getByTestId('rsvp-kpi-became-members').parentElement!
    expect(card).toHaveTextContent('kpi.became_members_note')
  })

  it('hasError -> every value is —', () => {
    render(<RsvpKpiCards data={KPIS} hasError={true} />)
    expect(screen.getByTestId('rsvp-kpi-coming-headcount')).toHaveTextContent('—')
    expect(screen.getByTestId('rsvp-kpi-show-up-rate')).toHaveTextContent('—')
  })
})

describe('RsvpSection', () => {
  it('with rows: cards + chart, instance count in the note', () => {
    render(<RsvpSection data={DATA} hasError={false} />)
    expect(screen.getByTestId('rsvp-kpi-coming-headcount')).toHaveTextContent('6')
    expect(screen.getByTestId('rsvp-chart-stub')).toHaveTextContent('1')
    expect(screen.getByText('note_count:{"count":2}')).toBeInTheDocument()
    expect(screen.queryByTestId('rsvp-empty')).toBeNull()
  })

  it('no instances -> empty state, no cards, no chart', () => {
    render(<RsvpSection data={{ kpis: { ...KPIS, instances: 0 }, rows: [] }} hasError={false} />)
    expect(screen.getByTestId('rsvp-empty')).toHaveTextContent('empty')
    expect(screen.queryByTestId('rsvp-kpi-coming-headcount')).toBeNull()
    expect(screen.queryByTestId('rsvp-chart-stub')).toBeNull()
  })

  it('error -> error message, no cards', () => {
    render(<RsvpSection data={null} hasError={true} />)
    expect(screen.getByText('error')).toBeInTheDocument()
    expect(screen.queryByTestId('rsvp-kpi-coming-headcount')).toBeNull()
  })
})
