// @vitest-environment jsdom
//
// Admin person detail page (S9-R3b): keeps its admin guard, EditPersonForm and
// PersonChildrenSection, and mounts the server-rendered RSVP history section
// AFTER the children section, fed by impl_listPersonRsvpHistory on the same
// session client in the page's locale. The real PersonRsvpHistorySection is
// rendered (not stubbed) so its rows / empty / error states are covered here;
// the data layer is covered in tests/integration/rsvp-person-history.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import AdminPersonEditPage from '../page'

vi.mock('next-intl', () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}))
let mockLocale = 'id'
vi.mock('next-intl/server', () => ({
  getLocale: async () => mockLocale,
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
vi.mock('@/app/admin/_components/not-authorized', () => ({
  NotAuthorized: () => <div data-testid="not-authorized" />,
}))
vi.mock('@/app/admin/people/_components/person-not-found', () => ({
  PersonNotFound: () => <div data-testid="person-not-found" />,
}))
vi.mock('@/app/admin/people/[id]/edit-person-form', () => ({
  EditPersonForm: () => <div data-testid="edit-person-form" />,
}))
vi.mock('@/app/admin/people/person-children-section', () => ({
  PersonChildrenSection: () => <section data-testid="person-children-section" />,
}))

const PERSON_ID = '11111111-2222-4333-8444-555555555555'
const PERSON = { id: PERSON_ID, full_name: '[SYNTH] Page Person', deleted_at: null, photo_url: null }

const mockGetPerson = vi.fn()
vi.mock('@/lib/actions/people', () => ({
  getPersonById: (...args: unknown[]) => mockGetPerson(...args),
}))
vi.mock('@/lib/actions/children', () => ({
  listChildrenByParentForAdmin: async () => ({ status: 'none' }),
}))
vi.mock('@/lib/storage/photos', () => ({
  getPhotoSignedUrl: async () => ({ status: 'none' }),
}))
const mockHistory = vi.fn()
vi.mock('@/lib/rsvp/admin.impl', () => ({
  impl_listPersonRsvpHistory: (...args: unknown[]) => mockHistory(...args),
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

const params = Promise.resolve({ id: PERSON_ID })

const ROWS = [
  {
    rsvp_id: 'r-new', instance_id: 'inst-2', event_id: 'ev-1', scheduled_at: '2026-10-24T11:00:00Z',
    instance_status: 'cancelled', display_name: '[SYNTH] Occurrence Two', rsvp_status: 'maybe', children_count: 1, attended: false,
  },
  {
    rsvp_id: 'r-old', instance_id: 'inst-1', event_id: 'ev-1', scheduled_at: '2026-09-05T11:00:00Z',
    instance_status: 'completed', display_name: '[SYNTH] Occurrence One', rsvp_status: 'coming', children_count: 2, attended: true,
  },
]

describe('AdminPersonEditPage — RSVP history (S9-R3b)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockClaims = { claims: { sub: 'user-1' } }
    mockRole = 'admin'
    mockLocale = 'id'
    mockGetPerson.mockResolvedValue({ status: 'ok', person: PERSON })
    mockHistory.mockResolvedValue({ status: 'ok', rows: ROWS })
  })

  it('admin -> history section mounted AFTER the children section, loaded on the session client in the page locale', async () => {
    render(await AdminPersonEditPage({ params }))
    expect(mockHistory).toHaveBeenCalledWith(PERSON_ID, sessionClient, 'id')
    const children = screen.getByTestId('person-children-section')
    const history = screen.getByTestId('person-rsvp-history')
    expect(children.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByTestId('edit-person-form')).toBeInTheDocument()
  })

  it('en locale is passed through', async () => {
    mockLocale = 'en'
    render(await AdminPersonEditPage({ params }))
    expect(mockHistory).toHaveBeenCalledWith(PERSON_ID, sessionClient, 'en')
  })

  it('rows: WIB date, occurrence link, status, checked-in, cancelled marker on the cancelled one only', async () => {
    render(await AdminPersonEditPage({ params }))
    const rows = screen.getAllByTestId('person-rsvp-row')
    expect(rows).toHaveLength(2)

    expect(within(rows[0]!).getByText('[SYNTH] Occurrence Two')).toHaveAttribute('href', '/admin/events/ev-1/instances/inst-2')
    expect(rows[0]).toHaveTextContent('2026-10-24 18:00')
    expect(rows[0]).toHaveTextContent('admin.people.rsvp_history.status.maybe')
    expect(rows[0]).toHaveTextContent('admin.people.rsvp_history.attended_no')
    expect(within(rows[0]!).getByTestId('person-rsvp-cancelled')).toHaveTextContent('admin.people.rsvp_history.cancelled')

    expect(within(rows[1]!).getByText('[SYNTH] Occurrence One')).toHaveAttribute('href', '/admin/events/ev-1/instances/inst-1')
    expect(rows[1]).toHaveTextContent('2026-09-05 18:00')
    expect(rows[1]).toHaveTextContent('admin.people.rsvp_history.attended_yes')
    expect(within(rows[1]!).queryByTestId('person-rsvp-cancelled')).not.toBeInTheDocument()
  })

  it('no RSVPs -> empty state', async () => {
    mockHistory.mockResolvedValue({ status: 'ok', rows: [] })
    render(await AdminPersonEditPage({ params }))
    expect(screen.getByTestId('person-rsvp-empty')).toHaveTextContent('admin.people.rsvp_history.empty')
    expect(screen.queryByTestId('person-rsvp-row')).not.toBeInTheDocument()
  })

  it('history error -> alert inside the section; the rest of the page still renders', async () => {
    mockHistory.mockResolvedValue({ status: 'error', message: 'x' })
    render(await AdminPersonEditPage({ params }))
    const section = screen.getByTestId('person-rsvp-history')
    expect(within(section).getByRole('alert')).toHaveTextContent('admin.people.rsvp_history.error')
    expect(screen.getByTestId('edit-person-form')).toBeInTheDocument()
    expect(screen.getByTestId('person-children-section')).toBeInTheDocument()
  })

  it('organizer -> NotAuthorized, history never loaded', async () => {
    mockRole = 'organizer'
    render(await AdminPersonEditPage({ params }))
    expect(screen.getByTestId('not-authorized')).toBeInTheDocument()
    expect(screen.queryByTestId('person-rsvp-history')).not.toBeInTheDocument()
    expect(mockHistory).not.toHaveBeenCalled()
  })

  it('unknown person -> PersonNotFound, history never loaded', async () => {
    mockGetPerson.mockResolvedValue({ status: 'not_found' })
    render(await AdminPersonEditPage({ params }))
    expect(screen.getByTestId('person-not-found')).toBeInTheDocument()
    expect(mockHistory).not.toHaveBeenCalled()
  })
})
