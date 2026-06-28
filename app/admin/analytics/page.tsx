import { getTranslations } from 'next-intl/server'
import { parseAnalyticsFilters } from '@/lib/actions/analytics.types'
import {
  getKpiSummary,
  getEventAttendanceTrend,
  getParishBreakdown,
  getTopAttendees,
  getNewVsReturningMonthly,
} from '@/lib/actions/analytics'
import { KpiCards } from './_components/KpiCards'
import { AnalyticsFiltersControls } from './_components/AnalyticsFiltersControls'
import { AnalyticsCharts } from './_components/AnalyticsCharts'
import { TopAttendeesTable } from './_components/TopAttendeesTable'

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function AdminAnalyticsPage({ searchParams }: Props) {
  const params = await searchParams
  const filters = parseAnalyticsFilters(params)
  const t = await getTranslations('admin.analytics')

  const [kpiResult, trendResult, parishResult, parishOptionsResult, nvrResult, topResult] =
    await Promise.all([
      getKpiSummary(filters),
      getEventAttendanceTrend(filters),
      getParishBreakdown(filters),
      getParishBreakdown({}),        // always full list for dropdown options
      getNewVsReturningMonthly(filters),
      getTopAttendees(filters, 10),
    ])

  const kpi         = kpiResult.status === 'ok'    ? kpiResult.data    : null
  const trend       = trendResult.status === 'ok'  ? trendResult.data  : null
  const parish      = parishResult.status === 'ok' ? parishResult.data : null
  const parishOptions = parishOptionsResult.status === 'ok'
    ? parishOptionsResult.data.map(r => r.parish)
    : []
  const nvr         = nvrResult.status === 'ok'    ? nvrResult.data    : null
  const top         = topResult.status === 'ok'    ? topResult.data    : null

  return (
    <main className="px-4 md:px-6 py-8">
      <div className="max-w-5xl mx-auto space-y-8">
        <h1 className="font-heading text-3xl font-semibold text-charcoal">
          {t('title')}
        </h1>

        <AnalyticsFiltersControls
          currentFilters={filters}
          parishOptions={parishOptions}
        />

        <KpiCards
          data={kpi}
          hasError={kpiResult.status === 'error'}
        />

        <AnalyticsCharts
          trend={trend}
          trendHasError={trendResult.status === 'error'}
          parish={parish}
          parishHasError={parishResult.status === 'error'}
          nvr={nvr}
          nvrHasError={nvrResult.status === 'error'}
          labels={{
            trendTitle:   t('chart.trend_title'),
            trendNote:    t('chart.trend_note'),
            trendY:       t('chart.trend_y'),
            parishTitle:  t('chart.parish_title'),
            parishNote:   t('chart.parish_note'),
            nvrTitle:     t('chart.nvr_title'),
            nvrNote:      t('chart.nvr_note'),
            nvrNew:       t('chart.nvr_new'),
            nvrReturning: t('chart.nvr_returning'),
            empty:        t('empty'),
            error:        t('error'),
          }}
        />

        <section>
          <h2 className="font-heading text-xl font-semibold text-charcoal mb-1">
            {t('table.top_title')}
          </h2>
          <p className="text-xs text-muted mb-4">{t('table.top_note')}</p>
          <TopAttendeesTable
            data={top}
            labels={{
              colName:    t('table.col_name'),
              colParish:  t('table.col_parish'),
              colTotal:   t('table.col_total'),
              colEvents:  t('table.col_events'),
              colLast:    t('table.col_last'),
              parishNone: t('table.parish_none'),
            }}
            emptyMessage={t('empty')}
            errorMessage={t('error')}
            hasError={topResult.status === 'error'}
          />
        </section>
      </div>
    </main>
  )
}
