// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CancelInstanceDialog } from '@/app/admin/events/_components/CancelInstanceDialog'

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockPush = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}))

vi.mock('@/lib/actions/events', () => ({
  cancelInstance: vi.fn(),
}))

import { cancelInstance } from '@/lib/actions/events'
const mockCancelInstance = vi.mocked(cancelInstance)

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
})

function setup() {
  const user = userEvent.setup()
  render(
    <CancelInstanceDialog instanceId="inst-001" eventId="event-001" />,
  )
  return { user }
}

describe('CancelInstanceDialog', () => {
  it('CD-01: dialog opens on button click', async () => {
    const { user } = setup()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'cancel_button' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('CD-02: submitting calls cancelInstance with (instanceId, reason)', async () => {
    mockCancelInstance.mockResolvedValue({ status: 'ok', instance_id: 'inst-001' })
    const { user } = setup()

    await user.click(screen.getByRole('button', { name: 'cancel_button' }))
    await user.type(screen.getByRole('textbox'), 'Test reason')
    await user.click(screen.getByRole('button', { name: 'cancel_dialog.confirm' }))

    await waitFor(() => expect(mockCancelInstance).toHaveBeenCalledWith('inst-001', 'Test reason'))
  })

  it('CD-03: success branch closes dialog and navigates to event page', async () => {
    mockCancelInstance.mockResolvedValue({ status: 'ok', instance_id: 'inst-001' })
    const { user } = setup()

    await user.click(screen.getByRole('button', { name: 'cancel_button' }))
    await user.click(screen.getByRole('button', { name: 'cancel_dialog.confirm' }))

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith(
        '/admin/events/event-001?instance_cancelled=inst-001',
      )
    })
    // Dialog closed (push causes navigation; in test DOM the dialog unmounts)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('CD-04: error branch shows error message and keeps dialog open', async () => {
    mockCancelInstance.mockResolvedValue({ status: 'error', message: 'DB error' })
    const { user } = setup()

    await user.click(screen.getByRole('button', { name: 'cancel_button' }))
    await user.click(screen.getByRole('button', { name: 'cancel_dialog.confirm' }))

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    // Dialog still open
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    // Router.push NOT called
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('CD-05: reason input enforces 500-char max', async () => {
    const { user } = setup()
    await user.click(screen.getByRole('button', { name: 'cancel_button' }))

    const textarea = screen.getByRole('textbox')
    const long501 = 'a'.repeat(501)
    await user.type(textarea, long501)

    // Value is clamped to 500
    expect((textarea as HTMLTextAreaElement).value.length).toBeLessThanOrEqual(500)
  })
})
