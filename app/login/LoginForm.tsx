'use client'

import { useActionState } from 'react'
import { useTranslations } from 'next-intl'
import { sendMagicLink } from './actions'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'

type State = { message: string | null }
const initialState: State = { message: null }

export function LoginForm() {
  const [state, formAction, isPending] = useActionState(sendMagicLink, initialState)
  const t = useTranslations('login')

  return (
    <Card className="w-full max-w-sm">
      <h1 className="font-heading text-3xl font-semibold text-charcoal mb-1">
        {t('title')}
      </h1>
      <p className="text-sm text-muted mb-8">
        {t('subtitle')}
      </p>

      {state.message ? (
        <p className="text-sm text-ink-2 leading-relaxed">{state.message}</p>
      ) : (
        <form action={formAction} className="space-y-4">
          <div>
            <label htmlFor="email" className="block text-xs text-muted mb-1">
              {t('emailLabel')}
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              className="w-full rounded-lg border border-line bg-cream px-4 py-2.5 text-sm text-charcoal placeholder-muted focus:border-gold focus:outline-none transition-colors"
              placeholder={t('emailPlaceholder')}
            />
          </div>
          <Button type="submit" disabled={isPending} className="w-full">
            {isPending ? t('sendingButton') : t('sendButton')}
          </Button>
        </form>
      )}
    </Card>
  )
}
