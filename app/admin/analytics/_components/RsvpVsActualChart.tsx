'use client'

import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts'
import type { RsvpChartRow } from '@/lib/actions/rsvp-analytics.types'

type Props = {
  data: RsvpChartRow[] | null
  labelComing: string
  labelAdults: string
  labelChildren: string
  emptyMessage: string
  errorMessage: string
  hasError: boolean
}

export default function RsvpVsActualChart({
  data,
  labelComing,
  labelAdults,
  labelChildren,
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
      <p className="text-sm text-muted py-8 text-center" data-testid="rsvp-chart-empty">
        {emptyMessage}
      </p>
    )
  }

  const chartData = data.map(r => ({
    date: r.scheduled_date,
    coming: r.coming_headcount,
    adults: r.actual_adults,
    children: r.actual_children,
  }))

  return (
    <div className="bg-cream-2 border border-line rounded-sm p-4" style={{ height: 280 }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#E8E2D3" />
          <XAxis dataKey="date" tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
          <Tooltip />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar dataKey="coming" fill="#F5EFD9" stroke="#A8924A" name={labelComing} />
          <Line type="monotone" dataKey="adults" stroke="#A8924A" strokeWidth={2} name={labelAdults} />
          <Line type="monotone" dataKey="children" stroke="#3D3833" strokeWidth={2} name={labelChildren} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
