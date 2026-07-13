'use client'

import { useTranslations } from 'next-intl'

interface Props {
  filename: string
  attempted: number
  inserted: number
  raced: number
  skippedDup: number
  skippedError: number
}

export function ImportResultSummary({ filename, attempted, inserted, raced, skippedDup, skippedError }: Props) {
  const t = useTranslations('admin.import.result')

  const stats: Array<[string, string, number]> = [
    ['attempted', t('attempted'), attempted],
    ['inserted', t('inserted'), inserted],
    ['raced', t('raced'), raced],
    ['skipped_dup', t('skipped_dup'), skippedDup],
    ['skipped_error', t('skipped_error'), skippedError],
  ]

  return (
    <div id="import-result-summary" className="space-y-3">
      <div>
        <h2 className="font-heading text-xl font-semibold text-charcoal">{t('title')}</h2>
        <p className="text-sm text-muted">{filename}</p>
      </div>
      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3 max-w-lg">
        {stats.map(([key, label, value]) => (
          <div key={key} className="rounded-sm border border-line bg-cream-2 px-3 py-2">
            <dt className="text-xs text-muted">{label}</dt>
            <dd id={`import-result-${key}`} className="text-lg font-semibold text-charcoal">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
