'use client'

import { useTranslations } from 'next-intl'
import type { RecipientFilter } from '@/lib/actions/invites.types'
import { TRIBE_OPTIONS, KEPANITIAAN_OPTIONS } from './filter-options'

type Props = {
  filter: RecipientFilter
  onChange: (filter: RecipientFilter) => void
  onPreview: () => void
  isPreviewing: boolean
}

export function FilterPicker({ filter, onChange, onPreview, isPreviewing }: Props) {
  const t = useTranslations('admin.events.invite.filter')

  return (
    <section aria-label={t('title')}>
      <h2 className="font-heading text-base font-semibold text-charcoal mb-3">{t('title')}</h2>
      <div className="flex flex-wrap gap-3 items-end p-4 bg-cream-2 border border-line rounded-sm">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-ink-2">{t('tribe_label')}</label>
          <select
            data-testid="filter-tribe"
            value={filter.tribe ?? ''}
            onChange={e => onChange({ ...filter, tribe: e.target.value || undefined })}
            className="text-sm border border-line rounded-sm px-2 py-1.5 bg-cream"
          >
            <option value="">{t('tribe_all')}</option>
            {TRIBE_OPTIONS.map(tribe => (
              <option key={tribe} value={tribe}>{tribe}</option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-ink-2">{t('kepanitiaan_label')}</label>
          <select
            data-testid="filter-kepanitiaan"
            value={filter.kepanitiaan ?? ''}
            onChange={e => onChange({ ...filter, kepanitiaan: e.target.value || undefined })}
            className="text-sm border border-line rounded-sm px-2 py-1.5 bg-cream"
          >
            <option value="">{t('kepanitiaan_all')}</option>
            {KEPANITIAAN_OPTIONS.map(k => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-ink-2">{t('recency_label')}</label>
          <input
            type="number"
            min={0}
            data-testid="filter-recency"
            placeholder={t('recency_placeholder')}
            value={filter.attendanceRecencyDays ?? ''}
            onChange={e => {
              const val = e.target.value
              onChange({ ...filter, attendanceRecencyDays: val === '' ? undefined : Number(val) })
            }}
            className="text-sm border border-line rounded-sm px-2 py-1.5 bg-cream w-32"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-ink-2">{t('min_attendance_label')}</label>
          <input
            type="number"
            min={0}
            data-testid="filter-min-attendance"
            placeholder={t('min_attendance_placeholder')}
            value={filter.minAttendance ?? ''}
            onChange={e => {
              const val = e.target.value
              onChange({ ...filter, minAttendance: val === '' ? undefined : Number(val) })
            }}
            className="text-sm border border-line rounded-sm px-2 py-1.5 bg-cream w-32"
          />
        </div>

        <button
          type="button"
          onClick={onPreview}
          disabled={isPreviewing}
          data-testid="preview-button"
          className="text-sm font-medium text-cream bg-gold hover:bg-gold-dark transition-colors rounded-sm px-3 py-1.5 disabled:opacity-50 ml-auto"
        >
          {isPreviewing ? t('previewing') : t('preview_button')}
        </button>
      </div>
    </section>
  )
}
