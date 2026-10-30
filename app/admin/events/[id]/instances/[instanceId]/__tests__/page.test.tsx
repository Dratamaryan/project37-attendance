// @vitest-environment jsdom
//
// Admin instance detail page (S8-T5 C4): keeps its own admin guard, header,
// edit + cancel controls, and renders the SAME attendee list as
// /checkin/[instanceId]/attendees — impl_getInstanceAttendees on the server
// client + the shared AttendeesList — plus the per-instance export link. The
// data layer itself is covered in tests/integration/instance-attendees.test.ts.
// S9-R3: the RSVP panel is mounted after the attendees block, fed by
// impl_getInstanceRsvpPanel on the same session client (data layer covered in
// tests/integration/rsvp-admin.test.ts).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import AdminInstanceDetailPage from '../page'
import { formatJakarta, toJakartaInstant } from '@/lib/events/timezone'

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
vi.mock('@/app/admin/events/_components/RescheduleInstanceDialog', () => ({
  RescheduleInstanceDialog: ({ instanceId, fromLabel, defaultDate, defaultTime }: {
    instanceId: string; fromLabel: string; defaultDate: string; defaultTime: string
  }) => (
    <button data-testid="reschedule-dialog">{`${instanceId}|${fromLabel}|${defaultDate}|${defaultTime}`}</button>
  ),
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

const mockRsvpImpl = vi.fn()
vi.mock('@/lib/rsvp/admin.impl', () => ({
  impl_getInstanceRsvpPanel: (...args: unknown[]) => mockRsvpImpl(...args),
}))
const mockShare = vi.fn()
vi.mock('@/lib/rsvp/share', () => ({
  buildWhatsAppShareUrl: (...args: unknown[]) => mockShare(...args),
  formatShareDateLabel: (_d: Date, locale: string) => `date-${locale}`,
}))
vi.mock('@/app/admin/events/_components/RsvpPanel', () => ({
  RsvpPanel: ({ instanceId, instanceStatus, panel, whatsAppUrls }: {
    instanceId: string
    instanceStatus: string
    panel: { rows: unknown[] }
    whatsAppUrls: { id: string; en: string } | null
  }) => (
    <div data-testid="rsvp-panel">
      {`${instanceId}|${instanceStatus}|${panel.rows.length}|${whatsAppUrls ? `${whatsAppUrls.id},${whatsAppUrls.en}` : 'none'}`}
    </div>
  ),
}))

const RSVP_URL = 'http://localhost:3000/rsvp/tok'
function rsvpPanel(url: string | null) {
  return {
    status: 'ok',
    panel: {
      link: { active: url !== null, url },
      publicEnabled: true,
      totals: {},
      buckets: {},
      children: { expected: 0, checked_in: 0 },
      rows: [{ rsvp_id: 'r1' }, { rsvp_id: 'r2' }, { rsvp_id: 'r3' }],
    },
  }
}

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
    mockRsvpImpl.mockResolvedValue(rsvpPanel(null))
    mockShare.mockImplementation(({ locale }: { locale: string }) => `https://wa.me/?text=${locale}`)
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
    expect(screen.queryByTestId('rsvp-panel')).not.toBeInTheDocument()
    expect(mockRsvpImpl).not.toHaveBeenCalled()
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

  it('image_url set -> header thumbnail <img> with the occurrence name as alt (S9-P0)', async () => {
    const imageUrl = 'http://127.0.0.1:54321/storage/v1/object/public/event-images/instances/i/u.png'
    mockListInstancesForEvent.mockResolvedValue({ status: 'ok', instances: [{ ...INSTANCE, image_url: imageUrl }] })
    render(await AdminInstanceDetailPage({ params }))
    const img = screen.getByTestId('instance-image')
    expect(img).toHaveAttribute('src', imageUrl)
    expect(img.getAttribute('alt')).toBeTruthy()
  })

  it('image_url null -> no thumbnail', async () => {
    mockListInstancesForEvent.mockResolvedValue({ status: 'ok', instances: [{ ...INSTANCE, image_url: null }] })
    render(await AdminInstanceDetailPage({ params }))
    expect(screen.queryByTestId('instance-image')).not.toBeInTheDocument()
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

  it('admin -> RsvpPanel mounted after the attendees list, fed by impl_getInstanceRsvpPanel on the session client (S9-R3)', async () => {
    render(await AdminInstanceDetailPage({ params }))
    expect(mockRsvpImpl).toHaveBeenCalledWith(INSTANCE_ID, sessionClient)
    const panel = screen.getByTestId('rsvp-panel')
    expect(panel).toHaveTextContent(`${INSTANCE_ID}|scheduled|3|none`)
    // DOM order: attendees list precedes the RSVP panel.
    const list = screen.getByTestId('attendees-list')
    expect(list.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(mockShare).not.toHaveBeenCalled()
  })

  it('active link url -> BOTH share urls (id + en) built server-side, independent of the UI locale (en here)', async () => {
    mockRsvpImpl.mockResolvedValue(rsvpPanel(RSVP_URL))
    render(await AdminInstanceDetailPage({ params }))
    expect(mockShare).toHaveBeenCalledTimes(2)
    expect(mockShare).toHaveBeenCalledWith(expect.objectContaining({ url: RSVP_URL, locale: 'id', dateLabel: 'date-id' }))
    expect(mockShare).toHaveBeenCalledWith(expect.objectContaining({ url: RSVP_URL, locale: 'en', dateLabel: 'date-en' }))
    expect(screen.getByTestId('rsvp-panel'))
      .toHaveTextContent(`${INSTANCE_ID}|scheduled|3|https://wa.me/?text=id,https://wa.me/?text=en`)
  })

  it('passes the instance status to the panel (completed)', async () => {
    mockListInstancesForEvent.mockResolvedValue({ status: 'ok', instances: [{ ...INSTANCE, status: 'completed' }] })
    render(await AdminInstanceDetailPage({ params }))
    expect(screen.getByTestId('rsvp-panel')).toHaveTextContent(`${INSTANCE_ID}|completed|3|none`)
  })

  it('RSVP panel error -> alert in its place; attendees still render', async () => {
    mockRsvpImpl.mockResolvedValue({ status: 'error', message: 'x' })
    render(await AdminInstanceDetailPage({ params }))
    expect(screen.queryByTestId('rsvp-panel')).not.toBeInTheDocument()
    expect(screen.getByTestId('rsvp-panel-error')).toHaveTextContent('admin.events.instance.rsvp.error_load')
    expect(screen.getByTestId('attendees-list')).toBeInTheDocument()
  })

  // ── S9.5-T4 reschedule ──────────────────────────────────────────────────────

  describe('reschedule (S9.5-T4)', () => {
    // 15:00 WIB, 30 days from the real clock (the page compares against new Date())
    const futureAt = toJakartaInstant(formatJakarta(new Date(Date.now() + 30 * 86_400_000), 'yyyy-MM-dd'), '15:00')
    const FUTURE = { ...INSTANCE, scheduled_at: futureAt.toISOString() }
    const futureDate = formatJakarta(futureAt, 'yyyy-MM-dd')
    const RECURRING = {
      id: EVENT_ID, name: 'Project Day', name_id: 'Project Day',
      event_type: 'saturday_monthly', recurrence_rule: 'FREQ=MONTHLY;BYDAY=2SA', active: true,
    }

    beforeEach(() => {
      mockListEvents.mockResolvedValue({ status: 'ok', events: [RECURRING] })
      mockListInstancesForEvent.mockResolvedValue({ status: 'ok', instances: [FUTURE] })
    })

    it('future scheduled occurrence of an active recurring event -> Reschedule control with WIB defaults', async () => {
      render(await AdminInstanceDetailPage({ params }))
      expect(screen.getByTestId('reschedule-dialog'))
        .toHaveTextContent(`${INSTANCE_ID}|${futureDate} 15:00|${futureDate}|15:00`)
    })

    it.each([
      ['adhoc event', { event: { ...RECURRING, event_type: 'adhoc', recurrence_rule: null } }],
      ['recurring type without a rule', { event: { ...RECURRING, recurrence_rule: null } }],
      ['inactive event', { event: { ...RECURRING, active: false } }],
      ['past occurrence', { instance: { ...FUTURE, scheduled_at: '2026-01-10T08:00:00Z' } }],
      ['cancelled occurrence', { instance: { ...FUTURE, status: 'cancelled' } }],
      ['completed occurrence', { instance: { ...FUTURE, status: 'completed' } }],
    ] as const)('no Reschedule control for %s', async (_label, over) => {
      if ('event' in over) mockListEvents.mockResolvedValue({ status: 'ok', events: [over.event] })
      if ('instance' in over) mockListInstancesForEvent.mockResolvedValue({ status: 'ok', instances: [over.instance] })
      render(await AdminInstanceDetailPage({ params }))
      expect(screen.queryByTestId('reschedule-dialog')).not.toBeInTheDocument()
    })

    it('?rescheduled=1 -> success banner; absent otherwise', async () => {
      const { unmount } = render(await AdminInstanceDetailPage({ params, searchParams: Promise.resolve({ rescheduled: '1' }) }))
      expect(screen.getByTestId('reschedule-success-banner'))
        .toHaveTextContent('admin.events.instance.reschedule.banner_success')
      unmount()
      render(await AdminInstanceDetailPage({ params, searchParams: Promise.resolve({}) }))
      expect(screen.queryByTestId('reschedule-success-banner')).not.toBeInTheDocument()
    })

    it('cancelled original shows its reschedule note', async () => {
      const note = 'Rescheduled to 2027-01-16 15:00 WIB: Venue unavailable'
      mockListInstancesForEvent.mockResolvedValue({ status: 'ok', instances: [{ ...FUTURE, status: 'cancelled', notes: note }] })
      render(await AdminInstanceDetailPage({ params }))
      expect(screen.getByText(note)).toBeInTheDocument()
      expect(screen.getByText('Cancelled')).toBeInTheDocument()
    })
  })
})
