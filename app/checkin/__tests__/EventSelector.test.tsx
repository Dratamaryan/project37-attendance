// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EventSelector } from '../_components/EventSelector'
import type { NearestInstanceRow } from '@/lib/actions/events.types'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, params?: Record<string, string>) => {
    if (params) {
      const paramStr = Object.values(params).join(' ')
      return `${key} ${paramStr}`
    }
    return key
  },
}))

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string
    children: React.ReactNode
    [key: string]: unknown
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

vi.mock('@/lib/events/timezone', () => ({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  formatJakarta: (_date: Date, _fmt: string) => '10 Jun 2026 · 18:00',
  JAKARTA_TZ: 'Asia/Jakarta',
}))

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FUTURE_ISO = new Date(Date.now() + 3 * 3_600_000).toISOString() // 3h from now
const PAST_ISO = new Date(Date.now() - 2 * 3_600_000).toISOString()   // 2h ago

function makeInstance(overrides: Partial<NearestInstanceRow> = {}): NearestInstanceRow {
  return {
    id: 'inst-001',
    event_id: 'evt-001',
    scheduled_at: FUTURE_ISO,
    status: 'scheduled',
    event_name_snapshot: 'Project Day',
    event_name_snapshot_id: null,
    ...overrides,
  }
}

const INSTANCE_A = makeInstance({ id: 'inst-001', event_name_snapshot: 'Project Day' })
const INSTANCE_B = makeInstance({
  id: 'inst-002',
  event_name_snapshot: 'Tribe Connect',
  scheduled_at: new Date(Date.now() + 10 * 24 * 3_600_000).toISOString(),
})
const INSTANCE_C = makeInstance({
  id: 'inst-003',
  event_name_snapshot: 'Sunday Mass',
  scheduled_at: new Date(Date.now() + 20 * 24 * 3_600_000).toISOString(),
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('EventSelector', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders header with first instance name and formatted time', () => {
    render(
      <EventSelector
        instances={[INSTANCE_A, INSTANCE_B]}
        isAdmin={false}
        onInstanceChange={vi.fn()}
      />,
    )

    expect(screen.getByText('Project Day')).toBeInTheDocument()
    // formatJakarta is mocked to return '10 Jun 2026 · 18:00'
    expect(screen.getByText('10 Jun 2026 · 18:00')).toBeInTheDocument()
  })

  it('shows future indicator when nearest instance is in the future', () => {
    render(
      <EventSelector
        instances={[INSTANCE_A]}
        isAdmin={false}
        onInstanceChange={vi.fn()}
      />,
    )

    expect(screen.getByTestId('indicator-future')).toBeInTheDocument()
    // The indicator text contains 'starts_in' (mocked t key)
    expect(screen.getByTestId('indicator-future').textContent).toMatch(/starts_in/)
  })

  it('shows past indicator when nearest instance is in the past', () => {
    const pastInstance = makeInstance({ id: 'inst-past', scheduled_at: PAST_ISO })

    render(
      <EventSelector
        instances={[pastInstance]}
        isAdmin={false}
        onInstanceChange={vi.fn()}
      />,
    )

    expect(screen.getByTestId('indicator-past')).toBeInTheDocument()
    expect(screen.getByTestId('indicator-past').textContent).toMatch(/ended_ago/)
  })

  it('calls onInstanceChange with the selected id when a dropdown item is clicked', async () => {
    const user = userEvent.setup()
    const onInstanceChange = vi.fn()

    render(
      <EventSelector
        instances={[INSTANCE_A, INSTANCE_B, INSTANCE_C]}
        isAdmin={false}
        onInstanceChange={onInstanceChange}
      />,
    )

    // Click header to open dropdown
    await user.click(screen.getByRole('button', { name: 'select_event' }))

    // Dropdown should show other instances (B and C, not A which is in header)
    expect(screen.getByText('Tribe Connect')).toBeInTheDocument()

    // Click Tribe Connect
    await user.click(screen.getByText('Tribe Connect'))

    expect(onInstanceChange).toHaveBeenCalledOnce()
    expect(onInstanceChange).toHaveBeenCalledWith('inst-002')
  })

  it('updates header to show newly selected instance', async () => {
    const user = userEvent.setup()

    render(
      <EventSelector
        instances={[INSTANCE_A, INSTANCE_B]}
        isAdmin={false}
        onInstanceChange={vi.fn()}
      />,
    )

    // Initially shows Project Day
    expect(screen.getByText('Project Day')).toBeInTheDocument()

    // Open dropdown and select Tribe Connect
    await user.click(screen.getByRole('button', { name: 'select_event' }))
    await user.click(screen.getByText('Tribe Connect'))

    // Header should now show Tribe Connect
    expect(screen.getByText('Tribe Connect')).toBeInTheDocument()
    // Project Day may still be in dropdown — we just verify the header updated
  })

  it('does not render dropdown when only one instance', async () => {
    const user = userEvent.setup()

    render(
      <EventSelector
        instances={[INSTANCE_A]}
        isAdmin={false}
        onInstanceChange={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'select_event' }))

    // No listbox since there are no other instances
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('renders empty state notice when instances is empty', () => {
    render(
      <EventSelector instances={[]} isAdmin={false} onInstanceChange={vi.fn()} />,
    )

    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.getByText('no_events')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'select_event' })).not.toBeInTheDocument()
  })

  it('empty state shows admin link for isAdmin=true', () => {
    render(
      <EventSelector instances={[]} isAdmin={true} onInstanceChange={vi.fn()} />,
    )

    const link = screen.getByRole('link', { name: 'no_events_admin_link' })
    expect(link).toBeInTheDocument()
    expect(link).toHaveAttribute('href', '/admin/events/new')
  })

  it('empty state does not show admin link for isAdmin=false', () => {
    render(
      <EventSelector instances={[]} isAdmin={false} onInstanceChange={vi.fn()} />,
    )

    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })
})
