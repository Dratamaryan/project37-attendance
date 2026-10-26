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

const CHARCOAL = '#3D3833'
const GOLD = '#A8924A'
const GOLD_LIGHT = '#F5EFD9'

// Recharts colours legend and tooltip text with each series' colour, and the
// bar's light fill is unreadable on the card — every label is charcoal instead.
export const TOOLTIP_ITEM_STYLE = { color: CHARCOAL }
export const TOOLTIP_LABEL_STYLE = { color: CHARCOAL }

type LegendLabels = { coming: string; adults: string; children: string }

/**
 * Fixed legend, rendered from the series definitions (not Recharts' payload):
 * charcoal text for all three; the bar's swatch is its light fill with a gold
 * border so it shows on the card; the two lines get a line-and-dot icon.
 */
export function RsvpChartLegend({ labels }: { labels: LegendLabels }) {
  const lineIcon = (colour: string) => (
    <svg width="16" height="10" aria-hidden="true">
      <line x1="0" y1="5" x2="16" y2="5" stroke={colour} strokeWidth="2" />
      <circle cx="8" cy="5" r="3" fill="#FFFFFF" stroke={colour} strokeWidth="2" />
    </svg>
  )
  const items = [
    {
      key: 'coming',
      label: labels.coming,
      icon: (
        <span
          aria-hidden="true"
          style={{ display: 'inline-block', width: 12, height: 10, background: GOLD_LIGHT, border: `1.5px solid ${GOLD}` }}
        />
      ),
    },
    { key: 'adults', label: labels.adults, icon: lineIcon(GOLD) },
    { key: 'children', label: labels.children, icon: lineIcon(CHARCOAL) },
  ]
  return (
    <ul className="flex flex-wrap justify-center gap-4 pt-2" style={{ fontSize: 11 }}>
      {items.map(item => (
        <li key={item.key} className="flex items-center gap-1.5" data-testid={`rsvp-legend-${item.key}`}>
          {item.icon}
          <span style={{ color: CHARCOAL }}>{item.label}</span>
        </li>
      ))}
    </ul>
  )
}

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
          <Tooltip itemStyle={TOOLTIP_ITEM_STYLE} labelStyle={TOOLTIP_LABEL_STYLE} />
          <Legend
            content={() => (
              <RsvpChartLegend labels={{ coming: labelComing, adults: labelAdults, children: labelChildren }} />
            )}
          />
          <Bar dataKey="coming" fill={GOLD_LIGHT} stroke={GOLD} name={labelComing} />
          <Line type="monotone" dataKey="adults" stroke={GOLD} strokeWidth={2} name={labelAdults} />
          <Line type="monotone" dataKey="children" stroke={CHARCOAL} strokeWidth={2} name={labelChildren} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
