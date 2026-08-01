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
          { href: '/admin/analytics', label: t('analytics') },
          { href: '/admin', label: t('admin') },
        ]
      : []),
  ]

  // '/admin' and '/admin/analytics' both match on an analytics subpath —
  // pick the longest (most specific) match so only one link is ever active.
  const activeHref = links
    .map(link => link.href)
    .filter(href => (href === '/dashboard' ? pathname === '/dashboard' : pathname.startsWith(href)))
    .sort((a, b) => b.length - a.length)[0]

  const isActive = (href: string) => href === activeHref

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
