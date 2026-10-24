import { cookies } from 'next/headers'
import { getRequestConfig } from 'next-intl/server'
import { getCachedDefaultLanguage } from '@/lib/settings/default-language-cache'

const SUPPORTED_LOCALES = ['id', 'en'] as const
const DEFAULT_LOCALE = 'id'

export default getRequestConfig(async ({ locale: override }) => {
  const store = await cookies()
  const raw = store.get('locale')?.value

  let locale: string
  if (override && (SUPPORTED_LOCALES as readonly string[]).includes(override)) {
    // Explicit getTranslations({ locale }) / getMessages({ locale }) — honored
    // so a page can pin its own locale rule (e.g. /rsvp: cookie else 'id',
    // never the admin default). Implicit calls pass no override.
    locale = override
  } else if (raw && (SUPPORTED_LOCALES as readonly string[]).includes(raw)) {
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
