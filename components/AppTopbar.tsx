import Image from 'next/image'
import { getLocale, getTranslations } from 'next-intl/server'
import { LanguageSwitcher } from '@/components/LanguageSwitcher'
import { createClient } from '@/lib/supabase/server'
import { signOut } from '@/app/actions/signout'
import { AppNavLinks } from '@/components/AppNavLinks'

export async function AppTopbar() {
  const locale = await getLocale()
  const t = await getTranslations('nav')

  const supabase = await createClient()
  const { data } = await supabase.auth.getClaims()
  let role: 'admin' | 'organizer' | null = null

  if (data?.claims?.sub) {
    const { data: appUser } = await supabase
      .from('app_users')
      .select('role')
      .eq('id', data.claims.sub)
      .single()
    role = (appUser?.role as 'admin' | 'organizer') ?? null
  }

  return (
    <>
      <header className="border-b border-line bg-cream/80 backdrop-blur-sm sticky top-0 z-40">
        <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between gap-4">
          <Image
            src="/brand/logo-primary.png"
            alt="Project 37"
            width={120}
            height={40}
            className="h-8 w-auto"
            priority
          />
          <AppNavLinks role={role} variant="topbar" />
          <div className="flex items-center gap-4">
            <LanguageSwitcher currentLocale={locale} />
            <form action={signOut}>
              <button
                type="submit"
                className="text-xs font-medium text-muted hover:text-gold transition-colors"
              >
                {t('signOut')}
              </button>
            </form>
          </div>
        </div>
      </header>
      <AppNavLinks role={role} variant="bottom-tab" />
    </>
  )
}
