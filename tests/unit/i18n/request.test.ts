// i18n/request.ts locale resolution: an explicit getTranslations({ locale })
// override wins (S9-R1 /rsvp pins its own locale); otherwise cookie, then the
// admin default_language.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next-intl/server', () => ({
  getRequestConfig: (fn: unknown) => fn,
}))

let mockCookie: string | undefined
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name === 'locale' && mockCookie !== undefined ? { value: mockCookie } : undefined),
  }),
}))

const mockDefault = vi.fn(async () => 'en')
vi.mock('@/lib/settings/default-language-cache', () => ({
  getCachedDefaultLanguage: () => mockDefault(),
}))

import requestConfig from '@/i18n/request'

type Resolve = (params: { locale?: string; requestLocale: Promise<string | undefined> }) => Promise<{
  locale: string
  messages: Record<string, unknown>
}>
const resolve = requestConfig as unknown as Resolve
const call = (locale?: string) => resolve({ locale, requestLocale: Promise.resolve(undefined) })

beforeEach(() => {
  mockCookie = undefined
  mockDefault.mockClear()
})

describe('i18n request config', () => {
  it('explicit override wins over cookie and admin default', async () => {
    mockCookie = 'en'
    const result = await call('id')
    expect(result.locale).toBe('id')
    expect(result.messages).toHaveProperty('rsvp.form.status_coming', 'Hadir')
    expect(mockDefault).not.toHaveBeenCalled()
  })

  it('unsupported override is ignored -> cookie', async () => {
    mockCookie = 'id'
    expect((await call('fr')).locale).toBe('id')
  })

  it('no override -> cookie', async () => {
    mockCookie = 'en'
    expect((await call()).locale).toBe('en')
    expect(mockDefault).not.toHaveBeenCalled()
  })

  it('no override, no cookie -> admin default_language', async () => {
    expect((await call()).locale).toBe('en')
    expect(mockDefault).toHaveBeenCalledTimes(1)
  })
})
