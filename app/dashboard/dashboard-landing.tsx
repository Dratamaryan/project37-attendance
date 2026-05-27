'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { type ReactNode } from 'react'

type Props = {
  role: 'admin' | 'organizer'
  fullName: string | null
  email: string
}

export function DashboardLanding({ role, fullName, email }: Props) {
  const t = useTranslations('dashboard')

  const greeting = t('greeting', { name: fullName ?? email })
  const roleLabel = t(`role.${role}`)

  return (
    <main className="px-6 py-8">
      <div className="max-w-2xl mx-auto">
        <div className="mb-8">
          <p className="text-xs text-muted uppercase tracking-wide mb-1">{roleLabel}</p>
          <h1 className="font-heading text-3xl font-semibold text-charcoal">{greeting}</h1>
        </div>

        <div className="space-y-6">
          <section>
            <div className="grid grid-cols-1 gap-4">
              <NavCard
                href="/checkin"
                icon="✓"
                title={t('cards.checkin_title')}
                description={t('cards.checkin_description')}
              />
            </div>
          </section>

          {role === 'admin' && (
            <section>
              <div className="flex items-center gap-3 mb-4">
                <div className="h-px flex-1 bg-line" />
                <span className="text-xs uppercase tracking-wider text-muted font-medium">
                  {roleLabel}
                </span>
                <div className="h-px flex-1 bg-line" />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <NavCard
                  href="/admin/people"
                  icon="👥"
                  title={t('cards.people_title')}
                  description={t('cards.people_description')}
                />
                <NavCard
                  href="/admin/settings"
                  icon="⚙️"
                  title={t('cards.settings_title')}
                  description={t('cards.settings_description')}
                  badge={t('cards.coming_soon')}
                />
              </div>
            </section>
          )}
        </div>
      </div>
    </main>
  )
}

type NavCardProps = {
  href: string
  icon: ReactNode
  title: string
  description: string
  badge?: string
}

function NavCard({ href, icon, title, description, badge }: NavCardProps) {
  return (
    <Link
      href={href}
      className="flex items-start gap-4 p-5 min-h-[80px] rounded-lg bg-cream-2 border border-line hover:border-gold hover:shadow-sm transition-all active:scale-[0.99]"
    >
      <span className="mt-0.5 text-xl leading-none flex-shrink-0" aria-hidden="true">
        {icon}
      </span>
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-charcoal">{title}</span>
          {badge && (
            <span className="text-xs px-2 py-0.5 bg-gold-light text-gold-dark rounded-full font-medium">
              {badge}
            </span>
          )}
        </div>
        <p className="text-sm text-muted mt-0.5 leading-snug">{description}</p>
      </div>
    </Link>
  )
}
