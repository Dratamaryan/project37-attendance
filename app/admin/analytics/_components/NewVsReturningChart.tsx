'use client'

import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts'
import type { NewVsReturningRow } from '@/lib/actions/analytics.types'

type Props = {
  data: NewVsReturningRow[] | null
  labelNew: string
  labelReturning: string
  emptyMessage: string
  errorMessage: string
  hasError: boolean
}

export default function NewVsReturningChart({
  data,
  labelNew,
  labelReturning,
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
    month: r.month.slice(0, 7),
    new: r.new_count,
    returning: r.returning_count,
  }))

  return (
    <div className="bg-cream-2 border border-line rounded-sm p-4" style={{ height: 280 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#E8E2D3" />
          <XAxis dataKey="month" tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
          <Tooltip />
          <Legend />
          <Bar dataKey="new" stackId="a" fill="#A8924A" name={labelNew} />
          <Bar
            dataKey="returning"
            stackId="a"
            fill="#F5EFD9"
            stroke="#8B7635"
            strokeWidth={1}
            name={labelReturning}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
