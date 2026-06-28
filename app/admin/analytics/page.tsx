import { getTranslations } from 'next-intl/server'
import dynamic from 'next/dynamic'
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
import { TopAttendeesTable } from './_components/TopAttendeesTable'

const AttendanceTrendChart = dynamic(
  () => import('./_components/AttendanceTrendChart'),
  {
    ssr: false,
    loading: () => (
      <div className="bg-cream-2 border border-line rounded-sm animate-pulse" style={{ height: 280 }} />
    ),
  },
)

const ParishBreakdownChart = dynamic(
  () => import('./_components/ParishBreakdownChart'),
  {
    ssr: false,
    loading: () => (
      <div className="bg-cream-2 border border-line rounded-sm animate-pulse" style={{ height: 200 }} />
    ),
  },
)

const NewVsReturningChart = dynamic(
  () => import('./_components/NewVsReturningChart'),
  {
    ssr: false,
    loading: () => (
      <div className="bg-cream-2 border border-line rounded-sm animate-pulse" style={{ height: 280 }} />
    ),
  },
)

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

  const kpi         = kpiResult.status === 'ok'         ? kpiResult.data         : null
  const trend       = trendResult.status === 'ok'       ? trendResult.data       : null
  const parish      = parishResult.status === 'ok'      ? parishResult.data      : null
  const parishOptions = parishOptionsResult.status === 'ok'
    ? parishOptionsResult.data.map(r => r.parish)
    : []
  const nvr         = nvrResult.status === 'ok'         ? nvrResult.data         : null
  const top         = topResult.status === 'ok'         ? topResult.data         : null

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

        <section>
          <h2 className="font-heading text-xl font-semibold text-charcoal mb-1">
            {t('chart.trend_title')}
          </h2>
          <p className="text-xs text-muted mb-4">{t('chart.trend_note')}</p>
          <AttendanceTrendChart
            data={trend}
            labelY={t('chart.trend_y')}
            emptyMessage={t('empty')}
            errorMessage={t('error')}
            hasError={trendResult.status === 'error'}
          />
        </section>

        <section>
          <h2 className="font-heading text-xl font-semibold text-charcoal mb-1">
            {t('chart.parish_title')}
          </h2>
          <p className="text-xs text-muted mb-4">{t('chart.parish_note')}</p>
          <ParishBreakdownChart
            data={parish}
            emptyMessage={t('empty')}
            errorMessage={t('error')}
            hasError={parishResult.status === 'error'}
          />
        </section>

        <section>
          <h2 className="font-heading text-xl font-semibold text-charcoal mb-1">
            {t('chart.nvr_title')}
          </h2>
          <p className="text-xs text-muted mb-4">{t('chart.nvr_note')}</p>
          <NewVsReturningChart
            data={nvr}
            labelNew={t('chart.nvr_new')}
            labelReturning={t('chart.nvr_returning')}
            emptyMessage={t('empty')}
            errorMessage={t('error')}
            hasError={nvrResult.status === 'error'}
          />
        </section>

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
