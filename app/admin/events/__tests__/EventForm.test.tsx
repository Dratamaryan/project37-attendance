// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EventForm } from '../_components/EventForm'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('next-intl', () => ({
  useLocale: () => 'en',
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
const mockPreview = vi.fn()

vi.mock('@/lib/actions/events', () => ({
  createEvent: (...args: unknown[]) => mockCreateEvent(...args),
  updateEvent: (...args: unknown[]) => mockUpdateEvent(...args),
  previewScheduleChange: (...args: unknown[]) => mockPreview(...args),
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


// ── S9.5-T5.5 Phase 2: admin schedule move on a locked event ─────────────────

const ADHOC_EVENT: EventRow = {
  ...SAT_EVENT,
  id: 'ev-adhoc',
  event_type: 'adhoc',
  recurrence_rule: null,
  start_date: '2026-11-20',
}

async function setTime(user: ReturnType<typeof userEvent.setup>, value: string) {
  const el = screen.getByLabelText(/start_time_label/i)
  await user.clear(el)
  await user.type(el, value)
}

async function submit(user: ReturnType<typeof userEvent.setup>) {
  await act(async () => {
    await user.click(screen.getByRole('button', { name: /submit_update/i }))
  })
}

describe('EventForm — editable-field matrix (S9.5-T5.5 P2)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const TYPES = ['friday_monthly', 'saturday_monthly', 'sunday_monthly', 'adhoc', 'other_recurring']

  it('SCF-01 admin + locked recurring: start time editable; date + type locked; admin hint', () => {
    render(<EventForm mode="edit" initialData={SAT_EVENT} scheduleLocked isAdmin />)
    expect(screen.getByLabelText(/start_time_label/i)).toBeEnabled()
    expect(screen.getByLabelText(/start_date_label/i)).toBeDisabled()
    for (const type of TYPES) expect(screen.getByDisplayValue(type)).toBeDisabled()
    expect(screen.getByTestId('schedule-locked-hint')).toHaveTextContent('schedule_locked_hint_admin_recurring')
    expect(screen.queryByTestId('schedule-locked-contact-admin')).not.toBeInTheDocument()
  })

  it('SCF-02 admin + locked other_recurring: time editable, raw RRULE locked', () => {
    render(
      <EventForm mode="edit" initialData={{ ...SAT_EVENT, event_type: 'other_recurring', recurrence_rule: 'FREQ=MONTHLY;BYDAY=4SA' }} scheduleLocked isAdmin />,
    )
    expect(screen.getByLabelText(/start_time_label/i)).toBeEnabled()
    expect(screen.getByTestId('rrule-input')).toBeDisabled()
  })

  it('SCF-03 admin + locked adhoc: date + time editable; type locked; adhoc hint', () => {
    render(<EventForm mode="edit" initialData={ADHOC_EVENT} scheduleLocked isAdmin />)
    expect(screen.getByLabelText(/start_time_label/i)).toBeEnabled()
    expect(screen.getByLabelText(/start_date_label/i)).toBeEnabled()
    for (const type of TYPES) expect(screen.getByDisplayValue(type)).toBeDisabled()
    expect(screen.getByTestId('schedule-locked-hint')).toHaveTextContent('schedule_locked_hint_admin_adhoc')
  })

  for (const [label, event] of [['recurring', SAT_EVENT], ['adhoc', ADHOC_EVENT]] as const) {
    it(`SCF-04 organizer + locked ${label}: Phase 1 lock unchanged + contact-admin line`, () => {
      render(<EventForm mode="edit" initialData={event} scheduleLocked isAdmin={false} />)
      expect(screen.getByLabelText(/start_time_label/i)).toBeDisabled()
      expect(screen.getByLabelText(/start_date_label/i)).toBeDisabled()
      for (const type of TYPES) expect(screen.getByDisplayValue(type)).toBeDisabled()
      expect(screen.getByTestId('schedule-locked-hint')).toHaveTextContent('schedule_locked_hint')
      expect(screen.getByTestId('schedule-locked-contact-admin')).toHaveTextContent('schedule_locked_contact_admin')
    })
  }

  it('SCF-05 admin + not locked: everything editable, no hint', () => {
    render(<EventForm mode="edit" initialData={SAT_EVENT} scheduleLocked={false} isAdmin />)
    expect(screen.queryByTestId('schedule-locked-hint')).not.toBeInTheDocument()
    expect(screen.getByLabelText(/start_date_label/i)).toBeEnabled()
    expect(screen.getByDisplayValue('saturday_monthly')).toBeEnabled()
  })
})

describe('EventForm — schedule-change confirm step (S9.5-T5.5 P2)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('SCF-10 R: preview → confirm copy → save with confirmScheduleChange; only start_time sent of the schedule fields', async () => {
    mockPreview.mockResolvedValue({ status: 'ok', shape: 'R', moved: 13, cancelled_moved: 1, to_date: '2026-11-14', to_time: '16:00' })
    mockUpdateEvent.mockResolvedValue({ status: 'ok', event_id: 'ev-sat', schedule_change: { moved: 13, cancelled_moved: 1 } })
    const user = userEvent.setup()
    render(<EventForm mode="edit" initialData={SAT_EVENT} scheduleLocked isAdmin />)
    await setTime(user, '16:00')
    await submit(user)

    expect(mockPreview).toHaveBeenCalledWith('ev-sat', { start_date: '2026-11-14', start_time: '16:00' })
    expect(mockUpdateEvent).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toHaveTextContent('confirm_title')
    // mock t renders "key param1 param2 …" in insertion order: count, time, cancelled
    expect(screen.getByTestId('schedule-change-confirm-body')).toHaveTextContent('confirm_body_recurring 13 16:00 1')

    await act(async () => {
      await user.click(screen.getByRole('button', { name: 'confirm' }))
    })
    expect(mockUpdateEvent).toHaveBeenCalledTimes(1)
    const [id, input, options] = mockUpdateEvent.mock.calls[0] as [string, Record<string, unknown>, unknown]
    expect(id).toBe('ev-sat')
    expect(options).toEqual({ confirmScheduleChange: true })
    expect(input).toMatchObject({ start_time: '16:00', duration_min: 210 })
    for (const k of ['event_type', 'start_date', 'recurrence_rule']) expect(input).not.toHaveProperty(k)
  })

  it('SCF-11 Back closes the confirm step without saving', async () => {
    mockPreview.mockResolvedValue({ status: 'ok', shape: 'R', moved: 2, cancelled_moved: 0, to_date: '2026-11-14', to_time: '16:00' })
    const user = userEvent.setup()
    render(<EventForm mode="edit" initialData={SAT_EVENT} scheduleLocked isAdmin />)
    await setTime(user, '16:00')
    await submit(user)
    await act(async () => {
      await user.click(screen.getByRole('button', { name: 'back' }))
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(mockUpdateEvent).not.toHaveBeenCalled()
  })

  it('SCF-12 A: date + time sent; adhoc confirm copy with a long date', async () => {
    mockPreview.mockResolvedValue({ status: 'ok', shape: 'A', moved: 1, cancelled_moved: 0, to_date: '2026-11-21', to_time: '17:30' })
    mockUpdateEvent.mockResolvedValue({ status: 'ok', event_id: 'ev-adhoc' })
    const user = userEvent.setup()
    render(<EventForm mode="edit" initialData={ADHOC_EVENT} scheduleLocked isAdmin />)
    const dateEl = screen.getByLabelText(/start_date_label/i)
    await user.clear(dateEl)
    await user.type(dateEl, '2026-11-21')
    await setTime(user, '17:30')
    await submit(user)
    expect(mockPreview).toHaveBeenCalledWith('ev-adhoc', { start_date: '2026-11-21', start_time: '17:30' })
    expect(screen.getByTestId('schedule-change-confirm-body')).toHaveTextContent(
      'confirm_body_adhoc Saturday, November 21, 2026 17:30',
    )
    await act(async () => {
      await user.click(screen.getByRole('button', { name: 'confirm' }))
    })
    const [, input, options] = mockUpdateEvent.mock.calls[0] as [string, Record<string, unknown>, unknown]
    expect(options).toEqual({ confirmScheduleChange: true })
    expect(input).toMatchObject({ start_date: '2026-11-21', start_time: '17:30' })
    expect(input).not.toHaveProperty('event_type')
    expect(input).not.toHaveProperty('recurrence_rule')
  })

  it('SCF-13 preview refusal → mapped message, no dialog, no save', async () => {
    mockPreview.mockResolvedValue({ status: 'refused', reason: 'early_time' })
    const user = userEvent.setup()
    render(<EventForm mode="edit" initialData={SAT_EVENT} scheduleLocked isAdmin />)
    await setTime(user, '06:00')
    await submit(user)
    expect(screen.getByRole('alert')).toHaveTextContent('errors.early_time')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(mockUpdateEvent).not.toHaveBeenCalled()
  })

  it('SCF-14 save refusal (raced) → mapped message; partial → partial message', async () => {
    mockPreview.mockResolvedValue({ status: 'ok', shape: 'R', moved: 2, cancelled_moved: 0, to_date: '2026-11-14', to_time: '16:00' })
    mockUpdateEvent.mockResolvedValueOnce({ status: 'schedule_change_refused', reason: 'slot_taken' })
    const user = userEvent.setup()
    render(<EventForm mode="edit" initialData={SAT_EVENT} scheduleLocked isAdmin />)
    await setTime(user, '16:00')
    await submit(user)
    await act(async () => {
      await user.click(screen.getByRole('button', { name: 'confirm' }))
    })
    expect(screen.getByRole('alert')).toHaveTextContent('errors.slot_taken')

    mockUpdateEvent.mockResolvedValueOnce({ status: 'partial', event_id: 'ev-sat', schedule_change: { moved: 2, cancelled_moved: 0 } })
    await submit(user)
    await act(async () => {
      await user.click(screen.getByRole('button', { name: 'confirm' }))
    })
    expect(screen.getByRole('alert')).toHaveTextContent('partial')
  })

  it('SCF-15 admin locked save without a time change → plain save, no preview', async () => {
    mockUpdateEvent.mockResolvedValue({ status: 'ok', event_id: 'ev-sat' })
    const user = userEvent.setup()
    render(<EventForm mode="edit" initialData={SAT_EVENT} scheduleLocked isAdmin />)
    await submit(user)
    expect(mockPreview).not.toHaveBeenCalled()
    const [, input, options] = mockUpdateEvent.mock.calls[0] as [string, Record<string, unknown>, unknown]
    expect(options).toBeUndefined()
    for (const k of ['event_type', 'start_date', 'start_time', 'recurrence_rule']) expect(input).not.toHaveProperty(k)
  })
})
