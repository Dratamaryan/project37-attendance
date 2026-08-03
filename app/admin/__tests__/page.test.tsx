// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import AdminHubPage from '../page'

vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
}))
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}))
vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string; [key: string]: unknown }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}))
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`)
  }),
}))

let mockRole: string | null = null
let mockActive = true
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getClaims: async () => ({ data: { claims: { sub: 'user-1' } } }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { role: mockRole, active: mockActive } }),
        }),
      }),
    }),
  }),
}))

describe('AdminHubPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockActive = true
  })

  it('blocks a non-admin with NotAuthorized', async () => {
    mockRole = 'organizer'
    const element = await AdminHubPage()
    render(element)

    expect(screen.getByText('title')).toBeInTheDocument()
    expect(screen.queryByText('cards.people_title')).not.toBeInTheDocument()
  })

  it('blocks a deactivated admin with NotAuthorized', async () => {
    mockRole = 'admin'
    mockActive = false
    const element = await AdminHubPage()
    render(element)

    expect(screen.getByText('title')).toBeInTheDocument()
    expect(screen.queryByText('cards.people_title')).not.toBeInTheDocument()
  })

  it('renders all 7 cards for an admin', async () => {
    mockRole = 'admin'
    const element = await AdminHubPage()
    render(element)

    expect(screen.getByText('cards.people_title')).toBeInTheDocument()
    expect(screen.getByText('cards.events_title')).toBeInTheDocument()
    expect(screen.getByText('cards.analytics_title')).toBeInTheDocument()
    expect(screen.getByText('cards.import_title')).toBeInTheDocument()
    expect(screen.getByText('cards.users_title')).toBeInTheDocument()
    expect(screen.getByText('cards.settings_title')).toBeInTheDocument()
    expect(screen.getByText('cards.audit_log_title')).toBeInTheDocument()
  })

  it('each card links to its correct destination', async () => {
    mockRole = 'admin'
    const element = await AdminHubPage()
    render(element)

    expect(screen.getByText('cards.people_title').closest('a')).toHaveAttribute(
      'href',
      '/admin/people'
    )
    expect(screen.getByText('cards.events_title').closest('a')).toHaveAttribute(
      'href',
      '/admin/events'
    )
    expect(screen.getByText('cards.analytics_title').closest('a')).toHaveAttribute(
      'href',
      '/admin/analytics'
    )
    expect(screen.getByText('cards.import_title').closest('a')).toHaveAttribute(
      'href',
      '/admin/import'
    )
    expect(screen.getByText('cards.users_title').closest('a')).toHaveAttribute(
      'href',
      '/admin/users'
    )
    expect(screen.getByText('cards.settings_title').closest('a')).toHaveAttribute(
      'href',
      '/admin/settings'
    )
    expect(screen.getByText('cards.audit_log_title').closest('a')).toHaveAttribute(
      'href',
      '/admin/audit-log'
    )
  })
})
