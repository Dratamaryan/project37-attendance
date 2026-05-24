import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { Card } from '@/components/ui/Card'

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data } = await supabase.auth.getClaims()

  if (!data) redirect('/login')

  const { claims } = data
  const email = claims.email ?? '—'
  const sessionStarted = new Date(claims.iat * 1000).toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    dateStyle: 'medium',
    timeStyle: 'short',
  })

  const t = await getTranslations('dashboard')

  return (
    <main className="p-8">
      <div className="max-w-2xl mx-auto">
        <h1 className="font-heading text-3xl font-semibold text-charcoal mb-8">
          {t('title')}
        </h1>

        <Card className="space-y-4">
          <div>
            <p className="text-xs text-muted uppercase tracking-wide mb-1">
              {t('emailLabel')}
            </p>
            <p className="text-sm text-ink-2">{email}</p>
          </div>
          <div>
            <p className="text-xs text-muted uppercase tracking-wide mb-1">
              {t('sessionLabel')}
            </p>
            <p className="text-sm text-ink-2">{sessionStarted} WIB</p>
          </div>
          <div>
            <p className="text-xs text-muted uppercase tracking-wide mb-1">
              {t('roleLabel')}
            </p>
            <p className="text-sm text-muted italic">
              {t('rolePlaceholder')}
            </p>
          </div>
        </Card>
      </div>
    </main>
  )
}
