// @vitest-environment jsdom
//
// Page + metadata composition for the public /rsvp/[token] (S9-R1). The data
// layer (anon RPCs, flag, gate) is covered by lib/rsvp/__tests__/public.test.ts
// and tests/integration/rsvp-public.test.ts; here getRsvpPageData is mocked.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { RsvpPageData } from '@/lib/rsvp/public.types'

vi.mock('server-only', () => ({}))

const mockGetTranslations = vi.fn(
  async (opts: { locale: string; namespace: string }) =>
    (key: string, params?: Record<string, string>) =>
      `${opts.locale}:${opts.namespace}.${key}${params ? ` ${Object.values(params).join(' ')}` : ''}`,
)
const mockGetMessages = vi.fn(async (opts: { locale: string }) => ({
  rsvp: { marker: opts.locale },
  admin: { should: 'not be passed' },
}))
vi.mock('next-intl/server', () => ({
  getTranslations: (opts: { locale: string; namespace: string }) => mockGetTranslations(opts),
  getMessages: (opts: { locale: string }) => mockGetMessages(opts),
  getLocale: async () => 'en',
}))

const providerProps: { locale?: string; messages?: unknown }[] = []
vi.mock('next-intl', () => ({
  NextIntlClientProvider: ({ children, locale, messages }: { children: React.ReactNode; locale: string; messages: unknown }) => {
    providerProps.push({ locale, messages })
    return <div data-testid="intl-provider">{children}</div>
  },
}))

let mockLocaleCookie: string | undefined
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name === 'locale' && mockLocaleCookie !== undefined ? { value: mockLocaleCookie } : undefined),
  }),
}))

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NOT_FOUND')
  }),
}))

// The admin default would say 'en' — /rsvp must ignore it.
const mockDefaultLanguage = vi.fn(async () => 'en')
vi.mock('@/lib/settings/default-language-cache', () => ({
  getCachedDefaultLanguage: () => mockDefaultLanguage(),
}))

const shellProps: { logoHref?: string | null; locale?: string }[] = []
vi.mock('@/components/PublicShell', () => ({
  PublicShell: ({ children, logoHref, locale }: { children: React.ReactNode; logoHref?: string | null; locale?: string }) => {
    shellProps.push({ logoHref, locale })
    return <div data-testid="public-shell">{children}</div>
  },
}))

let capturedAction: ((prev: unknown, formData: FormData) => unknown) | null = null
vi.mock('../rsvp-form', () => ({
  RsvpForm: ({ action }: { action: (prev: unknown, formData: FormData) => unknown }) => {
    capturedAction = action
    return <div data-testid="rsvp-form-stub">{typeof action}</div>
  },
}))

// Hoisted: the factory below reads it directly (not lazily inside a function).
const mockSubmit = vi.hoisted(() => vi.fn())
vi.mock('@/lib/rsvp/public', () => ({
  submitRsvp: mockSubmit,
}))

const mockPageData = vi.fn<(token: string, locale: string) => Promise<RsvpPageData>>()
vi.mock('@/lib/rsvp/public.impl', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rsvp/public.impl')>()),
  getRsvpPageData: (token: string, locale: string) => mockPageData(token, locale),
}))

import RsvpPage, { generateMetadata, dynamic } from '../page'

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz012-_9'
const params = Promise.resolve({ token: TOKEN })

const OPEN: RsvpPageData = {
  kind: 'open',
  event: {
    name: 'Ibadah Jumat',
    dateLabel: 'Sabtu, 24 Oktober 2026',
    timeLabel: '18.00–20.00 WIB',
    location: 'Main Hall',
    imageUrl: 'https://example.invalid/poster.png',
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  providerProps.length = 0
  shellProps.length = 0
  capturedAction = null
  mockLocaleCookie = undefined
  mockPageData.mockResolvedValue(OPEN)
})

describe('RsvpPage', () => {
  it('is force-dynamic', () => {
    expect(dynamic).toBe('force-dynamic')
  })

  it('flag off (disabled) -> notFound', async () => {
    mockPageData.mockResolvedValue({ kind: 'disabled' })
    await expect(RsvpPage({ params })).rejects.toThrow('NOT_FOUND')
  })

  it('closed -> the one generic not-available view, no form, no event details', async () => {
    mockPageData.mockResolvedValue({ kind: 'closed' })
    render(await RsvpPage({ params }))
    expect(screen.getByTestId('rsvp-not-available')).toHaveTextContent('id:rsvp.closed.title')
    expect(screen.getByTestId('rsvp-not-available')).toHaveTextContent('id:rsvp.closed.body')
    // h1: the closed view is the whole page.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('id:rsvp.closed.title')
    expect(screen.queryByTestId('rsvp-form-stub')).not.toBeInTheDocument()
    expect(screen.queryByTestId('rsvp-event-image')).not.toBeInTheDocument()
  })

  it('open -> poster, name, date, time, location and the form', async () => {
    render(await RsvpPage({ params }))
    const img = screen.getByTestId('rsvp-event-image')
    expect(img).toHaveAttribute('src', 'https://example.invalid/poster.png')
    expect(img).toHaveAttribute('alt', 'Ibadah Jumat')
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Ibadah Jumat')
    expect(screen.getByText('Sabtu, 24 Oktober 2026')).toBeInTheDocument()
    expect(screen.getByText('18.00–20.00 WIB')).toBeInTheDocument()
    expect(screen.getByText('Main Hall')).toBeInTheDocument()
    expect(screen.getByTestId('rsvp-form-stub')).toHaveTextContent('function')
  })

  it('open without image / location -> no <img>, no location line', async () => {
    mockPageData.mockResolvedValue({
      kind: 'open',
      event: { ...(OPEN as Extract<RsvpPageData, { kind: 'open' }>).event, imageUrl: null, location: null },
    })
    render(await RsvpPage({ params }))
    expect(screen.queryByTestId('rsvp-event-image')).not.toBeInTheDocument()
    expect(screen.queryByText('Main Hall')).not.toBeInTheDocument()
  })

  it('binds the token into the server action', async () => {
    render(await RsvpPage({ params }))
    const prev = { kind: 'idle' }
    const fd = new FormData()
    await capturedAction?.(prev, fd)
    expect(mockSubmit).toHaveBeenCalledWith(TOKEN, prev, fd)
  })

  it('no locale cookie -> id everywhere, even though the admin default is en', async () => {
    render(await RsvpPage({ params }))
    expect(mockPageData).toHaveBeenCalledWith(TOKEN, 'id')
    expect(mockGetTranslations).toHaveBeenCalledWith({ locale: 'id', namespace: 'rsvp' })
    expect(mockGetMessages).toHaveBeenCalledWith({ locale: 'id' })
    expect(providerProps).toEqual([{ locale: 'id', messages: { rsvp: { marker: 'id' } } }])
    expect(shellProps).toEqual([{ logoHref: null, locale: 'id' }])
    expect(mockDefaultLanguage).not.toHaveBeenCalled()
  })

  it('locale cookie en -> en', async () => {
    mockLocaleCookie = 'en'
    render(await RsvpPage({ params }))
    expect(mockPageData).toHaveBeenCalledWith(TOKEN, 'en')
    expect(providerProps[0]?.locale).toBe('en')
    expect(shellProps[0]).toEqual({ logoHref: null, locale: 'en' })
  })

  it('unsupported locale cookie -> id', async () => {
    mockLocaleCookie = 'fr'
    render(await RsvpPage({ params }))
    expect(mockPageData).toHaveBeenCalledWith(TOKEN, 'id')
  })
})

describe('generateMetadata', () => {
  it('open -> noindex, no-referrer, event title/description, og:image', async () => {
    const meta = await generateMetadata({ params })
    expect(meta.robots).toEqual({ index: false, follow: false })
    expect(meta.referrer).toBe('no-referrer')
    expect(meta.title).toBe('id:rsvp.meta.title Ibadah Jumat')
    expect(meta.description).toBe('Sabtu, 24 Oktober 2026 · 18.00–20.00 WIB · Main Hall')
    expect(meta.openGraph).toEqual({
      title: 'id:rsvp.meta.title Ibadah Jumat',
      description: 'Sabtu, 24 Oktober 2026 · 18.00–20.00 WIB · Main Hall',
      type: 'website',
      images: ['https://example.invalid/poster.png'],
    })
  })

  it('open without image / location -> no og:image, description without location', async () => {
    mockPageData.mockResolvedValue({
      kind: 'open',
      event: { ...(OPEN as Extract<RsvpPageData, { kind: 'open' }>).event, imageUrl: null, location: null },
    })
    const meta = await generateMetadata({ params })
    expect(meta.description).toBe('Sabtu, 24 Oktober 2026 · 18.00–20.00 WIB')
    expect((meta.openGraph as { images?: unknown }).images).toBeUndefined()
  })

  it.each([['closed'], ['disabled']] as const)('%s -> generic title, noindex, no image, no event data', async (kind) => {
    mockPageData.mockResolvedValue({ kind })
    const meta = await generateMetadata({ params })
    expect(meta).toEqual({
      robots: { index: false, follow: false },
      referrer: 'no-referrer',
      title: 'id:rsvp.meta.title_generic',
    })
  })

  it('locale cookie absent -> id translations even though the admin default is en', async () => {
    await generateMetadata({ params })
    expect(mockGetTranslations).toHaveBeenCalledWith({ locale: 'id', namespace: 'rsvp.meta' })
    expect(mockPageData).toHaveBeenCalledWith(TOKEN, 'id')
    expect(mockDefaultLanguage).not.toHaveBeenCalled()
  })
})
