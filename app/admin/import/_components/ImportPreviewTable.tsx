'use client'

import { useTranslations } from 'next-intl'
import type { ClassificationCounts, ClassifiedRow, RowClass } from '@/lib/import/types'

interface Props {
  filename: string
  totalRows: number
  classificationCounts: ClassificationCounts
  rows: ClassifiedRow[]
}

const CLASS_ORDER: RowClass[] = ['new', 'dup_in_db', 'dup_in_file', 'dup_soft_deleted', 'error']

export function ImportPreviewTable({ filename, totalRows, classificationCounts, rows }: Props) {
  const t = useTranslations('admin.import.preview')

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-heading text-xl font-semibold text-charcoal">{t('title')}</h2>
        <p className="text-sm text-muted">
          {filename} — {t('total_rows', { count: totalRows })}
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        {CLASS_ORDER.map((cls) => (
          <div key={cls} className="rounded-sm border border-line bg-cream-2 px-3 py-2 text-sm">
            <span id={`import-count-${cls}`} className="font-semibold text-charcoal">{classificationCounts[cls]}</span>{' '}
            <span className="text-muted">{t(`counts.${cls}`)}</span>
          </div>
        ))}
      </div>

      <div className="overflow-x-auto">
        <table id="import-preview-table" className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left border-b border-line text-muted">
              <th className="py-2 pr-3">{t('table.row')}</th>
              <th className="py-2 pr-3">{t('table.phone')}</th>
              <th className="py-2 pr-3">{t('table.name')}</th>
              <th className="py-2 pr-3">{t('table.class')}</th>
              <th className="py-2 pr-3">{t('table.reason')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.sourceRowNumber}
                data-row-phone={row.phone_e164 ?? ''}
                data-row-class={row.rowClass}
                className="border-b border-line/50"
              >
                <td className="py-1.5 pr-3">{row.sourceRowNumber}</td>
                <td className="py-1.5 pr-3">{row.phone_e164 ?? '—'}</td>
                <td className="py-1.5 pr-3">{row.full_name ?? '—'}</td>
                <td className="py-1.5 pr-3">{t(`counts.${row.rowClass}`)}</td>
                <td className="py-1.5 pr-3">{row.reason ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
