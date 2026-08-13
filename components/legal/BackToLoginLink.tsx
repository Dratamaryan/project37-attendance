'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'

export function BackToLoginLink() {
  const t = useTranslations('privacy')

  return (
    <Link
      href="/login"
      className="inline-block mb-6 text-xs font-medium text-muted hover:text-gold transition-colors"
    >
      {t('backToLogin')}
    </Link>
  )
}
