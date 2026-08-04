// @vitest-environment jsdom
//
// The invite link's admin-only guarantee comes from the page that hosts this
// list (/admin/events/[id], already admin-gated per D14) — this test only
// confirms the link itself renders with the right href per instance.
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { InstanceList } from '../_components/InstanceList'
import type { EventInstanceRow, EventRow } from '@/lib/actions/events.types'

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
}))
vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string; [key: string]: unknown }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}))

const event: EventRow = {
  id: 'event-1',
  name: 'Project Day',
  name_id: null,
  event_type: 'adhoc',
  start_date: '2026-08-14',
  start_time: '18:00',
  duration_min: 120,
  location: null,
  description: null,
  recurrence_rule: null,
  active: true,
  created_by: 'admin-1',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
}

const instance: EventInstanceRow = {
  id: 'inst-1',
  event_id: 'event-1',
  scheduled_at: '2099-08-14T11:00:00.000Z',
  event_name_snapshot: 'Project Day',
  event_name_snapshot_id: null,
  status: 'scheduled',
  notes: null,
  image_url: null,
  created_at: '2026-01-01T00:00:00.000Z',
}

describe('InstanceList — invite navigation control', () => {
  it('renders an Invite link per instance pointing at the invite route', () => {
    render(<InstanceList instances={[instance]} event={event} eventId="event-1" />)

    const link = screen.getByTestId('invite-link-inst-1')
    expect(link).toHaveAttribute('href', '/admin/events/event-1/instances/inst-1/invite')
  })
})
