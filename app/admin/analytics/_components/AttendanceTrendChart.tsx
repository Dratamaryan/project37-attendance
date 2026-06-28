'use client'

import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts'
import type { TrendRow } from '@/lib/actions/analytics.types'

type Props = {
  data: TrendRow[] | null
  labelY: string
  emptyMessage: string
  errorMessage: string
  hasError: boolean
}

export default function AttendanceTrendChart({
  data,
  labelY,
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
    date: r.scheduled_at.slice(0, 10),
    count: r.attendee_count,
    name: r.event_name_snapshot,
  }))

  return (
    <div className="bg-cream-2 border border-line rounded-sm p-4" style={{ height: 280 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#E8E2D3" />
          <XAxis dataKey="date" tick={{ fontSize: 11 }} />
          <YAxis
            tick={{ fontSize: 11 }}
            label={{ value: labelY, angle: -90, position: 'insideLeft', fontSize: 11, offset: 12 }}
          />
          <Tooltip />
          <Area
            type="monotone"
            dataKey="count"
            stroke="#A8924A"
            fill="#F5EFD9"
            strokeWidth={2}
            name={labelY}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
