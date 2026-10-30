// @vitest-environment jsdom
//
// RescheduleInstanceDialog (S9.5-T4): form → confirm step → action → redirect
// to the NEW occurrence. The translator resolves keys from the real en / id
// message files, so the confirm-step copy is asserted as exact strings.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import en from '@/messages/en.json'
import id from '@/messages/id.json'
import { RescheduleInstanceDialog } from '@/app/admin/events/_components/RescheduleInstanceDialog'

const mockPush = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

let locale: 'en' | 'id' = 'en'
function lookup(path: string): string {
  let node: unknown = locale === 'en' ? en : id
  for (const part of path.split('.')) node = (node as Record<string, unknown>)[part]
  if (typeof node !== 'string') throw new Error(`missing message ${locale}:${path}`)
  return node
}
vi.mock('next-intl', () => ({
  useTranslations: (ns: string) => (key: string, params?: Record<string, string>) =>
    lookup(`${ns}.${key}`).replace(/\{(\w+)\}/g, (_, k: string) => params?.[k] ?? `{${k}}`),
}))

vi.mock('@/lib/actions/events', () => ({
  rescheduleInstance: vi.fn(),
}))
import { rescheduleInstance } from '@/lib/actions/events'
const mockReschedule = vi.mocked(rescheduleInstance)

const INSTANCE_ID = '11111111-2222-4333-8444-555555555555'
const NEW_ID = '99999999-2222-4333-8444-555555555555'
const EVENT_ID = 'event-001'

function setup() {
  const user = userEvent.setup()
  render(
    <RescheduleInstanceDialog
      instanceId={INSTANCE_ID}
      fromLabel="2026-12-12 15:00"
      defaultDate="2026-12-12"
      defaultTime="15:00"
    />,
  )
  return { user }
}

async function fillAndContinue(user: ReturnType<typeof userEvent.setup>, reason = 'Venue unavailable') {
  const date = screen.getByLabelText(lookup('admin.events.instance.reschedule.date_label')) as HTMLInputElement
  await user.clear(date)
  await user.type(date, '2026-12-19')
  await user.type(screen.getByLabelText(lookup('admin.events.instance.reschedule.reason_label')), reason)
  await user.click(screen.getByRole('button', { name: lookup('admin.events.instance.reschedule.continue') }))
}

beforeEach(() => {
  vi.clearAllMocks()
  locale = 'en'
})

describe('RescheduleInstanceDialog', () => {
  it('button reads "Reschedule" (en) / "Jadwalkan ulang" (id); dialog closed until clicked', () => {
    setup()
    expect(screen.getByRole('button', { name: 'Reschedule' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('id locale button label', () => {
    locale = 'id'
    setup()
    expect(screen.getByRole('button', { name: 'Jadwalkan ulang' })).toBeInTheDocument()
  })

  it('form opens with the current WIB date/time as defaults and an empty reason', async () => {
    const { user } = setup()
    await user.click(screen.getByRole('button', { name: 'Reschedule' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Reschedule this occurrence')).toBeInTheDocument()
    expect(screen.getByLabelText('New date')).toHaveValue('2026-12-12')
    expect(screen.getByLabelText('New time (WIB)')).toHaveValue('15:00')
    expect(screen.getByLabelText('Reason (required)')).toHaveValue('')
  })

  it('blank reason → stays on the form with "Please enter a reason.", action not called', async () => {
    const { user } = setup()
    await user.click(screen.getByRole('button', { name: 'Reschedule' }))
    await user.type(screen.getByLabelText('Reason (required)'), '   ')
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Please enter a reason.')
    expect(screen.queryByTestId('reschedule-warnings')).not.toBeInTheDocument()
    expect(mockReschedule).not.toHaveBeenCalled()
  })

  it('confirm step (en): exact from/to/reason summary and the three consequence statements; nothing called yet', async () => {
    const { user } = setup()
    await user.click(screen.getByRole('button', { name: 'Reschedule' }))
    await fillAndContinue(user)
    expect(screen.getByText('Confirm reschedule')).toBeInTheDocument()
    const summary = screen.getByTestId('reschedule-summary')
    expect(summary).toHaveTextContent('From: 2026-12-12 15:00 WIB')
    expect(summary).toHaveTextContent('To: 2026-12-19 15:00 WIB')
    expect(summary).toHaveTextContent('Reason: Venue unavailable')
    const items = Array.from(screen.getByTestId('reschedule-warnings').querySelectorAll('li')).map(li => li.textContent)
    expect(items).toEqual([
      'This occurrence will be cancelled.',
      'The new occurrence needs a NEW RSVP link — the current link does not move to it.',
      'Existing RSVPs and invitations stay on the cancelled occurrence.',
    ])
    expect(screen.getByRole('button', { name: 'Yes, reschedule' })).toBeInTheDocument()
    expect(mockReschedule).not.toHaveBeenCalled()
  })

  it('confirm step (id): exact Indonesian copy', async () => {
    locale = 'id'
    const { user } = setup()
    await user.click(screen.getByRole('button', { name: 'Jadwalkan ulang' }))
    await fillAndContinue(user, 'Gedung tidak tersedia')
    expect(screen.getByText('Konfirmasi jadwal ulang')).toBeInTheDocument()
    const summary = screen.getByTestId('reschedule-summary')
    expect(summary).toHaveTextContent('Dari: 2026-12-12 15:00 WIB')
    expect(summary).toHaveTextContent('Ke: 2026-12-19 15:00 WIB')
    expect(summary).toHaveTextContent('Alasan: Gedung tidak tersedia')
    const items = Array.from(screen.getByTestId('reschedule-warnings').querySelectorAll('li')).map(li => li.textContent)
    expect(items).toEqual([
      'Acara ini akan dibatalkan.',
      'Acara yang baru membutuhkan link RSVP BARU — link yang sekarang tidak ikut pindah.',
      'RSVP dan undangan yang sudah ada tetap tercatat pada acara yang dibatalkan.',
    ])
    expect(screen.getByRole('button', { name: 'Ya, jadwalkan ulang' })).toBeInTheDocument()
  })

  it('Back returns to the form with the values kept', async () => {
    const { user } = setup()
    await user.click(screen.getByRole('button', { name: 'Reschedule' }))
    await fillAndContinue(user)
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByLabelText('New date')).toHaveValue('2026-12-19')
    expect(screen.getByLabelText('Reason (required)')).toHaveValue('Venue unavailable')
  })

  it('confirm → action called with (instanceId, date, time, reason); ok → redirect to the NEW instance with ?rescheduled=1', async () => {
    mockReschedule.mockResolvedValue({ status: 'ok', instance_id: NEW_ID, event_id: EVENT_ID })
    const { user } = setup()
    await user.click(screen.getByRole('button', { name: 'Reschedule' }))
    await fillAndContinue(user)
    await user.click(screen.getByRole('button', { name: 'Yes, reschedule' }))
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(`/admin/events/${EVENT_ID}/instances/${NEW_ID}?rescheduled=1`))
    expect(mockReschedule).toHaveBeenCalledWith(INSTANCE_ID, '2026-12-19', '15:00', 'Venue unavailable')
  })

  it.each([
    ['slot_taken', 'This event already has an occurrence at that date and time.'],
    ['beyond_horizon', 'The new date is too far ahead — it must be within the event scheduling window.'],
    ['not_admin', 'Only admins can reschedule.'],
    ['unknown', "Couldn't reschedule. Please try again."],
  ] as const)('refusal %s → back on the form with the localized message, no redirect', async (code, message) => {
    mockReschedule.mockResolvedValue({ status: 'error', code })
    const { user } = setup()
    await user.click(screen.getByRole('button', { name: 'Reschedule' }))
    await fillAndContinue(user)
    await user.click(screen.getByRole('button', { name: 'Yes, reschedule' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(message))
    expect(screen.getByLabelText('New date')).toBeInTheDocument()
    expect(mockPush).not.toHaveBeenCalled()
  })
})
