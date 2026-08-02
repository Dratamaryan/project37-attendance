import Link from 'next/link'
import { type ReactNode } from 'react'
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { NotAuthorized } from '@/app/admin/_components/not-authorized'
import { requireActiveAdmin } from '@/lib/auth/require-admin'

export default async function AdminHubPage() {
  const supabase = await createClient()
  const authResult = await requireActiveAdmin(supabase)

  if (authResult.status === 'unauthenticated') redirect('/login')
  if (authResult.status === 'denied') return <NotAuthorized />

  const t = await getTranslations('admin.hub')

  return (
    <main className="px-4 md:px-6 py-8">
      <div className="max-w-5xl mx-auto">
        <h1 className="font-heading text-3xl font-semibold text-charcoal mb-6">
          {t('title')}
        </h1>
        <div data-testid="admin-hub-grid" className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <HubCard
            href="/admin/people"
            icon="👥"
            title={t('cards.people_title')}
            description={t('cards.people_description')}
          />
          <HubCard
            href="/admin/events"
            icon="📅"
            title={t('cards.events_title')}
            description={t('cards.events_description')}
          />
          <HubCard
            href="/admin/analytics"
            icon="📊"
            title={t('cards.analytics_title')}
            description={t('cards.analytics_description')}
          />
          <HubCard
            href="/admin/import"
            icon="📥"
            title={t('cards.import_title')}
            description={t('cards.import_description')}
          />
          {/* T6 adds a Users card here; T7 adds Settings; T9 adds Audit Log. */}
        </div>
      </div>
    </main>
  )
}

type HubCardProps = {
  href: string
  icon: ReactNode
  title: string
  description: string
}

function HubCard({ href, icon, title, description }: HubCardProps) {
  return (
    <Link
      href={href}
      className="flex items-start gap-4 p-5 min-h-[80px] rounded-lg bg-cream-2 border border-line hover:border-gold hover:shadow-sm transition-all active:scale-[0.99]"
    >
      <span className="mt-0.5 text-xl leading-none flex-shrink-0" aria-hidden="true">
        {icon}
      </span>
      <div className="min-w-0">
        <div className="font-medium text-charcoal">{title}</div>
        <p className="text-sm text-muted mt-0.5 leading-snug">{description}</p>
      </div>
    </Link>
  )
}
