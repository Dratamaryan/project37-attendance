'use client'

import { useRouter, usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import type { AnalyticsFilters, EventType } from '@/lib/actions/analytics.types'

type Props = {
  currentFilters: AnalyticsFilters
  parishOptions: string[]
}

function buildSearchParams(filters: AnalyticsFilters): string {
  const params = new URLSearchParams()
  if (filters.from)      params.set('from', filters.from)
  if (filters.to)        params.set('to', filters.to)
  if (filters.eventType) params.set('eventType', filters.eventType)
  if (filters.parish)    params.set('parish', filters.parish)
  return params.toString()
}

export function AnalyticsFiltersControls({ currentFilters, parishOptions }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const t = useTranslations('admin.analytics')

  function update(patch: Partial<AnalyticsFilters>) {
    const merged = { ...currentFilters, ...patch }
    const next: AnalyticsFilters = {}
    if (merged.from)      next.from      = merged.from
    if (merged.to)        next.to        = merged.to
    if (merged.eventType) next.eventType = merged.eventType
    if (merged.parish)    next.parish    = merged.parish
    const qs = buildSearchParams(next)
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  const hasFilters =
    !!currentFilters.from ||
    !!currentFilters.to ||
    !!currentFilters.eventType ||
    !!currentFilters.parish

  return (
    <div className="flex flex-wrap gap-3 items-end p-4 bg-cream-2 border border-line rounded-sm">
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-ink-2">{t('filter.from')}</label>
        <input
          type="date"
          data-testid="filter-from"
          value={currentFilters.from ?? ''}
          onChange={e => update({ from: e.target.value || undefined })}
          className="text-sm border border-line rounded-sm px-2 py-1.5 bg-cream"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-ink-2">{t('filter.to')}</label>
        <input
          type="date"
          data-testid="filter-to"
          value={currentFilters.to ?? ''}
          onChange={e => update({ to: e.target.value || undefined })}
          className="text-sm border border-line rounded-sm px-2 py-1.5 bg-cream"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-ink-2">{t('filter.event_type')}</label>
        <select
          data-testid="filter-event-type"
          value={currentFilters.eventType ?? ''}
          onChange={e => {
            const val = e.target.value
            update({ eventType: val === '' ? undefined : (val as EventType) })
          }}
          className="text-sm border border-line rounded-sm px-2 py-1.5 bg-cream"
        >
          <option value="">{t('filter.event_type_all')}</option>
          <option value="friday_monthly">{t('filter.event_type_friday_monthly')}</option>
          <option value="sunday_monthly">{t('filter.event_type_sunday_monthly')}</option>
          <option value="adhoc">{t('filter.event_type_adhoc')}</option>
          <option value="other_recurring">{t('filter.event_type_other_recurring')}</option>
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-ink-2">{t('filter.parish')}</label>
        <select
          data-testid="filter-parish"
          value={currentFilters.parish ?? ''}
          onChange={e => {
            const val = e.target.value
            update({ parish: val === '' ? undefined : val })
          }}
          className="text-sm border border-line rounded-sm px-2 py-1.5 bg-cream"
        >
          <option value="">{t('filter.parish_all')}</option>
          {parishOptions.map(p => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      </div>

      {hasFilters && (
        <button
          type="button"
          onClick={() => router.replace(pathname, { scroll: false })}
          className="text-xs font-medium text-muted hover:text-gold transition-colors py-1.5"
        >
          {t('filter.clear')}
        </button>
      )}

      <a
        href={`/api/admin/export/attendance${buildSearchParams(currentFilters) ? `?${buildSearchParams(currentFilters)}` : ''}`}
        data-testid="export-link"
        className="text-sm font-medium text-cream bg-gold hover:bg-gold-dark transition-colors rounded-sm px-3 py-1.5 ml-auto"
      >
        {t('filter.export')}
      </a>
    </div>
  )
}
