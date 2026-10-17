import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { NotAuthorized } from '@/app/admin/_components/not-authorized'
import { requireActiveAdmin } from '@/lib/auth/require-admin'
import { PeopleListClient } from './people-list-client'

export default async function AdminPeoplePage() {
  const supabase = await createClient()
  const authResult = await requireActiveAdmin(supabase)

  if (authResult.status === 'unauthenticated') redirect('/login')
  if (authResult.status === 'denied') return <NotAuthorized />

  const t = await getTranslations('admin.people')

  return (
    <main className="px-4 md:px-6 py-8">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between gap-3 mb-6">
          <h1 className="font-heading text-3xl font-semibold text-charcoal">
            {t('title')}
          </h1>
          <Link
            href="/admin/people/new"
            className="inline-flex items-center gap-2 px-4 py-2 bg-gold text-cream rounded-lg text-sm font-semibold hover:bg-gold-dark transition-colors flex-shrink-0"
          >
            + {t('add.button')}
          </Link>
        </div>
        <PeopleListClient />
      </div>
    </main>
  )
}
