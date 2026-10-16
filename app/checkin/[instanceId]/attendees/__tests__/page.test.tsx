// @vitest-environment jsdom
//
// Page-level guard + composition for /checkin/[instanceId]/attendees. The data
// layer (RLS, masking, first-timer, children) is covered against real sessions
// in tests/integration/instance-attendees.test.ts; here it is mocked.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import InstanceAttendeesPage from '../page'

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}))
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string>) =>
    params ? `${key} ${Object.values(params).join(' ')}` : key,
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
  notFound: vi.fn(() => {
    throw new Error('NOT_FOUND')
  }),
}))
vi.mock('../_components/AttendeesList', () => ({
  AttendeesList: ({ adults }: { adults: unknown[] }) => <div data-testid="attendees-list">{adults.length}</div>,
}))

const mockImpl = vi.fn()
vi.mock('@/lib/actions/instance-attendees.impl', () => ({
  impl_getInstanceAttendees: (...args: unknown[]) => mockImpl(...args),
}))

let mockClaims: { claims: { sub: string } } | null = { claims: { sub: 'user-1' } }
let mockRole: string | null = 'organizer'
let mockActive = true
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getClaims: async () => ({ data: mockClaims }) },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: mockRole ? { role: mockRole, active: mockActive } : null }),
        }),
      }),
    }),
  }),
}))

const INSTANCE_ID = '11111111-2222-4333-8444-555555555555'
const params = Promise.resolve({ instanceId: INSTANCE_ID })

const OK = {
  status: 'ok',
  instance: { id: INSTANCE_ID, scheduled_at: '2026-06-01T11:00:00Z', status: 'completed', event_name_snapshot: 'Ibadah Jumat' },
  adults: [{ attendance_id: 'a1' }],
  children: [],
}

describe('InstanceAttendeesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockClaims = { claims: { sub: 'user-1' } }
    mockRole = 'organizer'
    mockActive = true
    mockImpl.mockResolvedValue(OK)
  })

  it('unauthenticated -> redirect to /login, no data fetched', async () => {
    mockClaims = null
    await expect(InstanceAttendeesPage({ params })).rejects.toThrow('REDIRECT:/login')
    expect(mockImpl).not.toHaveBeenCalled()
  })

  it('deactivated user -> NotAuthorized, no data fetched', async () => {
    mockActive = false
    render(await InstanceAttendeesPage({ params }))
    expect(screen.getByText('title')).toBeInTheDocument()
    expect(screen.queryByTestId('attendees-list')).not.toBeInTheDocument()
    expect(mockImpl).not.toHaveBeenCalled()
  })

  it('organizer -> list rendered, NO export link', async () => {
    render(await InstanceAttendeesPage({ params }))
    expect(screen.getByTestId('attendees-list')).toBeInTheDocument()
    expect(screen.getByText('Ibadah Jumat')).toBeInTheDocument()
    expect(screen.getByText('scheduled_at 1 Jun 2026 · 18:00')).toBeInTheDocument()
    expect(screen.queryByTestId('instance-export-link')).not.toBeInTheDocument()
    expect(mockImpl).toHaveBeenCalledWith(expect.objectContaining({ instanceId: INSTANCE_ID }))
    // The page never asks for checker emails
    expect(mockImpl.mock.calls[0]![0]).not.toHaveProperty('includeCheckerEmail', true)
  })

  it('admin -> export link to the per-instance export route', async () => {
    mockRole = 'admin'
    render(await InstanceAttendeesPage({ params }))
    expect(screen.getByTestId('instance-export-link'))
      .toHaveAttribute('href', `/api/admin/export/instance/${INSTANCE_ID}`)
  })

  it('unknown / malformed instance -> notFound()', async () => {
    mockImpl.mockResolvedValue({ status: 'not_found' })
    await expect(InstanceAttendeesPage({ params })).rejects.toThrow('NOT_FOUND')
    mockImpl.mockResolvedValue({ status: 'invalid_input' })
    await expect(InstanceAttendeesPage({ params })).rejects.toThrow('NOT_FOUND')
  })

  it('data error -> error message, no list', async () => {
    mockImpl.mockResolvedValue({ status: 'error', message: 'x' })
    render(await InstanceAttendeesPage({ params }))
    expect(screen.getByRole('alert')).toHaveTextContent('error')
    expect(screen.queryByTestId('attendees-list')).not.toBeInTheDocument()
  })
})
