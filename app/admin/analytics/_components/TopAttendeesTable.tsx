'use client'

import type { TopAttendeeRow } from '@/lib/actions/analytics.types'

type Labels = {
  colName: string
  colParish: string
  colTotal: string
  colEvents: string
  colLast: string
  parishNone: string
}

type Props = {
  data: TopAttendeeRow[] | null
  labels: Labels
  emptyMessage: string
  errorMessage: string
  hasError: boolean
}

export function TopAttendeesTable({ data, labels, emptyMessage, errorMessage, hasError }: Props) {
  if (hasError) {
    return (
      <p className="text-sm text-muted py-8 text-center" data-testid="analytics-empty">
        {errorMessage}
      </p>
    )
  }
  if (!data || data.length === 0) {
    return (
      <p className="text-sm text-muted py-8 text-center" data-testid="analytics-empty">
        {emptyMessage}
      </p>
    )
  }

  return (
    <div className="overflow-x-auto bg-cream-2 border border-line rounded-sm">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line">
            <th className="text-left py-2 px-3 text-xs font-medium text-muted">#</th>
            <th className="text-left py-2 px-3 text-xs font-medium text-muted">{labels.colName}</th>
            <th className="text-left py-2 px-3 text-xs font-medium text-muted">{labels.colParish}</th>
            <th className="text-right py-2 px-3 text-xs font-medium text-muted">{labels.colTotal}</th>
            <th className="text-right py-2 px-3 text-xs font-medium text-muted">{labels.colEvents}</th>
            <th className="text-left py-2 px-3 text-xs font-medium text-muted">{labels.colLast}</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => (
            <tr key={row.person_id} className="border-b border-line/50 hover:bg-cream transition-colors">
              <td className="py-2 px-3 text-muted">{i + 1}</td>
              <td className="py-2 px-3 font-medium text-charcoal">
                {row.full_name}
                {row.nickname ? (
                  <span className="text-muted font-normal ml-1">({row.nickname})</span>
                ) : null}
              </td>
              <td className="py-2 px-3 text-muted">{row.origin_parish ?? labels.parishNone}</td>
              <td className="py-2 px-3 text-right text-charcoal">{row.total_attendance}</td>
              <td className="py-2 px-3 text-right text-muted">{row.distinct_events}</td>
              <td className="py-2 px-3 text-muted">
                {row.last_attended_at ? row.last_attended_at.slice(0, 10) : labels.parishNone}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
