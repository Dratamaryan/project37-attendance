'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

const SUPPORTED_LOCALES = ['id', 'en']
const ONE_YEAR = 60 * 60 * 24 * 365

// S9-R6 D6: same-origin paths only. '//host' and '/\host' are treated as
// protocol-relative by browsers, so they fall back to '/' like absolute URLs.
function safeRedirectPath(raw: FormDataEntryValue | null): string {
  if (typeof raw !== 'string') return '/'
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/'
  return raw
}

export async function setLocale(formData: FormData) {
  const locale = formData.get('locale') as string
  const redirectTo = safeRedirectPath(formData.get('redirectTo'))

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
