'use client'

import { useTranslations } from 'next-intl'
import type { KpiSummary } from '@/lib/actions/analytics.types'

type Props = {
  data: KpiSummary | null
  hasError: boolean
}

export function KpiCards({ data, hasError }: Props) {
  const t = useTranslations('admin.analytics')

  const metrics = [
    {
      key: 'total_checkins' as const,
      label: t('kpi.total_checkins'),
      testId: 'kpi-total-checkins',
      value: data?.total_checkins,
    },
    {
      key: 'distinct_people' as const,
      label: t('kpi.distinct_people'),
      testId: 'kpi-distinct-people',
      value: data?.distinct_people,
    },
    {
      key: 'distinct_events' as const,
      label: t('kpi.distinct_events'),
      testId: 'kpi-distinct-events',
      value: data?.distinct_events,
    },
    {
      key: 'distinct_instances' as const,
      label: t('kpi.distinct_instances'),
      testId: 'kpi-distinct-instances',
      value: data?.distinct_instances,
    },
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
            {hasError || m.value === undefined ? '—' : m.value}
          </p>
        </div>
      ))}
    </div>
  )
}
