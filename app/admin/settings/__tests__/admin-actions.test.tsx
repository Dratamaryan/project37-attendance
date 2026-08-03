// @vitest-environment jsdom
//
// Sprint 5 Task 8 — Settings "Admin actions" section: Send Test Telegram +
// Run Digest/Summary Now. Renders SettingsClient directly (not through
// SettingsPage) so this suite doesn't need to also mock the auth/session
// plumbing page.test.tsx covers — only the outcome-mapping and wiring of the
// three buttons. runBirthdayDigestNow/runAttendanceSummaryNow and the
// Telegram test fetch call are mocked; the actual T5 claim/idempotency logic
// is proven end-to-end in tests/integration/digest-triggers.test.ts, not here.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SettingsClient } from '../settings-client'

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key} ${JSON.stringify(params)}` : key,
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}))

const runBirthdayDigestNow = vi.fn()
const runAttendanceSummaryNow = vi.fn()
vi.mock('@/lib/actions/digest-triggers', () => ({
  runBirthdayDigestNow: (...args: unknown[]) => runBirthdayDigestNow(...args),
  runAttendanceSummaryNow: (...args: unknown[]) => runAttendanceSummaryNow(...args),
}))

vi.mock('@/lib/actions/settings', () => ({
  updateSettings: vi.fn(),
  getHorizonImpact: vi.fn(),
}))
vi.mock('@/lib/actions/parishes-admin', () => ({
  approveParish: vi.fn(),
}))

function renderSection() {
  render(
    <SettingsClient
      initialSettings={null}
      settingsLoadError={true}
      initialPendingParishes={[]}
      parishesLoadError={false}
      telegramBotConfigured={true}
    />,
  )
}

describe('Admin actions — Send Test Telegram', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  it('success: shows the success message', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, messageId: 42 }),
    })
    renderSection()

    fireEvent.click(screen.getByText('admin_actions.test_telegram.button'))

    await waitFor(() => {
      expect(screen.getByText('admin_actions.test_telegram.success')).toBeInTheDocument()
    })
    expect(global.fetch).toHaveBeenCalledWith('/api/admin/telegram/test', { method: 'POST' })
  })

  it('failure: surfaces the reason from the route response', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      json: async () => ({ ok: false, reason: 'not_configured' }),
    })
    renderSection()

    fireEvent.click(screen.getByText('admin_actions.test_telegram.button'))

    await waitFor(() => {
      expect(
        screen.getByText('admin_actions.test_telegram.error {"reason":"not_configured"}'),
      ).toBeInTheDocument()
    })
  })
})

describe('Admin actions — Run Birthday Digest Now: outcome mapping', () => {
  it.each([
    [{ status: 'sent', ict_date: '2026-12-03', count: 3, message_id: 1 }, 'admin_actions.run_digest.sent {"count":3}'],
    [{ status: 'skipped_already_sent', ict_date: '2026-12-03' }, 'admin_actions.run_digest.skipped'],
    [{ status: 'skipped_concurrent', ict_date: '2026-12-03' }, 'admin_actions.run_digest.concurrent'],
    [{ status: 'empty', ict_date: '2026-12-03' }, 'admin_actions.run_digest.empty'],
    [
      { status: 'send_failed', ict_date: '2026-12-03', count: 1, reason: 'boom' },
      'admin_actions.run_digest.failed {"reason":"boom"}',
    ],
    [{ status: 'not_authorized' }, 'admin_actions.not_authorized'],
  ])('%o -> %s', async (result, expectedText) => {
    runBirthdayDigestNow.mockResolvedValue(result)
    renderSection()

    fireEvent.click(screen.getByText('admin_actions.run_digest.button'))

    await waitFor(() => {
      expect(screen.getByText(expectedText)).toBeInTheDocument()
    })
  })
})

describe('Admin actions — Run Attendance Summary Now: outcome mapping + flip note', () => {
  it('sent with flipped_count appends the flip note', async () => {
    runAttendanceSummaryNow.mockResolvedValue({
      status: 'sent',
      ict_date: '2026-12-04',
      count: 5,
      message_id: 9,
      flipped_count: 2,
    })
    renderSection()

    fireEvent.click(screen.getByText('admin_actions.run_summary.button'))

    await waitFor(() => {
      expect(
        screen.getByText(
          'admin_actions.run_summary.sent {"count":5} admin_actions.run_summary.flipped {"count":2}',
        ),
      ).toBeInTheDocument()
    })
  })

  it('skipped_already_sent with flipped_count 0 shows no flip note', async () => {
    runAttendanceSummaryNow.mockResolvedValue({
      status: 'skipped_already_sent',
      ict_date: '2026-12-04',
      flipped_count: 0,
    })
    renderSection()

    fireEvent.click(screen.getByText('admin_actions.run_summary.button'))

    await waitFor(() => {
      expect(screen.getByText('admin_actions.run_summary.skipped')).toBeInTheDocument()
    })
  })

  it('skipped_concurrent renders the distinct in-flight message, not the terminal already-sent message', async () => {
    runAttendanceSummaryNow.mockResolvedValue({
      status: 'skipped_concurrent',
      ict_date: '2026-12-04',
      flipped_count: 0,
    })
    renderSection()

    fireEvent.click(screen.getByText('admin_actions.run_summary.button'))

    await waitFor(() => {
      expect(screen.getByText('admin_actions.run_summary.concurrent')).toBeInTheDocument()
    })
    expect(screen.queryByText('admin_actions.run_summary.skipped')).not.toBeInTheDocument()
  })

  it('help text names the flip side-effect', () => {
    renderSection()
    expect(screen.getByText('admin_actions.run_summary.help')).toBeInTheDocument()
  })
})
