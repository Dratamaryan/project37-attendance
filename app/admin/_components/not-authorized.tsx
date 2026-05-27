'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'

export function NotAuthorized() {
  const t = useTranslations('auth.not_authorized')

  return (
    <main className="px-6 py-16">
      <div className="max-w-md mx-auto text-center">
        <p className="text-4xl mb-4" aria-hidden="true">🚫</p>
        <h1 className="font-heading text-2xl font-semibold text-charcoal mb-3">
          {t('title')}
        </h1>
        <p className="text-muted mb-6">{t('message')}</p>
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-2 text-sm font-medium text-gold hover:text-gold-dark transition-colors"
        >
          ← {t('back_to_dashboard')}
        </Link>
      </div>
    </main>
  )
}
