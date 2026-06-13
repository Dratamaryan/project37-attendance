// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CheckinClient } from '../checkin-client'
import type { LookupResult } from '@/lib/actions/people.types'
import type { NearestInstanceRow } from '@/lib/actions/events.types'
import type { CreateAttendanceResult, AttendanceWithPerson, ListRecentAttendanceResult } from '@/lib/actions/attendance.types'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('next-intl', () => ({
  // Embed param values so interpolated strings are assertable (Task 9 pattern):
  // t('results.success', { name: 'Budi' }) → 'results.success Budi'
  useTranslations: () => (key: string, params?: Record<string, string>) => {
    if (params) return `${key} ${Object.values(params).join(' ')}`
    return key
  },
  useLocale: () => 'en',
}))

vi.mock('next/image', () => ({
  default: (props: React.ImgHTMLAttributes<HTMLImageElement>) => {
    // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
    return <img {...props} />
  },
}))

vi.mock('@/lib/actions/people', () => ({
  lookupByPhone: vi.fn(),
}))

vi.mock('@/lib/actions/attendance', () => ({
  createAttendance: vi.fn(),
  listRecentAttendanceForInstance: vi.fn(),
}))

vi.mock('@/lib/storage/photos', () => ({
  getPhotoSignedUrl: vi.fn().mockResolvedValue({ status: 'no_photo' }),
}))

import { lookupByPhone } from '@/lib/actions/people'
import { createAttendance, listRecentAttendanceForInstance } from '@/lib/actions/attendance'
const mockLookup = vi.mocked(lookupByPhone)
const mockCreateAttendance = vi.mocked(createAttendance)
const mockListRecent = vi.mocked(listRecentAttendanceForInstance)

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FOUND_PERSON = {
  id: 'person-001',
  phone_e164: '+6281234567890',
  full_name: 'Budi Santoso',
  nickname: 'Budi',
  email: null,
  birth_date: null,
  gender: null,
  origin_parish: 'Jakarta Selatan',
  marital_status: null,
  photo_url: null,
  photo_publish_consent: false,
  created_at: '2026-01-01T00:00:00Z',
} as const

const FOUND_RESULT: LookupResult = { status: 'found', person: FOUND_PERSON }
const NOT_FOUND_RESULT: LookupResult = { status: 'not_found', normalized_e164: '+6281234567890' }
const INVALID_RESULT: LookupResult = { status: 'invalid_phone', reason: 'invalid_for_country' }
const ERROR_RESULT: LookupResult = { status: 'error', message: 'DB connection failed' }

const INSTANCES: NearestInstanceRow[] = [
  {
    id: 'inst-001',
    event_id: 'event-001',
    scheduled_at: '2026-06-12T11:00:00Z',
    status: 'scheduled',
    event_name_snapshot: 'Test Event Alpha',
    event_name_snapshot_id: null,
  },
]

const INSTANCE_B: NearestInstanceRow = {
  id: 'inst-002',
  event_id: 'event-001',
  scheduled_at: '2026-06-13T11:00:00Z',
  status: 'scheduled',
  event_name_snapshot: 'Test Event Beta',
  event_name_snapshot_id: null,
}

// checked_in_at 2026-06-11T05:00:00Z renders as 12:00 Asia/Jakarta
function okAttendance(personId: string): CreateAttendanceResult {
  return {
    status: 'ok',
    attendance: {
      id: `att-${personId}`,
      event_instance_id: 'inst-001',
      person_id: personId,
      checked_in_at: '2026-06-11T05:00:00Z',
      checked_in_by: 'user-001',
      source: 'volunteer_checkin',
    },
  }
}

function makeAttendanceWithPerson(
  overrides: Partial<AttendanceWithPerson> = {},
): AttendanceWithPerson {
  return {
    id: 'att-001',
    event_instance_id: 'inst-001',
    checked_in_at: '2026-06-11T05:00:00Z',  // 12:00 Asia/Jakarta
    source: 'volunteer_checkin',
    person: {
      id: FOUND_PERSON.id,
      full_name: FOUND_PERSON.full_name,
      nickname: FOUND_PERSON.nickname,
      photo_url: null,
      photo_signed_url: null,
      deleted_at: null,
    },
    ...overrides,
  }
}

const DELETED_ATTENDANCE: AttendanceWithPerson = {
  id: 'att-deleted',
  event_instance_id: 'inst-001',
  checked_in_at: '2026-06-11T04:00:00Z',
  source: 'volunteer_checkin',
  person: {
    id: 'person-deleted',
    full_name: 'Jane Deleted',
    nickname: null,
    photo_url: null,
    photo_signed_url: null,
    deleted_at: '2026-06-10T00:00:00Z',
  },
}

const ALREADY_RESULT: CreateAttendanceResult = {
  status: 'already_checked_in',
  existing: {
    id: 'att-existing',
    event_instance_id: 'inst-001',
    person_id: FOUND_PERSON.id,
    checked_in_at: '2026-06-11T04:30:00Z',
    checked_in_by: 'user-002',
    source: 'volunteer_checkin',
  },
}

function emptyRecent(): ListRecentAttendanceResult {
  return { status: 'ok', attendances: [] }
}

// ── Helper ────────────────────────────────────────────────────────────────────

function setup(instances: NearestInstanceRow[] = INSTANCES) {
  const user = userEvent.setup({ delay: null })
  render(<CheckinClient instances={instances} />)
  const input = screen.getByRole('textbox', { name: 'phone_label' }) as HTMLInputElement
  return { user, input }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CheckinClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: attendance write succeeds; recent list is empty
    mockCreateAttendance.mockImplementation(async (input) => okAttendance(input.personId))
    mockListRecent.mockResolvedValue(emptyRecent())
  })

  it('renders phone input with default country ID', () => {
    setup()
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('ID')
  })

  it('does not call lookupByPhone until 6 digits typed', async () => {
    const { user, input } = setup()
    // Type only 4 digits — should not fire
    await user.type(input, '0812')
    // Flush the debounce timer inside act so the resulting setState is tracked
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400))
    })
    expect(mockLookup).not.toHaveBeenCalled()
  })

  it('debounces lookupByPhone — only one call after rapid typing', async () => {
    mockLookup.mockResolvedValue(FOUND_RESULT)
    const { user, input } = setup()
    // Type quickly — more than 6 digits
    await user.type(input, '081234567890')
    await waitFor(() => expect(mockLookup).toHaveBeenCalledTimes(1), { timeout: 1000 })
  })

  it('shows PersonCard on status found', async () => {
    mockLookup.mockResolvedValue(FOUND_RESULT)
    const { user, input } = setup()
    await user.type(input, '081234567890')
    await waitFor(() => expect(screen.getByText('Budi Santoso')).toBeInTheDocument(), { timeout: 1000 })
  })

  it('shows NewPersonTrigger on status not_found', async () => {
    mockLookup.mockResolvedValue(NOT_FOUND_RESULT)
    const { user, input } = setup()
    await user.type(input, '081234567890')
    await waitFor(
      () => expect(screen.getByText('add_new_person')).toBeInTheDocument(),
      { timeout: 1000 },
    )
  })

  it('shows inline error on status invalid_phone', async () => {
    mockLookup.mockResolvedValue(INVALID_RESULT)
    const { user, input } = setup()
    await user.type(input, '081234567890')
    await waitFor(
      () => expect(screen.getByText('lookup_invalid_phone')).toBeInTheDocument(),
      { timeout: 1000 },
    )
  })

  it('shows error state on status error', async () => {
    mockLookup.mockResolvedValue(ERROR_RESULT)
    const { user, input } = setup()
    await user.type(input, '081234567890')
    await waitFor(
      () => expect(screen.getByText('lookup_error')).toBeInTheDocument(),
      { timeout: 1000 },
    )
  })

  it('stale lookup result does not overwrite newer one', async () => {
    // First call resolves slowly (stale), second resolves fast (fresh)
    let resolveFirst!: (v: LookupResult) => void
    const firstCall = new Promise<LookupResult>((res) => {
      resolveFirst = res
    })
    mockLookup
      .mockReturnValueOnce(firstCall)
      .mockResolvedValue(NOT_FOUND_RESULT)

    const { user, input } = setup()

    // Trigger first lookup — debounce waits wrapped in act so setState is tracked
    await user.type(input, '081234567890')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350)) // past first debounce
    })

    // Clear and type different number — triggers second lookup
    await user.clear(input)
    await user.type(input, '082234567890')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350)) // past second debounce + NOT_FOUND resolves
    })

    // Resolve the first (stale) call with FOUND — the requestId check should discard it.
    // Wrap in act so React tracks the resulting (discarded) transition cleanly.
    await act(async () => {
      resolveFirst(FOUND_RESULT)
      await new Promise((r) => setTimeout(r, 50))
    })

    // The newer NOT_FOUND result should be showing, not the stale FOUND
    expect(screen.queryByText('Budi Santoso')).not.toBeInTheDocument()
    expect(screen.getByText('add_new_person')).toBeInTheDocument()
  })

  it('check-in button calls createAttendance; recent panel updates via refetch', async () => {
    mockLookup.mockResolvedValue(FOUND_RESULT)
    // After check-in the refetch returns Budi Santoso
    mockListRecent
      .mockResolvedValueOnce(emptyRecent())  // initial mount fetch
      .mockResolvedValue({ status: 'ok', attendances: [makeAttendanceWithPerson()] })

    const { user, input } = setup()
    await user.type(input, '081234567890')
    const checkInBtn = await screen.findByRole('button', { name: 'check_in_button' }, { timeout: 1000 })
    await user.click(checkInBtn)

    // After check-in: recent panel shows the refetched person
    const recentPanel = screen.getByTestId('recent-panel')
    await waitFor(() => expect(within(recentPanel).getByText('Budi Santoso')).toBeInTheDocument(), { timeout: 1000 })
    expect(mockCreateAttendance).toHaveBeenCalledWith({
      personId: FOUND_PERSON.id,
      eventInstanceId: 'inst-001',
    })
  })

  it('phone input refocuses after check-in', async () => {
    mockLookup.mockResolvedValue(FOUND_RESULT)
    const { user, input } = setup()
    await user.type(input, '081234567890')
    const checkInBtn = await screen.findByRole('button', { name: 'check_in_button' }, { timeout: 1000 })
    await user.click(checkInBtn)

    // After check-in the input should be cleared
    await waitFor(() => expect(input.value).toBe(''), { timeout: 500 })
    // Focus check: waitFor because the focus is in a setTimeout(0)
    await waitFor(() => expect(document.activeElement).toBe(input), { timeout: 200 })
  })

  // ── T8: attendance result handling ──────────────────────────────────────────

  it('CC-01: ok result shows success feedback with person name and time', async () => {
    mockLookup.mockResolvedValue(FOUND_RESULT)
    const { user, input } = setup()
    await user.type(input, '081234567890')
    const checkInBtn = await screen.findByRole('button', { name: 'check_in_button' }, { timeout: 1000 })
    await user.click(checkInBtn)

    const banner = await screen.findByTestId('checkin-feedback', {}, { timeout: 500 })
    expect(banner).toHaveTextContent('results.success')
    expect(banner).toHaveTextContent('Budi Santoso')
    expect(banner).toHaveTextContent('12:00') // 2026-06-11T05:00:00Z in Asia/Jakarta
  })

  it('CC-02: already_checked_in shows banner with existing time; listRecentAttendanceForInstance NOT called for duplicate', async () => {
    mockLookup.mockResolvedValue(FOUND_RESULT)
    mockCreateAttendance.mockResolvedValue(ALREADY_RESULT)
    const { user, input } = setup()

    // Let the initial mount fetch settle
    await waitFor(() => expect(mockListRecent).toHaveBeenCalledTimes(1))

    await user.type(input, '081234567890')
    const checkInBtn = await screen.findByRole('button', { name: 'check_in_button' }, { timeout: 1000 })
    await user.click(checkInBtn)

    const banner = await screen.findByTestId('checkin-feedback', {}, { timeout: 500 })
    expect(banner).toHaveTextContent('results.already_checked_in')
    expect(banner).toHaveTextContent('11:30') // existing 2026-06-11T04:30:00Z in Asia/Jakarta

    // No additional refetch on duplicate — only the initial mount call
    await act(async () => { await new Promise((r) => setTimeout(r, 100)) })
    expect(mockListRecent).toHaveBeenCalledTimes(1)

    // The PersonCard stays visible so the organizer can act on the message
    expect(screen.getByRole('button', { name: 'check_in_button' })).toBeInTheDocument()
  })

  it('CC-03: event_cancelled shows error feedback; EventSelector remains visible', async () => {
    mockLookup.mockResolvedValue(FOUND_RESULT)
    mockCreateAttendance.mockResolvedValue({ status: 'event_cancelled' })
    const { user, input } = setup()
    await user.type(input, '081234567890')
    const checkInBtn = await screen.findByRole('button', { name: 'check_in_button' }, { timeout: 1000 })
    await user.click(checkInBtn)

    const banner = await screen.findByTestId('checkin-feedback', {}, { timeout: 500 })
    expect(banner).toHaveTextContent('results.event_cancelled')
    expect(screen.getByTestId('event-selector')).toBeInTheDocument()
  })

  it('CC-04: check-in button disabled with inline notice when no event instance', async () => {
    mockLookup.mockResolvedValue(FOUND_RESULT)
    const { user, input } = setup([]) // empty instances → eventInstanceId null
    await user.type(input, '081234567890')
    const checkInBtn = await screen.findByRole('button', { name: 'check_in_button' }, { timeout: 1000 })
    expect(checkInBtn).toBeDisabled()
    expect(screen.getByText('results.no_event_selected')).toBeInTheDocument()
    await user.click(checkInBtn)
    expect(mockCreateAttendance).not.toHaveBeenCalled()
  })

  it('CC-05: button shows pending state while createAttendance is in flight', async () => {
    mockLookup.mockResolvedValue(FOUND_RESULT)
    let resolveAttendance!: (v: CreateAttendanceResult) => void
    mockCreateAttendance.mockReturnValue(
      new Promise<CreateAttendanceResult>((res) => {
        resolveAttendance = res
      }),
    )
    // After check-in succeeds, the refetch returns Budi
    mockListRecent
      .mockResolvedValueOnce(emptyRecent())
      .mockResolvedValue({ status: 'ok', attendances: [makeAttendanceWithPerson()] })

    const { user, input } = setup()
    await user.type(input, '081234567890')
    const checkInBtn = await screen.findByRole('button', { name: 'check_in_button' }, { timeout: 1000 })
    await user.click(checkInBtn)

    // While pending: button disabled with pending label
    const pendingBtn = await screen.findByRole('button', { name: 'check_in_button_pending' }, { timeout: 500 })
    expect(pendingBtn).toBeDisabled()

    // Resolve inside act so the transition settles cleanly
    await act(async () => {
      resolveAttendance(okAttendance(FOUND_PERSON.id))
      await new Promise((r) => setTimeout(r, 50))
    })
    const recentPanel = screen.getByTestId('recent-panel')
    await waitFor(
      () => expect(within(recentPanel).getByText('Budi Santoso')).toBeInTheDocument(),
      { timeout: 1000 },
    )
  })

  // ── T9: real recent panel (CC-06..CC-10) ─────────────────────────────────────

  it('CC-06: recent panel renders attendances from prop; rows ordered descending by time', async () => {
    const att1: AttendanceWithPerson = makeAttendanceWithPerson({
      id: 'att-first',
      checked_in_at: '2026-06-11T05:00:00Z',  // 12:00 Jakarta
      person: { ...makeAttendanceWithPerson().person, id: 'person-001', full_name: 'Budi Santoso' },
    })
    const att2: AttendanceWithPerson = makeAttendanceWithPerson({
      id: 'att-second',
      checked_in_at: '2026-06-11T04:00:00Z',  // 11:00 Jakarta
      person: { ...makeAttendanceWithPerson().person, id: 'person-002', full_name: 'Ani Rahayu' },
    })
    // First call: two attendances ordered desc (att1 newer, att2 older)
    mockListRecent.mockResolvedValue({ status: 'ok', attendances: [att1, att2] })

    setup()

    const recentPanel = await screen.findByTestId('recent-panel')
    await waitFor(() => {
      expect(within(recentPanel).getByText('Budi Santoso')).toBeInTheDocument()
      expect(within(recentPanel).getByText('Ani Rahayu')).toBeInTheDocument()
    }, { timeout: 1000 })

    const items = within(recentPanel).getAllByRole('listitem')
    expect(items.length).toBe(2)
    // att1 (newer) appears first
    expect(items[0]).toHaveTextContent('Budi Santoso')
    expect(items[1]).toHaveTextContent('Ani Rahayu')
  })

  it('CC-07: soft-deleted attendee renders with (deleted) badge + muted styling', async () => {
    mockListRecent.mockResolvedValue({ status: 'ok', attendances: [DELETED_ATTENDANCE] })

    setup()

    const recentPanel = await screen.findByTestId('recent-panel')
    await waitFor(() => expect(within(recentPanel).getByText('Jane Deleted')).toBeInTheDocument(), { timeout: 1000 })

    const badge = within(recentPanel).getByTestId('deleted-badge')
    expect(badge).toBeInTheDocument()
    expect(badge.textContent?.toLowerCase()).toContain('deleted')
  })

  it('CC-08: empty state renders the empty message', async () => {
    mockListRecent.mockResolvedValue(emptyRecent())

    setup()

    const recentPanel = await screen.findByTestId('recent-panel')
    await waitFor(
      () => expect(within(recentPanel).getByText('recent_panel.empty')).toBeInTheDocument(),
      { timeout: 1000 },
    )
  })

  it('CC-09: successful check-in triggers a refetch', async () => {
    mockLookup.mockResolvedValue(FOUND_RESULT)
    const { user, input } = setup()

    // Let the initial mount fetch complete
    await waitFor(() => expect(mockListRecent).toHaveBeenCalledTimes(1))

    await user.type(input, '081234567890')
    const checkInBtn = await screen.findByRole('button', { name: 'check_in_button' }, { timeout: 1000 })
    await user.click(checkInBtn)

    // After ok: one more refetch call
    await waitFor(() => expect(mockListRecent).toHaveBeenCalledTimes(2), { timeout: 1000 })
    // Second call uses the same instance id
    expect(mockListRecent).toHaveBeenLastCalledWith({ eventInstanceId: 'inst-001' })
  })

  it('CC-10: instance switch triggers refetch AND panel content changes to new instance data', async () => {
    // Data specific to each instance so we can verify the panel actually re-renders
    const alphaAtt: AttendanceWithPerson = makeAttendanceWithPerson({
      id: 'att-alpha',
      event_instance_id: 'inst-001',
      person: { ...makeAttendanceWithPerson().person, id: 'person-alpha', full_name: 'Alpha Person' },
    })
    const betaAtt: AttendanceWithPerson = makeAttendanceWithPerson({
      id: 'att-beta',
      event_instance_id: 'inst-002',
      person: { ...makeAttendanceWithPerson().person, id: 'person-beta', full_name: 'Beta Person' },
    })

    // Return different data per instance — the old test only checked call count, not rendered output.
    // This stronger version verifies the full render path: state update → re-render → panel content.
    mockListRecent.mockImplementation(async ({ eventInstanceId }) => {
      if (eventInstanceId === 'inst-001') return { status: 'ok', attendances: [alphaAtt] }
      if (eventInstanceId === 'inst-002') return { status: 'ok', attendances: [betaAtt] }
      return emptyRecent()
    })

    const twoInstances = [INSTANCES[0], INSTANCE_B]
    const user = userEvent.setup({ delay: null })
    render(<CheckinClient instances={twoInstances} />)

    const recentPanel = await screen.findByTestId('recent-panel')

    // Initial render shows inst-001 data
    await waitFor(() => expect(within(recentPanel).getByText('Alpha Person')).toBeInTheDocument(), { timeout: 1000 })

    // Switch to inst-002 via EventSelector custom listbox
    const selectorBtn = screen.getByRole('button', { name: 'select_event' })
    await user.click(selectorBtn)
    const betaOption = await screen.findByRole('option', { name: /Test Event Beta/i })
    await user.click(within(betaOption as HTMLElement).getByRole('button'))

    // Panel must show inst-002 data and NOT inst-001 data
    await waitFor(() => expect(within(recentPanel).getByText('Beta Person')).toBeInTheDocument(), { timeout: 1000 })
    expect(within(recentPanel).queryByText('Alpha Person')).not.toBeInTheDocument()

    // Verify the fetch was invoked with the new instance id
    expect(mockListRecent).toHaveBeenCalledWith({ eventInstanceId: 'inst-002' })
  })

  it('CC-11: panel heading updates to show selected event name on instance switch', async () => {
    mockListRecent.mockResolvedValue(emptyRecent())

    const twoInstances = [INSTANCES[0], INSTANCE_B]
    const user = userEvent.setup({ delay: null })
    render(<CheckinClient instances={twoInstances} />)

    const recentPanel = await screen.findByTestId('recent-panel')

    // Initial heading includes inst-001's event name
    await waitFor(
      () => expect(within(recentPanel).getByTestId('recent-panel-heading'))
             .toHaveTextContent('Test Event Alpha'),
      { timeout: 1000 },
    )

    // Switch to inst-002
    const selectorBtn = screen.getByRole('button', { name: 'select_event' })
    await user.click(selectorBtn)
    const betaOption = await screen.findByRole('option', { name: /Test Event Beta/i })
    await user.click(within(betaOption as HTMLElement).getByRole('button'))

    // Heading now shows inst-002's name
    await waitFor(
      () => expect(within(recentPanel).getByTestId('recent-panel-heading'))
             .toHaveTextContent('Test Event Beta'),
      { timeout: 1000 },
    )
  })
})
