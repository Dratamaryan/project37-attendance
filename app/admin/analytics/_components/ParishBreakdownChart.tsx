'use client'

import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts'
import type { ParishRow } from '@/lib/actions/analytics.types'

type Props = {
  data: ParishRow[] | null
  emptyMessage: string
  errorMessage: string
  hasError: boolean
}

export default function ParishBreakdownChart({
  data,
  emptyMessage,
  errorMessage,
  hasError,
}: Props) {
  if (hasError) {
    return (
      <p className="text-sm text-muted py-8 text-center">{errorMessage}</p>
    )
  }
  if (!data || data.length === 0) {
    return (
      <p className="text-sm text-muted py-8 text-center" data-testid="analytics-empty">
        {emptyMessage}
      </p>
    )
  }

  const chartData = data.map(r => ({
    parish: r.parish,
    people: r.people_count,
  }))

  const barHeight = 36
  const chartHeight = Math.max(200, chartData.length * barHeight + 40)

  return (
    <div
      className="bg-cream-2 border border-line rounded-sm p-4"
      style={{ height: chartHeight }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={chartData}
          layout="vertical"
          margin={{ top: 4, right: 16, left: 8, bottom: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#E8E2D3" />
          <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
          <YAxis
            dataKey="parish"
            type="category"
            tick={{ fontSize: 11 }}
            width={130}
          />
          <Tooltip />
          <Bar dataKey="people" fill="#A8924A" name="People" radius={[0, 3, 3, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
