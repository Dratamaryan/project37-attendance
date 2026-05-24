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
            ? 'text-[#A8924A]'
            : 'text-white/40 hover:text-white/70 transition-colors'
        }
      >
        ID
      </button>
      <span className="text-white/20">/</span>
      <button
        type="submit"
        name="locale"
        value="en"
        disabled={currentLocale === 'en'}
        className={
          currentLocale === 'en'
            ? 'text-[#A8924A]'
            : 'text-white/40 hover:text-white/70 transition-colors'
        }
      >
        EN
      </button>
    </form>
  )
}
