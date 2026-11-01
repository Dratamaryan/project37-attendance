// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EventForm } from '../_components/EventForm'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('next-intl', () => ({
  useTranslations:
    () =>
    (key: string, params?: Record<string, string | number>) => {
      if (params) return `${key} ${Object.values(params).join(' ')}`
      return key
    },
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

const mockCreateEvent = vi.fn()
const mockUpdateEvent = vi.fn()

vi.mock('@/lib/actions/events', () => ({
  createEvent: (...args: unknown[]) => mockCreateEvent(...args),
  updateEvent: (...args: unknown[]) => mockUpdateEvent(...args),
}))

// RRuleInput is a client component that also uses next-intl; mock it to avoid
// nested translation setup complexity.
vi.mock('../_components/RRuleBuilder', async () => {
  const actual = await vi.importActual<typeof import('../_components/RRuleBuilder')>(
    '../_components/RRuleBuilder',
  )
  return {
    ...actual,
    RRuleInput: ({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) => (
      <input
        data-testid="rrule-input"
        value={value}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
      />
    ),
  }
})

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fillValidForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/name_label/i), 'Test Event')

  // Select friday_monthly radio
  const radio = screen.getByDisplayValue('friday_monthly')
  await user.click(radio)

  // Set date and time
  const dateInput = screen.getByLabelText(/start_date_label/i)
  await user.clear(dateInput)
  await user.type(dateInput, '2026-12-05')

  const timeInput = screen.getByLabelText(/start_time_label/i)
  await user.clear(timeInput)
  await user.type(timeInput, '18:00')
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('EventForm — create mode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows name field error when name is empty on submit', async () => {
    const user = userEvent.setup()
    render(<EventForm mode="create" />)

    await act(async () => {
      await user.click(screen.getByRole('button', { name: /submit_create/i }))
    })

    expect(screen.getByText('field_error_name')).toBeDefined()
  })

  it('shows event_type error when no type selected', async () => {
    const user = userEvent.setup()
    render(<EventForm mode="create" />)

    await user.type(screen.getByLabelText(/name_label/i), 'My Event')

    await act(async () => {
      await user.click(screen.getByRole('button', { name: /submit_create/i }))
    })

    expect(screen.getByText('field_error_type')).toBeDefined()
  })

  it('shows date error when date is missing', async () => {
    const user = userEvent.setup()
    render(<EventForm mode="create" />)

    await user.type(screen.getByLabelText(/name_label/i), 'My Event')
    await user.click(screen.getByDisplayValue('friday_monthly'))

    await act(async () => {
      await user.click(screen.getByRole('button', { name: /submit_create/i }))
    })

    expect(screen.getByText('field_error_date')).toBeDefined()
  })

  it('calls createEvent with recurrence_rule=FREQ=MONTHLY;BYDAY=2FR for friday_monthly', async () => {
    mockCreateEvent.mockResolvedValue({
      status: 'ok',
      event_id: 'abc',
      instances_created: 26,
    })

    const user = userEvent.setup()
    render(<EventForm mode="create" />)

    await fillValidForm(user)

    await act(async () => {
      await user.click(screen.getByRole('button', { name: /submit_create/i }))
    })

    expect(mockCreateEvent).toHaveBeenCalledOnce()
    const callArg = mockCreateEvent.mock.calls[0][0]
    expect(callArg.recurrence_rule).toBe('FREQ=MONTHLY;BYDAY=2FR')
    expect(callArg.name).toBe('Test Event')
  })

  it('shows error banner on server error response', async () => {
    mockCreateEvent.mockResolvedValue({
      status: 'error',
      message: 'DB error',
    })

    const user = userEvent.setup()
    render(<EventForm mode="create" />)

    await fillValidForm(user)

    await act(async () => {
      await user.click(screen.getByRole('button', { name: /submit_create/i }))
    })

    expect(screen.getByRole('alert')).toBeDefined()
  })
})

// ── S9.5-T5.5: schedule lock + schedule notes ─────────────────────────────────

import type { EventRow } from '@/lib/actions/events.types'

const SAT_EVENT: EventRow = {
  id: 'ev-sat',
  name: 'Project Day',
  name_id: 'Project Day',
  event_type: 'saturday_monthly',
  start_date: '2026-11-14',
  start_time: '15:00:00',
  duration_min: 210,
  location: 'Hall',
  description: null,
  recurrence_rule: 'FREQ=MONTHLY;BYDAY=2SA',
  active: true,
  schedule_note: null,
  schedule_note_id: null,
  created_by: 'admin-1',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
}

describe('EventForm — edit mode, schedule lock (S9.5-T5.5)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('locked: start date, start time and every type radio are disabled; hint shown', () => {
    render(<EventForm mode="edit" initialData={SAT_EVENT} scheduleLocked />)
    expect(screen.getByTestId('schedule-locked-hint')).toHaveTextContent('schedule_locked_hint')
    expect(screen.getByLabelText(/start_date_label/i)).toBeDisabled()
    expect(screen.getByLabelText(/start_time_label/i)).toBeDisabled()
    for (const type of ['friday_monthly', 'saturday_monthly', 'sunday_monthly', 'adhoc', 'other_recurring']) {
      expect(screen.getByDisplayValue(type)).toBeDisabled()
    }
    // Everything else stays editable
    expect(screen.getByLabelText(/^name_label/i)).toBeEnabled()
    expect(screen.getByLabelText(/duration_label/i)).toBeEnabled()
    expect(screen.getByLabelText('schedule_note_label')).toBeEnabled()
    expect(screen.getByLabelText('schedule_note_id_label')).toBeEnabled()
  })

  it('locked other_recurring: the raw RRULE input is disabled too', () => {
    render(
      <EventForm
        mode="edit"
        initialData={{ ...SAT_EVENT, event_type: 'other_recurring', recurrence_rule: 'FREQ=MONTHLY;BYDAY=4SA' }}
        scheduleLocked
      />,
    )
    expect(screen.getByTestId('rrule-input')).toBeDisabled()
  })

  it('not locked: schedule fields enabled, no hint', () => {
    render(<EventForm mode="edit" initialData={SAT_EVENT} scheduleLocked={false} />)
    expect(screen.queryByTestId('schedule-locked-hint')).not.toBeInTheDocument()
    expect(screen.getByLabelText(/start_time_label/i)).toBeEnabled()
    expect(screen.getByDisplayValue('saturday_monthly')).toBeEnabled()
  })

  it('locked save: sends notes, never the four schedule fields', async () => {
    mockUpdateEvent.mockResolvedValue({ status: 'ok', event_id: 'ev-sat' })
    const user = userEvent.setup()
    render(<EventForm mode="edit" initialData={SAT_EVENT} scheduleLocked />)
    await user.type(screen.getByLabelText('schedule_note_id_label'), '15.00 snack')
    await act(async () => {
      await user.click(screen.getByRole('button', { name: /submit_update/i }))
    })
    expect(mockUpdateEvent).toHaveBeenCalledTimes(1)
    const [id, input] = mockUpdateEvent.mock.calls[0] as [string, Record<string, unknown>]
    expect(id).toBe('ev-sat')
    expect(input).toMatchObject({ schedule_note: null, schedule_note_id: '15.00 snack', duration_min: 210 })
    for (const k of ['event_type', 'start_date', 'start_time', 'recurrence_rule']) {
      expect(input).not.toHaveProperty(k)
    }
  })

  it('unlocked save of an unchanged form re-sends the stored schedule values (time as HH:mm)', async () => {
    mockUpdateEvent.mockResolvedValue({ status: 'ok', event_id: 'ev-sat' })
    const user = userEvent.setup()
    render(<EventForm mode="edit" initialData={SAT_EVENT} scheduleLocked={false} />)
    await act(async () => {
      await user.click(screen.getByRole('button', { name: /submit_update/i }))
    })
    const [, input] = mockUpdateEvent.mock.calls[0] as [string, Record<string, unknown>]
    expect(input).toMatchObject({
      event_type: 'saturday_monthly',
      start_date: '2026-11-14',
      start_time: '15:00',
      recurrence_rule: 'FREQ=MONTHLY;BYDAY=2SA',
    })
  })

  it('schedule_locked result → schedule_locked_banner', async () => {
    mockUpdateEvent.mockResolvedValue({ status: 'schedule_locked' })
    const user = userEvent.setup()
    render(<EventForm mode="edit" initialData={SAT_EVENT} scheduleLocked={false} />)
    await act(async () => {
      await user.click(screen.getByRole('button', { name: /submit_update/i }))
    })
    expect(screen.getByRole('alert')).toHaveTextContent('schedule_locked_banner')
  })

  it('counters start at 0/160 (or the stored length) and follow typing in code points', async () => {
    const user = userEvent.setup()
    render(<EventForm mode="edit" initialData={{ ...SAT_EVENT, schedule_note: 'abc' }} scheduleLocked />)
    expect(screen.getByTestId('schedule_note-counter')).toHaveTextContent('schedule_note_counter 3 160')
    expect(screen.getByTestId('schedule_note_id-counter')).toHaveTextContent('schedule_note_counter 0 160')
    await user.type(screen.getByLabelText('schedule_note_id_label'), '😀☕')
    expect(screen.getByTestId('schedule_note_id-counter')).toHaveTextContent('schedule_note_counter 2 160')
  })

  it('note over 160 code points → field error, no server call', async () => {
    const user = userEvent.setup()
    render(<EventForm mode="edit" initialData={{ ...SAT_EVENT, schedule_note: 'x'.repeat(161) }} scheduleLocked />)
    await act(async () => {
      await user.click(screen.getByRole('button', { name: /submit_update/i }))
    })
    expect(mockUpdateEvent).not.toHaveBeenCalled()
    expect(screen.getByText('field_error_note_too_long 160')).toBeInTheDocument()
  })
})

