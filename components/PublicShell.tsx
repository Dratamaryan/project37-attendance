import Image from 'next/image'
import { getLocale } from 'next-intl/server'
import { LanguageSwitcher } from './LanguageSwitcher'
import { type ReactNode } from 'react'

type Props = {
  children: ReactNode
}

export async function PublicShell({ children }: Props) {
  const locale = await getLocale()

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
          <LanguageSwitcher currentLocale={locale} />
        </div>
      </header>
      {children}
    </>
  )
}
