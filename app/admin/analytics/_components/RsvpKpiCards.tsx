'use client'

import { useTranslations } from 'next-intl'
import type { RsvpKpis } from '@/lib/actions/rsvp-analytics.types'

type Props = {
  data: RsvpKpis | null
  hasError: boolean
}

type Metric = {
  key: string
  label: string
  subtitle?: string
  testId: string
  value: number | null | undefined
  kind: 'count' | 'percent'
}

function formatValue(value: number | null | undefined, kind: Metric['kind']): string {
  if (value === null || value === undefined) return '—'
  return kind === 'percent' ? `${Math.round(value * 100)}%` : String(value)
}

export function RsvpKpiCards({ data, hasError }: Props) {
  const t = useTranslations('admin.analytics.rsvp')

  // Show-up and no-show share a denominator; derive the displayed no-show from
  // the rounded show-up so the pair always reads as 100% (2/3, 1/3 -> 67% / 33%).
  const noShow =
    data?.show_up_rate != null && data.no_show_rate != null
      ? (100 - Math.round(data.show_up_rate * 100)) / 100
      : data?.no_show_rate

  const metrics: Metric[] = [
    { key: 'coming_headcount', label: t('kpi.coming_headcount'), subtitle: t('kpi.coming_headcount_note'), testId: 'rsvp-kpi-coming-headcount', value: data?.coming_headcount, kind: 'count' },
    { key: 'coming_people', label: t('kpi.coming_people'), testId: 'rsvp-kpi-coming-people', value: data?.coming_people, kind: 'count' },
    { key: 'maybe_people', label: t('kpi.maybe_people'), testId: 'rsvp-kpi-maybe-people', value: data?.maybe_people, kind: 'count' },
    { key: 'actual_adults', label: t('kpi.actual_adults'), testId: 'rsvp-kpi-actual-adults', value: data?.actual_adults, kind: 'count' },
    { key: 'actual_children', label: t('kpi.actual_children'), testId: 'rsvp-kpi-actual-children', value: data?.actual_children, kind: 'count' },
    { key: 'show_up_rate', label: t('kpi.show_up_rate'), subtitle: t('kpi.show_up_rate_note'), testId: 'rsvp-kpi-show-up-rate', value: data?.show_up_rate, kind: 'percent' },
    { key: 'no_show_rate', label: t('kpi.no_show_rate'), subtitle: t('kpi.no_show_rate_note'), testId: 'rsvp-kpi-no-show-rate', value: noShow, kind: 'percent' },
    { key: 'walk_in_share', label: t('kpi.walk_in_share'), subtitle: t('kpi.walk_in_share_note'), testId: 'rsvp-kpi-walk-in-share', value: data?.walk_in_share, kind: 'percent' },
    { key: 'newcomer_rsvps', label: t('kpi.newcomer_rsvps'), testId: 'rsvp-kpi-newcomer-rsvps', value: data?.newcomer_rsvps, kind: 'count' },
    { key: 'became_members', label: t('kpi.became_members'), subtitle: t('kpi.became_members_note'), testId: 'rsvp-kpi-became-members', value: data?.became_members, kind: 'count' },
    { key: 'funnel_response_rate', label: t('kpi.funnel_response_rate'), subtitle: t('kpi.funnel_note'), testId: 'rsvp-kpi-funnel-response-rate', value: data?.funnel_response_rate, kind: 'percent' },
    { key: 'funnel_attendance_rate', label: t('kpi.funnel_attendance_rate'), subtitle: t('kpi.funnel_note'), testId: 'rsvp-kpi-funnel-attendance-rate', value: data?.funnel_attendance_rate, kind: 'percent' },
  ]

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      {metrics.map(m => (
        <div key={m.key} className="bg-cream-2 border border-line rounded-sm p-4">
          <p className="text-xs font-medium text-muted mb-1">{m.label}</p>
          <p
            className="font-heading text-2xl font-semibold text-charcoal"
            data-testid={m.testId}
          >
            {hasError ? '—' : formatValue(m.value, m.kind)}
          </p>
          {m.subtitle && <p className="text-xs text-muted mt-1">{m.subtitle}</p>}
        </div>
      ))}
    </div>
  )
}
