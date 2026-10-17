// @vitest-environment jsdom
//
// S8-T10 /admin/people/new guard: unauthenticated → /login, organizer or
// inactive admin → NotAuthorized, active admin → the add-person form.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import AdminAddPersonPage from '../page'

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}))
vi.mock('next-intl/server', () => ({
  getTranslations: async (ns: string) => (key: string) => `${ns}.${key}`,
}))
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`)
  }),
}))
vi.mock('../add-person-form', () => ({
  AddPersonForm: () => <div data-testid="add-person-form" />,
}))
vi.mock('@/app/admin/_components/not-authorized', () => ({
  NotAuthorized: () => <div data-testid="not-authorized" />,
}))

let mockClaims: { claims: { sub: string } } | null = { claims: { sub: 'user-1' } }
let mockRole = 'admin'
let mockActive = true
const sessionClient = {
  auth: { getClaims: async () => ({ data: mockClaims }) },
  from: () => ({
    select: () => ({
      eq: () => ({
        single: async () => ({ data: { role: mockRole, active: mockActive } }),
      }),
    }),
  }),
}
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => sessionClient,
}))

describe('AdminAddPersonPage', () => {
  beforeEach(() => {
    mockClaims = { claims: { sub: 'user-1' } }
    mockRole = 'admin'
    mockActive = true
  })

  it('unauthenticated → redirect to /login', async () => {
    mockClaims = null
    await expect(AdminAddPersonPage()).rejects.toThrow('REDIRECT:/login')
  })

  it('organizer → NotAuthorized, no form', async () => {
    mockRole = 'organizer'
    render(await AdminAddPersonPage())
    expect(screen.getByTestId('not-authorized')).toBeInTheDocument()
    expect(screen.queryByTestId('add-person-form')).not.toBeInTheDocument()
  })

  it('inactive admin → NotAuthorized, no form', async () => {
    mockActive = false
    render(await AdminAddPersonPage())
    expect(screen.getByTestId('not-authorized')).toBeInTheDocument()
    expect(screen.queryByTestId('add-person-form')).not.toBeInTheDocument()
  })

  it('active admin → renders the form', async () => {
    render(await AdminAddPersonPage())
    expect(screen.getByTestId('add-person-form')).toBeInTheDocument()
    expect(screen.queryByTestId('not-authorized')).not.toBeInTheDocument()
  })
})
