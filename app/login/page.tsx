'use client'

import { useActionState } from 'react'
import { useTranslations } from 'next-intl'
import { sendMagicLink } from './actions'

type State = { message: string | null }
const initialState: State = { message: null }

export default function LoginPage() {
  const [state, formAction, isPending] = useActionState(sendMagicLink, initialState)
  const t = useTranslations('login')

  return (
    <main className="min-h-screen flex items-center justify-center bg-[#0F0F0F]">
      <div className="w-full max-w-sm px-6 py-8 rounded-2xl bg-white/5 border border-white/10">
        <h1 className="text-2xl font-semibold text-[#A8924A] mb-2">
          {t('title')}
        </h1>
        <p className="text-sm text-white/50 mb-8">
          {t('subtitle')}
        </p>

        {state.message ? (
          <p className="text-sm text-white/80 leading-relaxed">{state.message}</p>
        ) : (
          <form action={formAction} className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-xs text-white/60 mb-1">
                {t('emailLabel')}
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                autoComplete="email"
                className="w-full rounded-lg border border-white/20 bg-white/5 px-4 py-2.5 text-sm text-white placeholder-white/30 focus:border-[#A8924A] focus:outline-none"
                placeholder={t('emailPlaceholder')}
              />
            </div>
            <button
              type="submit"
              disabled={isPending}
              className="w-full rounded-lg bg-[#A8924A] px-4 py-2.5 text-sm font-medium text-[#0F0F0F] hover:bg-[#9a8444] disabled:opacity-50 transition-colors"
            >
              {isPending ? t('sendingButton') : t('sendButton')}
            </button>
          </form>
        )}
      </div>
    </main>
  )
}
