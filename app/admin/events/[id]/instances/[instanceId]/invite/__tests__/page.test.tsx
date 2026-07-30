// @vitest-environment jsdom
//
// This page's admin guard must hold on its OWN, independent of the parent
// `events/layout.tsx` role gate (which allows organizer+admin). If a future
// change loosens the layout gate, this page must still reject an organizer by
// itself — so this test drives the guard directly, not "the parent blocks it
// anyway" (T10 plan review requirement #1).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import AdminInviteRecipientsPage from '../page'

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}))
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
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

// Page-level test only proves the guard + happy-path composition — InvitePanel's
// own behavior (preview/send/resend) is covered in InvitePanel.test.tsx.
vi.mock('../_components/InvitePanel', () => ({
  InvitePanel: ({ eventInstanceId }: { eventInstanceId: string }) => (
    <div data-testid="invite-panel">{eventInstanceId}</div>
  ),
}))

const mockListEvents = vi.fn()
const mockListInstancesForEvent = vi.fn()
vi.mock('@/lib/actions/events', () => ({
  listEvents: (...args: unknown[]) => mockListEvents(...args),
  listInstancesForEvent: (...args: unknown[]) => mockListInstancesForEvent(...args),
}))

let mockRole: string | null = null
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getClaims: async () => ({ data: { claims: { sub: 'user-1' } } }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { role: mockRole } }),
        }),
      }),
    }),
  }),
}))

const params = Promise.resolve({ id: 'event-1', instanceId: 'inst-1' })

describe('AdminInviteRecipientsPage — admin guard (independent of the layout gate)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('blocks an organizer with NotAuthorized, on this page alone', async () => {
    mockRole = 'organizer'
    const element = await AdminInviteRecipientsPage({ params })
    render(element)

    // NotAuthorized's own copy (mocked t => key), not the invite panel.
    expect(screen.getByText('title')).toBeInTheDocument()
    expect(screen.queryByTestId('invite-panel')).not.toBeInTheDocument()
    // Guard short-circuits before any recipient data is ever fetched.
    expect(mockListEvents).not.toHaveBeenCalled()
  })

  it('renders the invite panel for an admin', async () => {
    mockRole = 'admin'
    mockListEvents.mockResolvedValue({
      status: 'ok',
      events: [{ id: 'event-1', name: 'Project Day', name_id: null }],
    })
    mockListInstancesForEvent.mockResolvedValue({
      status: 'ok',
      instances: [
        {
          id: 'inst-1',
          event_id: 'event-1',
          scheduled_at: '2026-08-14T11:00:00.000Z',
          status: 'scheduled',
          event_name_snapshot: 'Project Day',
          event_name_snapshot_id: null,
          notes: null,
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    })

    const element = await AdminInviteRecipientsPage({ params })
    render(element)

    expect(screen.getByTestId('invite-panel')).toHaveTextContent('inst-1')
  })
})
