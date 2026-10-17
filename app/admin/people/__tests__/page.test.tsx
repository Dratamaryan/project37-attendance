// @vitest-environment jsdom
//
// /admin/people page: admin guard + the S8-T10 "Add person" header link.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import AdminPeoplePage from '../page'

vi.mock('next-intl/server', () => ({
  getTranslations: async (ns: string) => (key: string) => `${ns}.${key}`,
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
vi.mock('../people-list-client', () => ({
  PeopleListClient: () => <div data-testid="people-list" />,
}))
vi.mock('@/app/admin/_components/not-authorized', () => ({
  NotAuthorized: () => <div data-testid="not-authorized" />,
}))

let mockClaims: { claims: { sub: string } } | null = { claims: { sub: 'user-1' } }
let mockRole = 'admin'
const sessionClient = {
  auth: { getClaims: async () => ({ data: mockClaims }) },
  from: () => ({
    select: () => ({
      eq: () => ({
        single: async () => ({ data: { role: mockRole, active: true } }),
      }),
    }),
  }),
}
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => sessionClient,
}))

describe('AdminPeoplePage', () => {
  beforeEach(() => {
    mockClaims = { claims: { sub: 'user-1' } }
    mockRole = 'admin'
  })

  it('admin → title, the list, and an "Add person" link to /admin/people/new', async () => {
    render(await AdminPeoplePage())
    expect(screen.getByRole('heading', { name: 'admin.people.title' })).toBeInTheDocument()
    expect(screen.getByTestId('people-list')).toBeInTheDocument()
    const link = screen.getByRole('link', { name: /admin\.people\.add\.button/ })
    expect(link).toHaveAttribute('href', '/admin/people/new')
  })

  it('organizer → NotAuthorized, no Add person link', async () => {
    mockRole = 'organizer'
    render(await AdminPeoplePage())
    expect(screen.getByTestId('not-authorized')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /add\.button/ })).not.toBeInTheDocument()
  })

  it('unauthenticated → redirect to /login', async () => {
    mockClaims = null
    await expect(AdminPeoplePage()).rejects.toThrow('REDIRECT:/login')
  })
})
