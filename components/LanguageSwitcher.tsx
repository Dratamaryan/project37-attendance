'use client'

import { usePathname } from 'next/navigation'
import { setLocale } from '@/app/actions/locale'

type Props = {
  currentLocale: string
}

export function LanguageSwitcher({ currentLocale }: Props) {
  const pathname = usePathname()

  return (
    <form action={setLocale} className="flex items-center gap-1 text-xs font-medium">
      <input type="hidden" name="redirectTo" value={pathname} />
      <button
        type="submit"
        name="locale"
        value="id"
        disabled={currentLocale === 'id'}
        className={
          currentLocale === 'id'
            ? 'text-gold'
            : 'text-muted hover:text-ink-2 transition-colors'
        }
      >
        ID
      </button>
      <span className="text-line">/</span>
      <button
        type="submit"
        name="locale"
        value="en"
        disabled={currentLocale === 'en'}
        className={
          currentLocale === 'en'
            ? 'text-gold'
            : 'text-muted hover:text-ink-2 transition-colors'
        }
      >
        EN
      </button>
    </form>
  )
}
