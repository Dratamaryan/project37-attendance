// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CheckinClient } from '../checkin-client'
import type { LookupResult } from '@/lib/actions/people.types'
import type { NearestInstanceRow } from '@/lib/actions/events.types'
import type { CreateAttendanceResult } from '@/lib/actions/attendance.types'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('next-intl', () => ({
  // Embed param values so interpolated strings are assertable (Task 9 pattern):
  // t('results.success', { name: 'Budi' }) → 'results.success Budi'
  useTranslations: () => (key: string, params?: Record<string, string>) => {
    if (params) return `${key} ${Object.values(params).join(' ')}`
    return key
  },
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
}))

vi.mock('@/lib/storage/photos', () => ({
  getPhotoSignedUrl: vi.fn().mockResolvedValue({ status: 'no_photo' }),
}))

import { lookupByPhone } from '@/lib/actions/people'
import { createAttendance } from '@/lib/actions/attendance'
const mockLookup = vi.mocked(lookupByPhone)
const mockCreateAttendance = vi.mocked(createAttendance)

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
    // Default: attendance write succeeds for whichever person is checked in
    mockCreateAttendance.mockImplementation(async (input) => okAttendance(input.personId))
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

  it('check-in button calls createAttendance and adds person to recent panel', async () => {
    mockLookup.mockResolvedValue(FOUND_RESULT)
    const { user, input } = setup()
    await user.type(input, '081234567890')
    const checkInBtn = await screen.findByRole('button', { name: 'check_in_button' }, { timeout: 1000 })
    await user.click(checkInBtn)
    // After check-in: input cleared, PersonCard gone, name only in recent panel
    const recentPanel = screen.getByTestId('recent-panel')
    await waitFor(() => expect(within(recentPanel).getByText('Budi Santoso')).toBeInTheDocument(), { timeout: 500 })
    expect(mockCreateAttendance).toHaveBeenCalledWith({
      personId: FOUND_PERSON.id,
      eventInstanceId: 'inst-001',
    })
  })

  it('check-in deduplicates by person id', async () => {
    mockLookup.mockResolvedValue(FOUND_RESULT)
    const { user, input } = setup()

    // First check-in
    await user.type(input, '081234567890')
    const checkInBtn1 = await screen.findByRole('button', { name: 'check_in_button' }, { timeout: 1000 })
    await user.click(checkInBtn1)

    // After check-in rawPhone=''. Re-type the same phone: debounce fires (fireCount increments
    // even for the same settled value) so the effect re-fires and PersonCard appears again.
    // The mock returns ok both times — dedupe is the recent panel's responsibility.
    await user.type(input, '081234567890')
    const checkInBtn2 = await screen.findByRole('button', { name: 'check_in_button' }, { timeout: 1000 })
    await user.click(checkInBtn2)

    // After second check-in the input clears; Budi Santoso should appear only once in recent panel
    const recentPanel = screen.getByTestId('recent-panel')
    await waitFor(() => {
      const items = within(recentPanel).getAllByText('Budi Santoso')
      expect(items.length).toBe(1)
    }, { timeout: 500 })
  })

  it('recent panel caps at 10 entries', async () => {
    // 11 iterations × ~350ms debounce each — needs an extended timeout.
    // Each person gets a distinct phone so that after check-in, typing the new phone
    // changes debouncedPhone, naturally re-firing the lookup without consuming extra mocks.
    const people = Array.from({ length: 11 }, (_, i) => ({
      ...FOUND_PERSON,
      id: `person-${i}`,
      phone_e164: `+628123456${i.toString().padStart(3, '0')}`,
      full_name: `Person ${i}`,
    }))

    const { user, input } = setup()

    for (const person of people) {
      mockLookup.mockResolvedValueOnce({ status: 'found', person })
      // Each person has a unique local-format phone (strip +62, prepend 0)
      const localPhone = `0${person.phone_e164.slice(3)}`
      await user.clear(input)
      await user.type(input, localPhone)
      const btn = await screen.findByRole('button', { name: 'check_in_button' }, { timeout: 1000 })
      await user.click(btn)
      await new Promise((r) => setTimeout(r, 50))
    }

    // Only 10 items should be in the list (oldest dropped)
    const recentPanel = screen.getByTestId('recent-panel')
    const listItems = within(recentPanel).getAllByRole('listitem')
    expect(listItems.length).toBe(10)
  }, 20000)

  it('clicking a recent entry re-populates phone input', async () => {
    mockLookup.mockResolvedValue(FOUND_RESULT)
    const { user, input } = setup()
    await user.type(input, '081234567890')
    const checkInBtn = await screen.findByRole('button', { name: 'check_in_button' }, { timeout: 1000 })
    await user.click(checkInBtn)

    // Click the recent item button (it contains Budi Santoso's name)
    const recentPanel = screen.getByTestId('recent-panel')
    const recentBtn = await within(recentPanel).findByRole('button', { name: /Budi Santoso/i }, { timeout: 500 })
    await user.click(recentBtn)

    // Phone input should now contain the person's e164 number
    expect(input.value).toBe(FOUND_PERSON.phone_e164)
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

  it('CC-02: already_checked_in shows banner with existing time; recent panel NOT updated', async () => {
    mockLookup.mockResolvedValue(FOUND_RESULT)
    mockCreateAttendance.mockResolvedValue(ALREADY_RESULT)
    const { user, input } = setup()
    await user.type(input, '081234567890')
    const checkInBtn = await screen.findByRole('button', { name: 'check_in_button' }, { timeout: 1000 })
    await user.click(checkInBtn)

    const banner = await screen.findByTestId('checkin-feedback', {}, { timeout: 500 })
    expect(banner).toHaveTextContent('results.already_checked_in')
    expect(banner).toHaveTextContent('11:30') // existing 2026-06-11T04:30:00Z in Asia/Jakarta

    const recentPanel = screen.getByTestId('recent-panel')
    expect(within(recentPanel).queryByText('Budi Santoso')).not.toBeInTheDocument()
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
    expect(within(recentPanel).getByText('Budi Santoso')).toBeInTheDocument()
  })
})
