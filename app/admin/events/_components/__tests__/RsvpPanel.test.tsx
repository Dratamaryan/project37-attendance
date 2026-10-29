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

describe('RsvpPanel — export', () => {
  it.each([
    ['active link', ACTIVE, true],
    ['no link', INACTIVE, true],
    ['flag off', INACTIVE, false],
  ])('%s -> "Export to Excel" anchor to the per-instance RSVP export route', (_label, link, enabled) => {
    render(<RsvpPanel instanceId={INSTANCE_ID} instanceStatus="completed" panel={panel(link, enabled)} whatsAppUrls={null} />)
    const a = screen.getByTestId('rsvp-export-link')
    expect(a.tagName).toBe('A')
    expect(a).toHaveAttribute('href', `/api/admin/export/instance/${INSTANCE_ID}/rsvp`)
    expect(a).toHaveTextContent('export_button')
  })
})

describe('RsvpPanel — anonymized rows (S9-R5)', () => {
  const row = (over: Partial<RsvpPanelData['rows'][number]>): RsvpPanelData['rows'][number] => ({
    rsvp_id: 'r1', display_kind: 'newcomer', display_name: null, status: 'coming', children_count: 0,
    followup_consent: true, phone_masked: null, created_at: '2026-07-01T10:00:00Z',
    updated_at: '2026-07-01T10:00:00Z', attended: true, anonymized: true, ...over,
  })

  // The panel sees the same row shape whether a member resolved via person_id
  // or via the frozen retained_person_id — both arrive as kind 'member' with
  // the roster name (resolution is covered in rsvp-retention.test.ts).
  it.each([
    ['member matched at submit', row({ display_kind: 'member', display_name: '[SYNTH] Member' }), '[SYNTH] Member', 'list.badge_member'],
    ['member via frozen link', row({ display_kind: 'member', display_name: '[SYNTH] Door Newcomer' }), '[SYNTH] Door Newcomer', 'list.badge_member'],
    ['removed member', row({ display_kind: 'removed_member', display_name: null }), 'list.removed_member', null],
    ['unresolved newcomer', row({ display_kind: 'newcomer', display_name: null }), 'list.anonymized', 'list.badge_newcomer'],
  ])('%s -> name "%s"... follow-up label hidden, kind badge kept', (_label, r, name, badge) => {
    render(<RsvpPanel instanceId={INSTANCE_ID} instanceStatus="completed" panel={{ ...panel(INACTIVE), rows: [r] }} whatsAppUrls={null} />)
    expect(screen.getByTestId('rsvp-row-name')).toHaveTextContent(name)
    expect(screen.queryByText(/list\.followup_yes/)).not.toBeInTheDocument()
    if (badge) expect(screen.getByText(badge)).toBeInTheDocument()
  })

  it('newcomer who left the name blank, not scrubbed -> "no name", not the anonymized label', () => {
    render(<RsvpPanel instanceId={INSTANCE_ID} instanceStatus="completed"
      panel={{ ...panel(INACTIVE), rows: [row({ anonymized: false, display_name: null })] }} whatsAppUrls={null} />)
    expect(screen.getByTestId('rsvp-row-name')).toHaveTextContent('list.no_name')
  })

  it('not anonymized -> name and follow-up label as before', () => {
    render(<RsvpPanel instanceId={INSTANCE_ID} instanceStatus="completed"
      panel={{ ...panel(INACTIVE), rows: [row({ anonymized: false, display_name: '[SYNTH] Newcomer', phone_masked: '•••• 1234' })] }}
      whatsAppUrls={null} />)
    expect(screen.getByTestId('rsvp-row-name')).toHaveTextContent('[SYNTH] Newcomer')
    expect(screen.getByText(/list\.followup_yes/)).toBeInTheDocument()
  })
})

describe('RsvpPanel — S9.5-T5 coming-only totals', () => {
  // Legacy fixture: 2 coming (1 + 2 children), 1 maybe (1 child), 1 not_coming.
  // Totals/buckets arrive as impl_getInstanceRsvpPanel builds them (maybe /
  // not_coming excluded from every coming figure; their buckets still counted).
  const legacy: RsvpPanelData = {
    ...panel(INACTIVE),
    totals: { responses: 4, coming_people: 2, coming_headcount: 4, coming_children: 2 },
    buckets: {
      coming_came: 1, coming_no_show: 1, maybe_came: 1, maybe_no_show: 0,
      not_coming_came: 0, not_coming_no_show: 1, walk_in: 3,
    },
    children: { expected: 2, checked_in: 1 },
    rows: [
      { rsvp_id: 'c1', display_kind: 'newcomer', display_name: '[SYNTH] C1', status: 'coming', children_count: 0, followup_consent: false, phone_masked: '•••• 0001', created_at: '2026-10-01T01:00:00Z', updated_at: '2026-10-01T01:00:00Z', attended: true, anonymized: false },
      { rsvp_id: 'c2', display_kind: 'newcomer', display_name: '[SYNTH] C2', status: 'coming', children_count: 2, followup_consent: false, phone_masked: '•••• 0002', created_at: '2026-10-01T01:00:00Z', updated_at: '2026-10-01T01:00:00Z', attended: false, anonymized: false },
      { rsvp_id: 'm1', display_kind: 'newcomer', display_name: '[SYNTH] M1', status: 'maybe', children_count: 1, followup_consent: false, phone_masked: '•••• 0003', created_at: '2026-10-01T01:00:00Z', updated_at: '2026-10-01T01:00:00Z', attended: true, anonymized: false },
      { rsvp_id: 'n1', display_kind: 'newcomer', display_name: '[SYNTH] N1', status: 'not_coming', children_count: 0, followup_consent: false, phone_masked: '•••• 0004', created_at: '2026-10-01T01:00:00Z', updated_at: '2026-10-01T01:00:00Z', attended: false, anonymized: false },
    ],
  }

  it('legacy maybe / not_coming rows render; totals show coming figures only', () => {
    render(<RsvpPanel instanceId={INSTANCE_ID} instanceStatus="completed" panel={legacy} whatsAppUrls={null} />)
    expect(screen.getByTestId('rsvp-coming-headcount')).toHaveTextContent('4')
    expect(screen.getByTestId('rsvp-coming-detail')).toHaveTextContent('totals.coming_detail')
    const totals = screen.getByTestId('rsvp-totals')
    expect(totals).not.toHaveTextContent('totals.maybe')
    expect(totals).not.toHaveTextContent('totals.not_coming')
    expect(totals).not.toHaveTextContent('totals.responses')
    expect(screen.queryByTestId('rsvp-maybe')).toBeNull()
    // every row still listed, with its stored status label
    expect(screen.getAllByTestId('rsvp-row')).toHaveLength(4)
    expect(screen.getByText(/list\.status\.maybe/)).toBeInTheDocument()
    expect(screen.getByText(/list\.status\.not_coming/)).toBeInTheDocument()
  })

  it('cross-tab shows only coming + walk-in buckets', () => {
    render(<RsvpPanel instanceId={INSTANCE_ID} instanceStatus="completed" panel={legacy} whatsAppUrls={null} />)
    const shown = screen.getAllByTestId(/^rsvp-bucket-/).map(el => el.getAttribute('data-testid'))
    expect(shown).toEqual(['rsvp-bucket-coming_came', 'rsvp-bucket-coming_no_show', 'rsvp-bucket-walk_in'])
    expect(screen.getByTestId('rsvp-bucket-walk_in')).toHaveTextContent('3')
    expect(screen.getByTestId('rsvp-crosstab')).not.toHaveTextContent(/maybe|not_coming/)
  })
})
