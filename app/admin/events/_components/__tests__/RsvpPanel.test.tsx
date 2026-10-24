// @vitest-environment jsdom
//
// RsvpPanel (S9-R3) component behaviour: WhatsApp share language toggle
// (Indonesian by default, per-viewer, not persisted) and the link section for
// non-scheduled instances. Data aggregation is covered in
// tests/integration/rsvp-admin.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { RsvpPanel } from '../RsvpPanel'
import type { RsvpPanel as RsvpPanelData } from '@/lib/rsvp/admin.types'

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}))
const mockRefresh = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}))
const mockGetOrCreate = vi.fn()
vi.mock('@/lib/rsvp/admin', () => ({
  getOrCreateRsvpLink: (...args: unknown[]) => mockGetOrCreate(...args),
  deactivateRsvpLink: vi.fn(),
  deleteRsvp: vi.fn(),
}))

const INSTANCE_ID = '11111111-2222-4333-8444-555555555555'
const URLS = { id: 'https://wa.me/?text=ID-MESSAGE', en: 'https://wa.me/?text=EN-MESSAGE' }

function panel(link: RsvpPanelData['link'], publicEnabled = true): RsvpPanelData {
  return {
    link,
    publicEnabled,
    totals: {
      responses: 0, coming_people: 0, coming_headcount: 0, coming_children: 0,
      maybe_people: 0, maybe_headcount: 0, not_coming_people: 0,
    },
    buckets: {
      coming_came: 0, coming_no_show: 0, maybe_came: 0, maybe_no_show: 0,
      not_coming_came: 0, not_coming_no_show: 0, walk_in: 0,
    },
    children: { expected: 0, checked_in: 0 },
    rows: [],
  }
}

const ACTIVE = { active: true, url: 'http://localhost:3000/rsvp/tok' }
const INACTIVE = { active: false, url: null }

describe('RsvpPanel — WhatsApp share language', () => {
  beforeEach(() => vi.clearAllMocks())

  it('defaults to the Indonesian share url; ID is the pressed toggle', () => {
    render(<RsvpPanel instanceId={INSTANCE_ID} instanceStatus="scheduled" panel={panel(ACTIVE)} whatsAppUrls={URLS} />)
    const link = screen.getByTestId('rsvp-whatsapp-link')
    expect(link).toHaveAttribute('href', URLS.id)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
    expect(screen.getByTestId('rsvp-whatsapp-lang-id')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('rsvp-whatsapp-lang-en')).toHaveAttribute('aria-pressed', 'false')
  })

  it('selecting EN switches the button to the English url, and back to ID', () => {
    render(<RsvpPanel instanceId={INSTANCE_ID} instanceStatus="scheduled" panel={panel(ACTIVE)} whatsAppUrls={URLS} />)
    fireEvent.click(screen.getByTestId('rsvp-whatsapp-lang-en'))
    expect(screen.getByTestId('rsvp-whatsapp-link')).toHaveAttribute('href', URLS.en)
    expect(screen.getByTestId('rsvp-whatsapp-lang-en')).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByTestId('rsvp-whatsapp-lang-id'))
    expect(screen.getByTestId('rsvp-whatsapp-link')).toHaveAttribute('href', URLS.id)
  })
})

describe('RsvpPanel — link section by instance status', () => {
  beforeEach(() => vi.clearAllMocks())

  it('scheduled, no active link -> Get-link button', () => {
    render(<RsvpPanel instanceId={INSTANCE_ID} instanceStatus="scheduled" panel={panel(INACTIVE)} whatsAppUrls={null} />)
    expect(screen.getByTestId('rsvp-get-link-button')).toHaveTextContent('get_link_button')
    expect(screen.queryByTestId('rsvp-scheduled-only')).not.toBeInTheDocument()
  })

  it.each([['completed'], ['cancelled']])('%s, no active link -> scheduled-only note, no button', status => {
    render(<RsvpPanel instanceId={INSTANCE_ID} instanceStatus={status} panel={panel(INACTIVE)} whatsAppUrls={null} />)
    expect(screen.getByTestId('rsvp-scheduled-only')).toHaveTextContent('link_scheduled_only')
    expect(screen.queryByTestId('rsvp-get-link-button')).not.toBeInTheDocument()
  })

  it('completed but a link is still active -> link controls still shown (so it can be deactivated)', () => {
    render(<RsvpPanel instanceId={INSTANCE_ID} instanceStatus="completed" panel={panel(ACTIVE)} whatsAppUrls={URLS} />)
    expect(screen.getByTestId('rsvp-link-url')).toHaveValue(ACTIVE.url)
    expect(screen.getByTestId('rsvp-deactivate-button')).toBeInTheDocument()
    expect(screen.queryByTestId('rsvp-scheduled-only')).not.toBeInTheDocument()
  })

  it('flag off -> not-live note regardless of status', () => {
    render(<RsvpPanel instanceId={INSTANCE_ID} instanceStatus="completed" panel={panel(INACTIVE, false)} whatsAppUrls={null} />)
    expect(screen.getByTestId('rsvp-not-live')).toBeInTheDocument()
    expect(screen.queryByTestId('rsvp-scheduled-only')).not.toBeInTheDocument()
  })
})
