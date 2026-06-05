'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'

export function PersonNotFound() {
  const t = useTranslations('admin.people.edit.error')

  return (
    <main className="px-6 py-16">
      <div className="max-w-md mx-auto text-center">
        <p className="text-4xl mb-4" aria-hidden="true">🔍</p>
        <h1 className="font-heading text-2xl font-semibold text-charcoal mb-3">
          {t('not_found')}
        </h1>
        <p className="text-muted mb-6">{t('not_found_message')}</p>
        <Link
          href="/admin/people"
          className="inline-flex items-center gap-2 text-sm font-medium text-gold hover:text-gold-dark transition-colors"
        >
          ← Back to People
        </Link>
      </div>
    </main>
  )
}
