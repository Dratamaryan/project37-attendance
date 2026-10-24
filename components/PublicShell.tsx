import Image from 'next/image'
import Link from 'next/link'
import { getLocale } from 'next-intl/server'
import { LanguageSwitcher } from './LanguageSwitcher'
import { type ReactNode } from 'react'

type Props = {
  children: ReactNode
  /** Logo link target. Default '/'; null renders the logo without a link. */
  logoHref?: string | null
  /** Locale the page actually rendered in, when it pins its own (e.g. /rsvp). */
  locale?: string
}

export async function PublicShell({ children, logoHref = '/', locale }: Props) {
  const currentLocale = locale ?? (await getLocale())

  const logo = (
    <Image
      src="/brand/logo-primary.png"
      alt="Project 37"
      width={120}
      height={40}
      className="h-8 w-auto"
      priority
    />
  )

  return (
    <>
      <header className="border-b border-line bg-cream/80 backdrop-blur-sm sticky top-0 z-40">
        <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
          {/* '/' redirects to /login (unauthenticated) or /dashboard (authenticated) —
              harmless round-trip on /login itself, and the only way out of a dead-end
              page like /privacy that has no other chrome. Public congregant pages
              (/rsvp) pass logoHref={null}: a login page is no destination for them. */}
          {logoHref === null ? logo : <Link href={logoHref}>{logo}</Link>}
          <LanguageSwitcher currentLocale={currentLocale} />
        </div>
      </header>
      {children}
    </>
  )
}
