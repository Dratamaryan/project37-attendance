'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

const SUPPORTED_LOCALES = ['id', 'en']
const ONE_YEAR = 60 * 60 * 24 * 365

export async function setLocale(formData: FormData) {
  const locale = formData.get('locale') as string
  const redirectTo = (formData.get('redirectTo') as string) || '/'

  if (!SUPPORTED_LOCALES.includes(locale)) return

  const store = await cookies()
  store.set('locale', locale, {
    path: '/',
    maxAge: ONE_YEAR,
    httpOnly: true,
    sameSite: 'lax',
  })

  redirect(redirectTo)
}
