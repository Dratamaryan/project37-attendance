import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { listNearestInstances } from '@/lib/actions/events'
import { CheckinClient } from './checkin-client'

export default async function CheckinPage() {
  const supabase = await createClient()
  const { data } = await supabase.auth.getClaims()

  if (!data) redirect('/login')

  const [t, { data: appUser }, nearestResult] = await Promise.all([
    getTranslations('checkin'),
    supabase
      .from('app_users')
      .select('role')
      .eq('id', data.claims.sub)
      .single(),
    listNearestInstances({ limit: 5 }),
  ])

  const isAdmin = (appUser as { role: string } | null)?.role === 'admin'
  const instances = nearestResult.status === 'ok' ? nearestResult.instances : []

  return (
    <main className="max-w-5xl mx-auto px-4 sm:px-6 py-6">
      <div className="mb-6 pb-5 border-b border-line">
        <p className="text-xs uppercase tracking-widest text-gold-dark font-semibold mb-1">
          Project 37
        </p>
        <h1 className="font-heading text-4xl font-semibold text-charcoal">
          {t('title')}
        </h1>
      </div>
      <CheckinClient instances={instances} isAdmin={isAdmin} />
    </main>
  )
}
