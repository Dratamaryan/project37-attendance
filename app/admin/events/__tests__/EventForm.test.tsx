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
    RRuleInput: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
      <input
        data-testid="rrule-input"
        value={value}
        onChange={e => onChange(e.target.value)}
      />
    ),
  }
})

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fillValidForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/name_label/i), 'Test Event')

  // Select friday_biweekly radio
  const radio = screen.getByDisplayValue('friday_biweekly')
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
    await user.click(screen.getByDisplayValue('friday_biweekly'))

    await act(async () => {
      await user.click(screen.getByRole('button', { name: /submit_create/i }))
    })

    expect(screen.getByText('field_error_date')).toBeDefined()
  })

  it('calls createEvent with recurrence_rule=FREQ=WEEKLY;INTERVAL=2;BYDAY=FR for friday_biweekly', async () => {
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
    expect(callArg.recurrence_rule).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=FR')
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
