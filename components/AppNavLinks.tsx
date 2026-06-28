'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'

type Props = {
  role: 'admin' | 'organizer' | null
  variant: 'topbar' | 'bottom-tab'
}

export function AppNavLinks({ role, variant }: Props) {
  const pathname = usePathname()
  const t = useTranslations('nav')

  const links = [
    { href: '/dashboard', label: t('home') },
    { href: '/checkin', label: t('checkin') },
    ...(role === 'admin'
      ? [
          { href: '/admin/people', label: t('people') },
          { href: '/admin/events', label: t('events') },
          { href: '/admin/analytics', label: t('analytics') },
        ]
      : []),
  ]

  const isActive = (href: string) =>
    href === '/dashboard'
      ? pathname === '/dashboard'
      : pathname.startsWith(href)

  if (variant === 'topbar') {
    return (
      <nav aria-label="Main navigation" className="hidden md:flex items-center gap-1">
        {links.map(link => (
          <Link
            key={link.href}
            href={link.href}
            className={`px-3 py-1.5 text-sm font-medium rounded-sm transition-colors ${
              isActive(link.href)
                ? 'text-gold'
                : 'text-ink-2 hover:text-charcoal'
            }`}
          >
            {link.label}
          </Link>
        ))}
      </nav>
    )
  }

  return (
    <nav
      aria-label="Bottom navigation"
      className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-cream border-t border-line"
    >
      <div className="flex items-stretch h-14">
        {links.map(link => (
          <Link
            key={link.href}
            href={link.href}
            className={`flex-1 flex items-center justify-center text-xs font-medium transition-colors ${
              isActive(link.href)
                ? 'text-gold'
                : 'text-muted hover:text-charcoal'
            }`}
          >
            {link.label}
          </Link>
        ))}
      </div>
    </nav>
  )
}
