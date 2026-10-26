// @vitest-environment jsdom
//
// S9-R5 C2: the rendered /privacy page shows policy v2 in both locales and
// links Cloudflare's Turnstile Privacy Addendum in a new tab. PublicShell is
// an async server component (header + language switcher) — stubbed to a
// passthrough so the page's own output can be rendered.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { type ReactNode } from 'react'

let locale = 'id'
vi.mock('next-intl/server', () => ({ getLocale: async () => locale }))
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }))
vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: ReactNode; href: string; [key: string]: unknown }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}))
vi.mock('@/components/PublicShell', () => ({
  PublicShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

import PrivacyPage from '../page'

const ADDENDUM = 'https://www.cloudflare.com/turnstile-privacy-policy/'

describe('/privacy — policy v2 (S9-R5)', () => {
  beforeEach(() => { locale = 'id' })

  it.each([
    ['id', 'Versi: v2', 'Kebijakan Privasi'],
    ['en', 'Version: v2', 'Privacy Policy'],
  ])('%s: shows "%s" and links the Turnstile Privacy Addendum in a new tab', async (loc, versionText, title) => {
    locale = loc
    const { container } = render(await PrivacyPage())

    expect(screen.getByRole('heading', { level: 1, name: title })).toBeInTheDocument()
    expect(container).toHaveTextContent(versionText)
    expect(container.textContent).not.toMatch(/\bv1\b/)

    const addendum = [...container.querySelectorAll('a')].filter(a => a.getAttribute('href') === ADDENDUM)
    expect(addendum).toHaveLength(1)
    expect(addendum[0]).toHaveAttribute('target', '_blank')
    expect(addendum[0]).toHaveAttribute('rel', 'noopener noreferrer')
  })
})
