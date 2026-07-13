import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { NotAuthorized } from '@/app/admin/_components/not-authorized'
import { ImportClient } from './import-client'

export default async function AdminImportPage() {
  const supabase = await createClient()
  const { data } = await supabase.auth.getClaims()

  if (!data) redirect('/login')

  const { data: appUser } = await supabase
    .from('app_users')
    .select('role')
    .eq('id', data.claims.sub)
    .single()

  if (appUser?.role !== 'admin') {
    return <NotAuthorized />
  }

  const t = await getTranslations('admin.import')

  return (
    <main className="px-4 md:px-6 py-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <div>
          <h1 className="font-heading text-3xl font-semibold text-charcoal">
            {t('title')}
          </h1>
          <p className="text-sm text-muted mt-1">{t('subtitle')}</p>
        </div>
        <ImportClient />
      </div>
    </main>
  )
}
