// @vitest-environment jsdom
//
// PublicShell logo link + locale props (S9-R1): default links to '/', null
// renders an unlinked logo (/rsvp), and an explicit locale skips getLocale().
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const mockGetLocale = vi.fn(async () => 'en')
vi.mock('next-intl/server', () => ({
  getLocale: () => mockGetLocale(),
}))

vi.mock('next/image', () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} />,
}))

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}))

vi.mock('../LanguageSwitcher', () => ({
  LanguageSwitcher: ({ currentLocale }: { currentLocale: string }) => (
    <span data-testid="lang">{currentLocale}</span>
  ),
}))

import { PublicShell } from '../PublicShell'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('PublicShell', () => {
  it('default: logo links to / and locale comes from getLocale()', async () => {
    render(await PublicShell({ children: <p>body</p> }))
    expect(screen.getByAltText('Project 37').closest('a')).toHaveAttribute('href', '/')
    expect(screen.getByTestId('lang')).toHaveTextContent('en')
    expect(mockGetLocale).toHaveBeenCalled()
  })

  it('logoHref={null}: logo without a link', async () => {
    render(await PublicShell({ children: <p>body</p>, logoHref: null }))
    expect(screen.getByAltText('Project 37').closest('a')).toBeNull()
  })

  it('explicit locale is passed to the switcher without calling getLocale()', async () => {
    render(await PublicShell({ children: <p>body</p>, logoHref: null, locale: 'id' }))
    expect(screen.getByTestId('lang')).toHaveTextContent('id')
    expect(mockGetLocale).not.toHaveBeenCalled()
  })
})
