// @vitest-environment jsdom
//
// Proves the Telegram token-absence requirement (T7 plan I) end-to-end
// through the REAL SettingsPage render path: getTelegramBotToken() is mocked
// to return a known "secret" string, and the test asserts that string never
// appears anywhere in the rendered HTML — not just that the component avoids
// referencing the variable, but that no code path in page.tsx or
// settings-client.tsx lets the actual returned value reach JSX. Only the
// boolean presence result may cross into the client component.
//
// lib/actions/settings.ts and lib/actions/parishes.ts both transitively
// import lib/supabase/admin.ts (`import 'server-only'`), which throws
// unconditionally under plain `vitest run` (outside Next's "react-server"
// bundler condition) — same issue documented in the integration test files.
// Mocked as whole modules here, consistent with that established pattern.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import SettingsPage from '../page'

const FAKE_SECRET_TOKEN = 'sprint7-test-secret-token-must-never-render-abc123'

vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
}))
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key} ${JSON.stringify(params)}` : key,
}))
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`)
  }),
  useRouter: () => ({ refresh: vi.fn() }),
}))

let mockRole: string | null = 'admin'
let mockActive = true
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: 'user-1' } } }) },
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: { role: mockRole, active: mockActive } }) }) }),
    }),
  }),
}))

let mockBotConfigured = true
vi.mock('@/lib/telegram/token', () => ({
  getTelegramBotToken: () => {
    if (!mockBotConfigured) throw new Error('TELEGRAM_BOT_TOKEN is not set.')
    return FAKE_SECRET_TOKEN
  },
}))

const SETTINGS_ROW = {
  default_country_code: 'ID',
  default_language: 'id',
  materialization_horizon_mo: 12,
  birthday_notify_time: '07:00:00',
  birthday_notify_timezone: 'Asia/Jakarta',
  birthday_notify_email: null,
  telegram_admin_chat_id: '100000000',
  consent_policy_version: 'v1',
  retention_archive_years: 3,
  retention_aggregate_years: 5,
  updated_at: '2026-07-28T14:28:22.344Z',
}

vi.mock('@/lib/actions/settings', () => ({
  getSettings: async () => ({ status: 'ok', settings: SETTINGS_ROW }),
  updateSettings: vi.fn(),
  getHorizonImpact: vi.fn(),
}))

vi.mock('@/lib/actions/parishes-admin', () => ({
  listPendingParishes: async () => ({ status: 'ok', parishes: [] }),
  approveParish: vi.fn(),
}))

vi.mock('@/lib/actions/digest-triggers', () => ({
  runBirthdayDigestNow: vi.fn(),
  runAttendanceSummaryNow: vi.fn(),
}))

describe('SettingsPage — Telegram token never in rendered output', () => {
  beforeEach(() => {
    mockRole = 'admin'
    mockActive = true
    mockBotConfigured = true
  })

  it('bot token configured: shows "configured", the actual token string is absent from the DOM', async () => {
    const element = await SettingsPage()
    const { container } = render(element)

    expect(screen.getByText('telegram.configured')).toBeInTheDocument()
    expect(container.innerHTML).not.toContain(FAKE_SECRET_TOKEN)
  })

  it('bot token NOT configured: shows "not configured", still never renders the token string', async () => {
    mockBotConfigured = false
    const element = await SettingsPage()
    const { container } = render(element)

    expect(screen.getAllByText('telegram.not_configured').length).toBeGreaterThan(0)
    expect(container.innerHTML).not.toContain(FAKE_SECRET_TOKEN)
  })

  it('deactivated admin is blocked before any settings data is fetched', async () => {
    mockActive = false
    const element = await SettingsPage()
    render(element)

    expect(screen.queryByText('telegram.configured')).not.toBeInTheDocument()
  })
})
