import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { NotAuthorized } from '@/app/admin/_components/not-authorized'
import { requireActiveAdmin } from '@/lib/auth/require-admin'

export default async function SettingsPage() {
  const supabase = await createClient()
  const authResult = await requireActiveAdmin(supabase)

  if (authResult.status === 'unauthenticated') redirect('/login')
  if (authResult.status === 'denied') return <NotAuthorized />

  const t = await getTranslations('settings')

  return (
    <main className="px-6 py-8">
      <div className="max-w-2xl mx-auto">
        <h1 className="font-heading text-3xl font-semibold text-charcoal mb-4">
          Settings
        </h1>
        <p className="text-muted">{t('coming_soon_message')}</p>
      </div>
    </main>
  )
}
