// @vitest-environment jsdom
//
// Admin instance detail page (S8-T5 C4): keeps its own admin guard, header,
// edit + cancel controls, and renders the SAME attendee list as
// /checkin/[instanceId]/attendees — impl_getInstanceAttendees on the server
// client + the shared AttendeesList — plus the per-instance export link. The
// data layer itself is covered in tests/integration/instance-attendees.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import AdminInstanceDetailPage from '../page'

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}))
vi.mock('next-intl/server', () => ({
  getTranslations: async (ns: string) => (key: string, params?: Record<string, string>) =>
    `${ns}.${key}${params ? ' ' + Object.values(params).join(' ') : ''}`,
  getLocale: async () => 'en',
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
vi.mock('@/app/admin/events/_components/CancelInstanceDialog', () => ({
  CancelInstanceDialog: () => <button data-testid="cancel-dialog">cancel</button>,
}))
vi.mock('@/components/attendees/AttendeesList', () => ({
  AttendeesList: ({ adults, childAttendees }: { adults: unknown[]; childAttendees: unknown[] }) => (
    <div data-testid="attendees-list">{`${adults.length}/${childAttendees.length}`}</div>
  ),
}))

// The page must no longer use the unguarded service-role action.
const mockListRecent = vi.fn()
vi.mock('@/lib/actions/attendance', () => ({
  listRecentAttendanceForInstance: (...args: unknown[]) => mockListRecent(...args),
}))

const mockImpl = vi.fn()
vi.mock('@/lib/actions/instance-attendees.impl', () => ({
  impl_getInstanceAttendees: (...args: unknown[]) => mockImpl(...args),
}))

const mockListEvents = vi.fn()
const mockListInstancesForEvent = vi.fn()
vi.mock('@/lib/actions/events', () => ({
  listEvents: (...args: unknown[]) => mockListEvents(...args),
  listInstancesForEvent: (...args: unknown[]) => mockListInstancesForEvent(...args),
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

const EVENT_ID = 'event-1'
const INSTANCE_ID = '11111111-2222-4333-8444-555555555555'
const params = Promise.resolve({ id: EVENT_ID, instanceId: INSTANCE_ID })

const INSTANCE = {
  id: INSTANCE_ID,
  event_id: EVENT_ID,
  scheduled_at: '2026-10-15T11:00:00Z',
  status: 'scheduled',
  notes: null,
  event_name_snapshot: 'Ibadah Jumat',
  event_name_snapshot_id: 'Ibadah Jumat',
}

describe('AdminInstanceDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockClaims = { claims: { sub: 'user-1' } }
    mockRole = 'admin'
    mockActive = true
    mockListEvents.mockResolvedValue({ status: 'ok', events: [{ id: EVENT_ID, name: 'Ibadah Jumat', name_id: 'Ibadah Jumat' }] })
    mockListInstancesForEvent.mockResolvedValue({ status: 'ok', instances: [INSTANCE] })
    mockImpl.mockResolvedValue({
      status: 'ok',
      instance: INSTANCE,
      adults: [{ attendance_id: 'a1' }, { attendance_id: 'a2' }],
      children: [{ child_attendance_id: 'c1' }],
    })
  })

  it('unauthenticated -> redirect to /login, no attendee data fetched', async () => {
    mockClaims = null
    await expect(AdminInstanceDetailPage({ params })).rejects.toThrow('REDIRECT:/login')
    expect(mockImpl).not.toHaveBeenCalled()
  })

  it('organizer -> NotAuthorized on this page, no attendee data fetched', async () => {
    mockRole = 'organizer'
    render(await AdminInstanceDetailPage({ params }))
    expect(screen.getByText('title')).toBeInTheDocument()
    expect(screen.queryByTestId('attendees-list')).not.toBeInTheDocument()
    expect(mockImpl).not.toHaveBeenCalled()
  })

  it('admin -> shared attendee list from impl_getInstanceAttendees on the session client', async () => {
    render(await AdminInstanceDetailPage({ params }))
    expect(mockImpl).toHaveBeenCalledWith({ supabase: sessionClient, instanceId: INSTANCE_ID })
    expect(screen.getByTestId('attendees-list')).toHaveTextContent('2/1')
    expect(screen.getByTestId('attendee-summary')).toHaveTextContent('checkin.attendees.summary 2 1')
    expect(mockListRecent).not.toHaveBeenCalled()
  })

  it('admin -> export link to the per-instance export route', async () => {
    render(await AdminInstanceDetailPage({ params }))
    expect(screen.getByTestId('instance-export-link'))
      .toHaveAttribute('href', `/api/admin/export/instance/${INSTANCE_ID}`)
    expect(screen.getByTestId('instance-export-link')).toHaveTextContent('checkin.attendees.export_button')
  })

  it('keeps the header: breadcrumb, status badge, edit link, cancel control for a scheduled instance', async () => {
    render(await AdminInstanceDetailPage({ params }))
    expect(screen.getByText('admin.events.instance.breadcrumb_events')).toHaveAttribute('href', '/admin/events')
    expect(screen.getByText('Scheduled')).toBeInTheDocument()
    expect(screen.getByText('admin.events.instance.edit_button'))
      .toHaveAttribute('href', `/admin/events/${EVENT_ID}/instances/${INSTANCE_ID}/edit`)
    expect(screen.getByTestId('cancel-dialog')).toBeInTheDocument()
  })

  it('no cancel control once the instance is completed', async () => {
    mockListInstancesForEvent.mockResolvedValue({ status: 'ok', instances: [{ ...INSTANCE, status: 'completed' }] })
    render(await AdminInstanceDetailPage({ params }))
    expect(screen.getByText('Completed')).toBeInTheDocument()
    expect(screen.queryByTestId('cancel-dialog')).not.toBeInTheDocument()
  })

  it('attendee data error -> alert, no list, no export link; header still renders', async () => {
    mockImpl.mockResolvedValue({ status: 'error', message: 'x' })
    render(await AdminInstanceDetailPage({ params }))
    expect(screen.getByRole('alert')).toHaveTextContent('checkin.attendees.error')
    expect(screen.queryByTestId('attendees-list')).not.toBeInTheDocument()
    expect(screen.queryByTestId('instance-export-link')).not.toBeInTheDocument()
    expect(screen.getByText('admin.events.instance.edit_button')).toBeInTheDocument()
  })
})
