import { cookies } from 'next/headers'
import { getRequestConfig } from 'next-intl/server'

const SUPPORTED_LOCALES = ['id', 'en'] as const
const DEFAULT_LOCALE = 'id'

export default getRequestConfig(async () => {
  const store = await cookies()
  const raw = store.get('locale')?.value
  const locale =
    raw && (SUPPORTED_LOCALES as readonly string[]).includes(raw)
      ? raw
      : DEFAULT_LOCALE

  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
  }
})
