import { cookies } from 'next/headers'
import { getRequestConfig } from 'next-intl/server'
import { getCachedDefaultLanguage } from '@/lib/settings/default-language-cache'

const SUPPORTED_LOCALES = ['id', 'en'] as const
const DEFAULT_LOCALE = 'id'

export default getRequestConfig(async () => {
  const store = await cookies()
  const raw = store.get('locale')?.value

  let locale: string
  if (raw && (SUPPORTED_LOCALES as readonly string[]).includes(raw)) {
    locale = raw
  } else {
    // No locale cookie set (new/cookie-less visitor) — fall back to the
    // admin-configured app_settings.default_language instead of a hardcoded
    // default. Existing visitors with a cookie are unaffected either way.
    const configured = await getCachedDefaultLanguage()
    locale = (SUPPORTED_LOCALES as readonly string[]).includes(configured)
      ? configured
      : DEFAULT_LOCALE
  }

  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
  }
})
