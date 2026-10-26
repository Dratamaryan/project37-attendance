'use client'

import { type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import type { RsvpAnalytics } from '@/lib/actions/rsvp-analytics.types'
import { RsvpKpiCards } from './RsvpKpiCards'
import { AnalyticsRsvpChart } from './AnalyticsCharts'

type Props = {
  data: RsvpAnalytics | null
  hasError: boolean
}

// S9-R7 RSVP section: pooled KPI cards + RSVP-vs-actual chart over the
// ended, non-cancelled instances with an RSVP link in the filter range.
export function RsvpSection({ data, hasError }: Props) {
  const t = useTranslations('admin.analytics.rsvp')

  let body: ReactNode
  if (hasError) {
    body = <p className="text-sm text-muted py-8 text-center">{t('error')}</p>
  } else if (!data || data.rows.length === 0) {
    body = (
      <p className="text-sm text-muted py-8 text-center" data-testid="rsvp-empty">
        {t('empty')}
      </p>
    )
  } else {
    body = (
      <div className="space-y-6">
        <RsvpKpiCards data={data.kpis} hasError={false} />
        <div>
          <h3 className="font-heading text-lg font-semibold text-charcoal mb-1">
            {t('chart.title')}
          </h3>
          <p className="text-xs text-muted mb-4">{t('chart.note')}</p>
          <AnalyticsRsvpChart
            data={data.rows}
            hasError={false}
            labels={{
              coming:   t('chart.coming'),
              adults:   t('chart.adults'),
              children: t('chart.children'),
              empty:    t('empty'),
              error:    t('error'),
            }}
          />
        </div>
      </div>
    )
  }

  return (
    <section data-testid="rsvp-section">
      <h2 className="font-heading text-xl font-semibold text-charcoal mb-1">
        {t('title')}
      </h2>
      <p className="text-xs text-muted mb-4">
        {data && !hasError ? t('note_count', { count: data.kpis.instances }) : t('note')}
      </p>
      {body}
    </section>
  )
}
