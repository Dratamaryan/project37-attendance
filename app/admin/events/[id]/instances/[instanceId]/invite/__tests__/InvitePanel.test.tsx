// @vitest-environment jsdom
//
// Mocks return DIFFERENT shapes per scenario (has-email vs no-email present,
// remaining>0 vs done, ok/not_found/failed per resend) so these tests prove
// the UI reacts to the data it's given, not just that it called the action
// (S2-T9 lesson — assert rendered output, not call count).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { InvitePanel } from '../_components/InvitePanel'

vi.mock('next-intl', () => ({
  useTranslations:
    () =>
    (key: string, params?: Record<string, string | number>) =>
      params ? `${key} ${Object.values(params).join(' ')}` : key,
}))

const mockResolveRecipients = vi.fn()
const mockSendInvites = vi.fn()
const mockResendInvite = vi.fn()
vi.mock('@/lib/actions/invites', () => ({
  resolveRecipients: (...args: unknown[]) => mockResolveRecipients(...args),
  sendInvites: (...args: unknown[]) => mockSendInvites(...args),
  resendInvite: (...args: unknown[]) => mockResendInvite(...args),
}))

describe('InvitePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('T4-07: preview excludes the no-email person from the send list and lists them separately with name+phone', async () => {
    const user = userEvent.setup()
    mockResolveRecipients.mockResolvedValue({
      hasEmail: [{ personId: 'p1', fullName: 'Alice Example', email: 'alice@example.com' }],
      noEmail:  [{ personId: 'p2', fullName: 'Bob NoEmail', phoneE164: '+628123456789' }],
    })

    render(<InvitePanel eventInstanceId="inst-1" />)
    await act(async () => {
      await user.click(screen.getByTestId('preview-button'))
    })

    // Has-email person is in the recipient table, not the no-email list.
    expect(screen.getByText('Alice Example')).toBeInTheDocument()
    expect(screen.getByText('alice@example.com')).toBeInTheDocument()

    // No-email person is excluded from send and carries name + phone (F/4).
    expect(screen.getByText('Bob NoEmail')).toBeInTheDocument()
    expect(screen.getByText('+628123456789')).toBeInTheDocument()

    expect(screen.getByTestId('preview-summary')).toHaveTextContent('preview.summary 1 1')
  })

  it('a filter with zero no-email recipients renders the empty no-email state, not a stale list', async () => {
    const user = userEvent.setup()
    mockResolveRecipients.mockResolvedValue({
      hasEmail: [{ personId: 'p1', fullName: 'Alice Example', email: 'alice@example.com' }],
      noEmail: [],
    })

    render(<InvitePanel eventInstanceId="inst-1" />)
    await act(async () => {
      await user.click(screen.getByTestId('preview-button'))
    })

    expect(screen.queryByTestId('no-email-copy-button')).not.toBeInTheDocument()
    expect(screen.getByText('empty')).toBeInTheDocument()
  })

  it('copies the no-email list as "name — phone" lines to the clipboard', async () => {
    const user = userEvent.setup()
    mockResolveRecipients.mockResolvedValue({
      hasEmail: [],
      noEmail: [
        { personId: 'p2', fullName: 'Bob NoEmail', phoneE164: '+628123456789' },
        { personId: 'p3', fullName: 'Cara NoEmail', phoneE164: '+628199999999' },
      ],
    })
    const expectedText = 'Bob NoEmail — +628123456789\nCara NoEmail — +628199999999'

    render(<InvitePanel eventInstanceId="inst-1" />)
    await act(async () => {
      await user.click(screen.getByTestId('preview-button'))
    })

    // The selectable fallback is populated independent of the Clipboard API —
    // proves the join logic itself is correct.
    expect(screen.getByTestId('no-email-copy-fallback')).toHaveValue(expectedText)

    await act(async () => {
      await user.click(screen.getByTestId('no-email-copy-button'))
    })

    // Exercises jsdom's real in-memory Clipboard end-to-end (a write immediately
    // followed by a read) rather than mocking navigator.clipboard — jsdom
    // instantiates it lazily via a prototype getter that silently reasserts
    // itself over property-level overrides, so a mock-based assertion here is
    // unreliable across jsdom/vitest versions; the real API is not.
    await expect(navigator.clipboard.readText()).resolves.toBe(expectedText)
    expect(screen.getByTestId('no-email-copy-button')).toHaveTextContent('copied')
  })

  it('shows the resume hint only when a run stops with recipients remaining', async () => {
    const user = userEvent.setup()
    mockResolveRecipients.mockResolvedValue({
      hasEmail: [{ personId: 'p1', fullName: 'Alice Example', email: 'alice@example.com' }],
      noEmail: [],
    })
    mockSendInvites.mockResolvedValue({
      status: 'ok',
      eventInstanceId: 'inst-1',
      noEmail: [],
      attempted: 25,
      sent: 25,
      failed: 0,
      skippedAlreadySent: 0,
      remaining: 8,
      stoppedReason: 'run_budget_exhausted',
    })

    render(<InvitePanel eventInstanceId="inst-1" />)
    await act(async () => { await user.click(screen.getByTestId('preview-button')) })
    await act(async () => { await user.click(screen.getByTestId('send-button')) })

    expect(screen.getByTestId('send-remaining-hint')).toHaveTextContent('remaining 8')
  })

  it('omits the resume hint when a run completes with nothing remaining', async () => {
    const user = userEvent.setup()
    mockResolveRecipients.mockResolvedValue({
      hasEmail: [{ personId: 'p1', fullName: 'Alice Example', email: 'alice@example.com' }],
      noEmail: [],
    })
    mockSendInvites.mockResolvedValue({
      status: 'ok',
      eventInstanceId: 'inst-1',
      noEmail: [],
      attempted: 1,
      sent: 1,
      failed: 0,
      skippedAlreadySent: 0,
      remaining: 0,
      stoppedReason: 'completed',
    })

    render(<InvitePanel eventInstanceId="inst-1" />)
    await act(async () => { await user.click(screen.getByTestId('preview-button')) })
    await act(async () => { await user.click(screen.getByTestId('send-button')) })

    expect(screen.getByTestId('send-result-banner')).toBeInTheDocument()
    expect(screen.queryByTestId('send-remaining-hint')).not.toBeInTheDocument()
  })

  it('resend shows a distinct result per recipient: ok, not_found, and send_failed', async () => {
    const user = userEvent.setup()
    mockResolveRecipients.mockResolvedValue({
      hasEmail: [
        { personId: 'p1', fullName: 'Already Sent', email: 'a@example.com' },
        { personId: 'p2', fullName: 'Never Invited', email: 'b@example.com' },
        { personId: 'p3', fullName: 'Bad Address', email: 'c@example.com' },
      ],
      noEmail: [],
    })
    mockResendInvite.mockImplementation(async (_instanceId: string, personId: string) => {
      if (personId === 'p1') return { status: 'ok', sequence: 1 }
      if (personId === 'p2') return { status: 'not_found' }
      return { status: 'send_failed', message: 'bounced', sequence: 0 }
    })

    render(<InvitePanel eventInstanceId="inst-1" />)
    await act(async () => { await user.click(screen.getByTestId('preview-button')) })

    await act(async () => { await user.click(screen.getByTestId('resend-button-p1')) })
    await act(async () => { await user.click(screen.getByTestId('resend-button-p2')) })
    await act(async () => { await user.click(screen.getByTestId('resend-button-p3')) })

    expect(screen.getByTestId('resend-result-p1')).toHaveTextContent('resend_ok 1')
    expect(screen.getByTestId('resend-result-p2')).toHaveTextContent('resend_not_found')
    expect(screen.getByTestId('resend-result-p3')).toHaveTextContent('resend_failed bounced')
  })
})
