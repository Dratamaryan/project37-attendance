import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { NotAuthorized } from '@/app/admin/_components/not-authorized'
import { requireActiveAdmin } from '@/lib/auth/require-admin'
import { getSettings } from '@/lib/actions/settings'
import { listPendingParishes } from '@/lib/actions/parishes-admin'
import { getTelegramBotToken } from '@/lib/telegram/token'
import { SettingsClient } from './settings-client'

export default async function SettingsPage() {
  const supabase = await createClient()
  const authResult = await requireActiveAdmin(supabase)

  if (authResult.status === 'unauthenticated') redirect('/login')
  if (authResult.status === 'denied') return <NotAuthorized />

  const t = await getTranslations('settings')

  const [settingsResult, parishesResult] = await Promise.all([
    getSettings(),
    listPendingParishes(),
  ])

  // getTelegramBotToken() is the sole reader of TELEGRAM_BOT_TOKEN — only the
  // boolean presence result crosses into the client component, never the
  // token string itself.
  let telegramBotConfigured = false
  try {
    getTelegramBotToken()
    telegramBotConfigured = true
  } catch {
    telegramBotConfigured = false
  }

  return (
    <main className="px-4 md:px-6 py-8">
      <div className="max-w-2xl mx-auto space-y-8">
        <div>
          <h1 className="font-heading text-3xl font-semibold text-charcoal">{t('title')}</h1>
          <p className="text-sm text-muted mt-1">{t('subtitle')}</p>
        </div>
        <SettingsClient
          initialSettings={settingsResult.status === 'ok' ? settingsResult.settings : null}
          settingsLoadError={settingsResult.status !== 'ok'}
          initialPendingParishes={parishesResult.status === 'ok' ? parishesResult.parishes : []}
          parishesLoadError={parishesResult.status !== 'ok'}
          telegramBotConfigured={telegramBotConfigured}
        />
      </div>
    </main>
  )
}
