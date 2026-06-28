'use client'

// Client boundary for the three Recharts components.
// next/dynamic with ssr:false is not allowed in Server Components — it must
// live in a 'use client' file. page.tsx (RSC) imports this wrapper normally
// and passes already-fetched data as props; no client-side data fetching here.

import dynamic from 'next/dynamic'
import type { TrendRow, ParishRow, NewVsReturningRow } from '@/lib/actions/analytics.types'

const AttendanceTrendChart = dynamic(
  () => import('./AttendanceTrendChart'),
  {
    ssr: false,
    loading: () => (
      <div className="bg-cream-2 border border-line rounded-sm animate-pulse" style={{ height: 280 }} />
    ),
  },
)

const ParishBreakdownChart = dynamic(
  () => import('./ParishBreakdownChart'),
  {
    ssr: false,
    loading: () => (
      <div className="bg-cream-2 border border-line rounded-sm animate-pulse" style={{ height: 200 }} />
    ),
  },
)

const NewVsReturningChart = dynamic(
  () => import('./NewVsReturningChart'),
  {
    ssr: false,
    loading: () => (
      <div className="bg-cream-2 border border-line rounded-sm animate-pulse" style={{ height: 280 }} />
    ),
  },
)

type ChartLabels = {
  trendTitle: string
  trendNote: string
  trendY: string
  parishTitle: string
  parishNote: string
  nvrTitle: string
  nvrNote: string
  nvrNew: string
  nvrReturning: string
  empty: string
  error: string
}

type Props = {
  trend: TrendRow[] | null
  trendHasError: boolean
  parish: ParishRow[] | null
  parishHasError: boolean
  nvr: NewVsReturningRow[] | null
  nvrHasError: boolean
  labels: ChartLabels
}

export function AnalyticsCharts({
  trend,
  trendHasError,
  parish,
  parishHasError,
  nvr,
  nvrHasError,
  labels,
}: Props) {
  return (
    <>
      <section>
        <h2 className="font-heading text-xl font-semibold text-charcoal mb-1">
          {labels.trendTitle}
        </h2>
        <p className="text-xs text-muted mb-4">{labels.trendNote}</p>
        <AttendanceTrendChart
          data={trend}
          labelY={labels.trendY}
          emptyMessage={labels.empty}
          errorMessage={labels.error}
          hasError={trendHasError}
        />
      </section>

      <section>
        <h2 className="font-heading text-xl font-semibold text-charcoal mb-1">
          {labels.parishTitle}
        </h2>
        <p className="text-xs text-muted mb-4">{labels.parishNote}</p>
        <ParishBreakdownChart
          data={parish}
          emptyMessage={labels.empty}
          errorMessage={labels.error}
          hasError={parishHasError}
        />
      </section>

      <section>
        <h2 className="font-heading text-xl font-semibold text-charcoal mb-1">
          {labels.nvrTitle}
        </h2>
        <p className="text-xs text-muted mb-4">{labels.nvrNote}</p>
        <NewVsReturningChart
          data={nvr}
          labelNew={labels.nvrNew}
          labelReturning={labels.nvrReturning}
          emptyMessage={labels.empty}
          errorMessage={labels.error}
          hasError={nvrHasError}
        />
      </section>
    </>
  )
}
