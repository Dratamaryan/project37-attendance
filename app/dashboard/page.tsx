import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { signOut } from './actions'

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
    <main className="min-h-screen bg-[#0F0F0F] p-8">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-2xl font-semibold text-[#A8924A] mb-8">
          {t('title')}
        </h1>

        <div className="rounded-2xl bg-white/5 border border-white/10 p-6 space-y-4">
          <div>
            <p className="text-xs text-white/40 uppercase tracking-wide mb-1">
              {t('emailLabel')}
            </p>
            <p className="text-sm text-white">{email}</p>
          </div>
          <div>
            <p className="text-xs text-white/40 uppercase tracking-wide mb-1">
              {t('sessionLabel')}
            </p>
            <p className="text-sm text-white">{sessionStarted} WIB</p>
          </div>
          <div>
            <p className="text-xs text-white/40 uppercase tracking-wide mb-1">
              {t('roleLabel')}
            </p>
            <p className="text-sm text-white/40 italic">
              {t('rolePlaceholder')}
            </p>
          </div>
        </div>

        <form action={signOut} className="mt-6">
          <button
            type="submit"
            className="rounded-lg border border-white/20 px-6 py-2.5 text-sm text-white/60 hover:border-white/40 hover:text-white transition-colors"
          >
            {t('signOut')}
          </button>
        </form>
      </div>
    </main>
  )
}
