import Image from 'next/image'
import { getLocale, getTranslations } from 'next-intl/server'
import { LanguageSwitcher } from '@/components/LanguageSwitcher'
import { signOut } from './actions'
import { type ReactNode } from 'react'

type Props = {
  children: ReactNode
}

export default async function DashboardLayout({ children }: Props) {
  const locale = await getLocale()
  const t = await getTranslations('nav')

  return (
    <>
      <header className="border-b border-line bg-cream/80 backdrop-blur-sm sticky top-0 z-40">
        <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
          <Image
            src="/brand/logo-primary.png"
            alt="Project 37"
            width={120}
            height={40}
            className="h-8 w-auto"
            priority
          />
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
      {children}
    </>
  )
}
