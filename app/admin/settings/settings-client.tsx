'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { updateSettings, getHorizonImpact } from '@/lib/actions/settings'
import { approveParish } from '@/lib/actions/parishes-admin'
import { runBirthdayDigestNow, runAttendanceSummaryNow } from '@/lib/actions/digest-triggers'
import { resolveChatId } from '@/lib/telegram/chat-id'
import type { AppSettingsRow, UpdateSettingsInput } from '@/lib/actions/settings.types'
import type { ParishSearchResult } from '@/lib/actions/parishes.types'
import type { BirthdayDigestResult, AttendanceSummaryResult } from '@/lib/actions/digest-triggers.types'

type Props = {
  initialSettings: AppSettingsRow | null
  settingsLoadError: boolean
  initialPendingParishes: ParishSearchResult[]
  parishesLoadError: boolean
  telegramBotConfigured: boolean
}

type Message = { type: 'success' | 'error'; text: string }
type HorizonImpact = { count: number; horizonEnd: string }

export function SettingsClient({
  initialSettings,
  settingsLoadError,
  initialPendingParishes,
  parishesLoadError,
  telegramBotConfigured,
}: Props) {
  const t = useTranslations('settings')
  const router = useRouter()

  return (
    <div className="space-y-8">
      {settingsLoadError ? (
        <p role="alert" className="text-sm text-red-600">{t('load_error')}</p>
      ) : (
        initialSettings && <GeneralSection settings={initialSettings} t={t} router={router} />
      )}

      <TelegramSection
        chatId={initialSettings?.telegram_admin_chat_id ?? null}
        botConfigured={telegramBotConfigured}
        t={t}
      />

      <AdminActionsSection t={t} />

      <ParishesSection
        initialParishes={initialPendingParishes}
        loadError={parishesLoadError}
        t={t}
        router={router}
      />
    </div>
  )
}

// ── General settings form ────────────────────────────────────────────────────

type TFunc = ReturnType<typeof useTranslations>

function GeneralSection({
  settings,
  t,
  router,
}: {
  settings: AppSettingsRow
  t: TFunc
  router: ReturnType<typeof useRouter>
}) {
  const [baseline, setBaseline] = useState(settings)
  const [language, setLanguage] = useState(settings.default_language)
  const [horizonMonths, setHorizonMonths] = useState(String(settings.materialization_horizon_mo))
  const [notifyTime, setNotifyTime] = useState(settings.birthday_notify_time.slice(0, 5))
  const [notifyTimezone, setNotifyTimezone] = useState(settings.birthday_notify_timezone)

  const [horizonImpact, setHorizonImpact] = useState<HorizonImpact | null>(null)
  const [horizonConfirmed, setHorizonConfirmed] = useState(false)
  const [isCheckingImpact, startImpactCheck] = useTransition()

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [saveMessage, setSaveMessage] = useState<Message | null>(null)
  const [isSaving, startSaving] = useTransition()

  const timezones = useMemo(() => {
    try {
      return Intl.supportedValuesOf('timeZone')
    } catch {
      return [settings.birthday_notify_timezone]
    }
  }, [settings.birthday_notify_timezone])

  const horizonNum = Number(horizonMonths)
  const horizonChanged = horizonNum !== baseline.materialization_horizon_mo
  const horizonNeedsConfirm =
    horizonChanged && horizonImpact !== null && horizonImpact.count > 0 && !horizonConfirmed

  function checkHorizonImpact(value: number) {
    if (!Number.isInteger(value) || value < 1 || value > 24) {
      setHorizonImpact(null)
      return
    }
    startImpactCheck(async () => {
      const result = await getHorizonImpact(value)
      if (result.status === 'ok') {
        setHorizonImpact({ count: result.estimated_count, horizonEnd: result.horizon_end })
      } else {
        setHorizonImpact(null)
      }
    })
  }

  function handleHorizonChange(value: string) {
    setHorizonMonths(value)
    setHorizonImpact(null)
    setHorizonConfirmed(false)
  }

  function handleHorizonBlur() {
    if (horizonNum !== baseline.materialization_horizon_mo) {
      checkHorizonImpact(horizonNum)
    }
  }

  function handleSave() {
    setSaveMessage(null)
    setFieldErrors({})

    if (horizonChanged && horizonImpact === null) {
      // Not yet checked (e.g. saved without blurring the field) — run the
      // check now and require the admin to review before this click saves.
      checkHorizonImpact(horizonNum)
      return
    }
    if (horizonNeedsConfirm) {
      return
    }

    const patch: UpdateSettingsInput = {}
    if (language !== baseline.default_language) patch.default_language = language
    if (horizonChanged) patch.materialization_horizon_mo = horizonNum
    if (notifyTime !== baseline.birthday_notify_time.slice(0, 5)) patch.birthday_notify_time = notifyTime
    if (notifyTimezone !== baseline.birthday_notify_timezone) patch.birthday_notify_timezone = notifyTimezone

    if (Object.keys(patch).length === 0) return

    startSaving(async () => {
      const result = await updateSettings(patch)
      if (result.status === 'ok') {
        setBaseline(result.settings)
        setHorizonImpact(null)
        setHorizonConfirmed(false)
        setSaveMessage({ type: 'success', text: t('general.save_success') })
        router.refresh()
      } else if (result.status === 'validation_error') {
        setFieldErrors(result.field_errors)
        setSaveMessage({ type: 'error', text: t('general.validation_error') })
      } else {
        setSaveMessage({ type: 'error', text: t('general.save_error') })
      }
    })
  }

  return (
    <section className="bg-cream-2 border border-line rounded-lg p-5 space-y-5">
      <h2 className="font-heading text-lg font-semibold text-charcoal">{t('general.title')}</h2>

      <div>
        <label htmlFor="default-language" className="block text-sm font-medium text-charcoal mb-1">
          {t('general.default_language.label')}
        </label>
        <p className="text-xs text-muted mb-2">{t('general.default_language.help')}</p>
        <select
          id="default-language"
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          className="rounded-sm border border-line px-3 py-2 text-sm"
        >
          <option value="id">{t('general.default_language.option_id')}</option>
          <option value="en">{t('general.default_language.option_en')}</option>
        </select>
        {fieldErrors.default_language && (
          <p role="alert" className="text-xs text-red-600 mt-1">{fieldErrors.default_language}</p>
        )}
      </div>

      <div>
        <label htmlFor="horizon-months" className="block text-sm font-medium text-charcoal mb-1">
          {t('general.materialization_horizon.label')}
        </label>
        <p className="text-xs text-muted mb-2">{t('general.materialization_horizon.help')}</p>
        <div className="flex items-center gap-2">
          <input
            id="horizon-months"
            type="number"
            min={1}
            max={24}
            value={horizonMonths}
            onChange={(e) => handleHorizonChange(e.target.value)}
            onBlur={handleHorizonBlur}
            className="w-24 rounded-sm border border-line px-3 py-2 text-sm"
          />
          <span className="text-sm text-muted">{t('general.materialization_horizon.unit')}</span>
        </div>
        {fieldErrors.materialization_horizon_mo && (
          <p role="alert" className="text-xs text-red-600 mt-1">
            {fieldErrors.materialization_horizon_mo}
          </p>
        )}
        {isCheckingImpact && <p className="text-xs text-muted mt-1">…</p>}
        {horizonChanged && horizonImpact !== null && horizonImpact.count > 0 && (
          <div className="mt-2 rounded-sm border border-gold/40 bg-gold/10 p-3">
            <p className="text-xs text-ink-2">{t('horizon_warning.text', { count: horizonImpact.count })}</p>
            <label className="flex items-center gap-2 mt-2 text-xs text-charcoal">
              <input
                type="checkbox"
                checked={horizonConfirmed}
                onChange={(e) => setHorizonConfirmed(e.target.checked)}
              />
              {t('horizon_warning.confirm_label')}
            </label>
          </div>
        )}
      </div>

      <div>
        <label htmlFor="notify-time" className="block text-sm font-medium text-charcoal mb-1">
          {t('general.birthday_notify_time.label')}
        </label>
        <input
          id="notify-time"
          type="time"
          value={notifyTime}
          onChange={(e) => setNotifyTime(e.target.value)}
          className="rounded-sm border border-line px-3 py-2 text-sm"
        />
        {fieldErrors.birthday_notify_time && (
          <p role="alert" className="text-xs text-red-600 mt-1">{fieldErrors.birthday_notify_time}</p>
        )}
      </div>

      <div>
        <label htmlFor="notify-timezone" className="block text-sm font-medium text-charcoal mb-1">
          {t('general.birthday_notify_timezone.label')}
        </label>
        <select
          id="notify-timezone"
          value={notifyTimezone}
          onChange={(e) => setNotifyTimezone(e.target.value)}
          className="rounded-sm border border-line px-3 py-2 text-sm max-w-full"
        >
          {timezones.map((tz) => (
            <option key={tz} value={tz}>{tz}</option>
          ))}
        </select>
        {fieldErrors.birthday_notify_timezone && (
          <p role="alert" className="text-xs text-red-600 mt-1">
            {fieldErrors.birthday_notify_timezone}
          </p>
        )}
      </div>

      <div>
        <button
          type="button"
          onClick={handleSave}
          disabled={isSaving || horizonNeedsConfirm}
          className="inline-flex items-center justify-center rounded-sm bg-gold px-4 py-2 text-sm font-medium text-white hover:bg-gold-dark transition-colors disabled:opacity-50"
        >
          {isSaving ? t('general.save_pending') : t('general.save')}
        </button>
        {saveMessage && (
          <p
            role={saveMessage.type === 'error' ? 'alert' : 'status'}
            className={`text-sm mt-2 ${saveMessage.type === 'error' ? 'text-red-600' : 'text-green-700'}`}
          >
            {saveMessage.text}
          </p>
        )}
      </div>
    </section>
  )
}

// ── Telegram status (display-only) ───────────────────────────────────────────

function TelegramSection({
  chatId,
  botConfigured,
  t,
}: {
  chatId: string | null
  botConfigured: boolean
  t: TFunc
}) {
  const resolved = chatId ? resolveChatId(chatId) : null

  return (
    <section className="bg-cream-2 border border-line rounded-lg p-5 space-y-3">
      <h2 className="font-heading text-lg font-semibold text-charcoal">{t('telegram.title')}</h2>

      <div className="flex items-center justify-between text-sm">
        <span className="text-charcoal">{t('telegram.bot_token_label')}</span>
        <span className={botConfigured ? 'text-green-700' : 'text-muted'}>
          {botConfigured ? t('telegram.configured') : t('telegram.not_configured')}
        </span>
      </div>

      <div className="flex items-center justify-between text-sm">
        <span className="text-charcoal">{t('telegram.chat_id_label')}</span>
        {resolved?.status === 'valid' ? (
          <span className="text-green-700">
            {t('telegram.configured')} ({t(`telegram.chat_id_kind_${resolved.kind}`)})
          </span>
        ) : resolved?.status === 'invalid' ? (
          <span className="text-red-600">{t('telegram.chat_id_malformed')}</span>
        ) : (
          <span className="text-muted">{t('telegram.not_configured')}</span>
        )}
      </div>

      <p className="text-xs text-muted">{t('telegram.caveat')}</p>
    </section>
  )
}

// ── Admin actions: test Telegram + manual digest/summary triggers ───────────

type OutcomeTone = 'success' | 'error' | 'neutral'
type Outcome = { tone: OutcomeTone; text: string } | null

function extractTelegramTestErrorReason(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const b = body as Record<string, unknown>
  if (typeof b.description === 'string') return b.description
  if (typeof b.message === 'string') return b.message
  if (typeof b.error === 'string') return b.error
  if (typeof b.reason === 'string') return b.reason
  return undefined
}

function mapBirthdayDigestOutcome(result: BirthdayDigestResult, t: TFunc): Outcome {
  switch (result.status) {
    case 'sent':
      return { tone: 'success', text: t('admin_actions.run_digest.sent', { count: result.count }) }
    case 'skipped_already_sent':
      return { tone: 'neutral', text: t('admin_actions.run_digest.skipped') }
    case 'skipped_concurrent':
      return { tone: 'neutral', text: t('admin_actions.run_digest.concurrent') }
    case 'empty':
      return { tone: 'neutral', text: t('admin_actions.run_digest.empty') }
    case 'send_failed':
      return { tone: 'error', text: t('admin_actions.run_digest.failed', { reason: result.reason }) }
  }
}

function mapAttendanceSummaryOutcome(result: AttendanceSummaryResult, t: TFunc): Outcome {
  const flipped =
    result.flipped_count > 0 ? ` ${t('admin_actions.run_summary.flipped', { count: result.flipped_count })}` : ''
  switch (result.status) {
    case 'sent':
      return { tone: 'success', text: t('admin_actions.run_summary.sent', { count: result.count }) + flipped }
    case 'skipped_already_sent':
      return { tone: 'neutral', text: t('admin_actions.run_summary.skipped') + flipped }
    case 'skipped_concurrent':
      return { tone: 'neutral', text: t('admin_actions.run_summary.concurrent') + flipped }
    case 'empty':
      return { tone: 'neutral', text: t('admin_actions.run_summary.empty') + flipped }
    case 'send_failed':
      return { tone: 'error', text: t('admin_actions.run_summary.failed', { reason: result.reason }) + flipped }
  }
}

const OUTCOME_CLASS: Record<OutcomeTone, string> = {
  success: 'text-green-700',
  error: 'text-red-600',
  neutral: 'text-muted',
}

function AdminActionsSection({ t }: { t: TFunc }) {
  const [testResult, setTestResult] = useState<Outcome>(null)
  const [isTesting, startTest] = useTransition()

  const [digestResult, setDigestResult] = useState<Outcome>(null)
  const [isRunningDigest, startDigest] = useTransition()

  const [summaryResult, setSummaryResult] = useState<Outcome>(null)
  const [isRunningSummary, startSummary] = useTransition()

  function handleSendTest() {
    setTestResult(null)
    startTest(async () => {
      try {
        const response = await fetch('/api/admin/telegram/test', { method: 'POST' })
        const body: unknown = await response.json()
        if (response.ok) {
          setTestResult({ tone: 'success', text: t('admin_actions.test_telegram.success') })
        } else {
          const reason = extractTelegramTestErrorReason(body)
          setTestResult({
            tone: 'error',
            text: reason
              ? t('admin_actions.test_telegram.error', { reason })
              : t('admin_actions.test_telegram.error_generic'),
          })
        }
      } catch {
        setTestResult({ tone: 'error', text: t('admin_actions.test_telegram.error_generic') })
      }
    })
  }

  function handleRunDigest() {
    setDigestResult(null)
    startDigest(async () => {
      const result = await runBirthdayDigestNow()
      if (result.status === 'not_authorized') {
        setDigestResult({ tone: 'error', text: t('admin_actions.not_authorized') })
        return
      }
      setDigestResult(mapBirthdayDigestOutcome(result, t))
    })
  }

  function handleRunSummary() {
    setSummaryResult(null)
    startSummary(async () => {
      const result = await runAttendanceSummaryNow()
      if (result.status === 'not_authorized') {
        setSummaryResult({ tone: 'error', text: t('admin_actions.not_authorized') })
        return
      }
      setSummaryResult(mapAttendanceSummaryOutcome(result, t))
    })
  }

  return (
    <section className="bg-cream-2 border border-line rounded-lg p-5 space-y-5">
      <h2 className="font-heading text-lg font-semibold text-charcoal">{t('admin_actions.title')}</h2>

      <div className="space-y-2">
        <button
          type="button"
          onClick={handleSendTest}
          disabled={isTesting}
          className="inline-flex items-center justify-center rounded-sm border border-line px-4 py-2 text-sm font-medium text-charcoal hover:bg-cream transition-colors disabled:opacity-50"
        >
          {isTesting ? t('admin_actions.test_telegram.button_pending') : t('admin_actions.test_telegram.button')}
        </button>
        {testResult && (
          <p role={testResult.tone === 'error' ? 'alert' : 'status'} className={`text-sm ${OUTCOME_CLASS[testResult.tone]}`}>
            {testResult.text}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <button
          type="button"
          onClick={handleRunDigest}
          disabled={isRunningDigest}
          className="inline-flex items-center justify-center rounded-sm border border-line px-4 py-2 text-sm font-medium text-charcoal hover:bg-cream transition-colors disabled:opacity-50"
        >
          {isRunningDigest ? t('admin_actions.run_digest.button_pending') : t('admin_actions.run_digest.button')}
        </button>
        <p className="text-xs text-muted">{t('admin_actions.run_digest.help')}</p>
        {digestResult && (
          <p
            role={digestResult.tone === 'error' ? 'alert' : 'status'}
            className={`text-sm ${OUTCOME_CLASS[digestResult.tone]}`}
          >
            {digestResult.text}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <button
          type="button"
          onClick={handleRunSummary}
          disabled={isRunningSummary}
          className="inline-flex items-center justify-center rounded-sm border border-line px-4 py-2 text-sm font-medium text-charcoal hover:bg-cream transition-colors disabled:opacity-50"
        >
          {isRunningSummary ? t('admin_actions.run_summary.button_pending') : t('admin_actions.run_summary.button')}
        </button>
        <p className="text-xs text-muted">{t('admin_actions.run_summary.help')}</p>
        {summaryResult && (
          <p
            role={summaryResult.tone === 'error' ? 'alert' : 'status'}
            className={`text-sm ${OUTCOME_CLASS[summaryResult.tone]}`}
          >
            {summaryResult.text}
          </p>
        )}
      </div>
    </section>
  )
}

// ── Pending parishes ──────────────────────────────────────────────────────────

function ParishesSection({
  initialParishes,
  loadError,
  t,
  router,
}: {
  initialParishes: ParishSearchResult[]
  loadError: boolean
  t: TFunc
  router: ReturnType<typeof useRouter>
}) {
  const [parishes, setParishes] = useState(initialParishes)
  const [rowMessage, setRowMessage] = useState<{ id: string } & Message | null>(null)
  const [pendingRowId, setPendingRowId] = useState<string | null>(null)
  const [isRowPending, startRowAction] = useTransition()

  function handleApprove(parishId: string) {
    setRowMessage(null)
    setPendingRowId(parishId)
    startRowAction(async () => {
      const result = await approveParish(parishId)
      if (result.status === 'approved') {
        setParishes((prev) => prev.filter((p) => p.id !== parishId))
        router.refresh()
      } else {
        setRowMessage({ id: parishId, type: 'error', text: t('parishes.approve_error') })
      }
      setPendingRowId(null)
    })
  }

  return (
    <section className="bg-cream-2 border border-line rounded-lg p-5 space-y-3">
      <h2 className="font-heading text-lg font-semibold text-charcoal">{t('parishes.title')}</h2>

      {loadError && <p role="alert" className="text-sm text-red-600">{t('parishes.approve_error')}</p>}

      {!loadError && parishes.length === 0 && (
        <p className="text-sm text-muted">{t('parishes.empty')}</p>
      )}

      {!loadError && parishes.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="pending-parishes-table">
            <thead>
              <tr className="text-left text-muted border-b border-line">
                <th className="py-2 pr-4">{t('parishes.table_name')}</th>
                <th className="py-2 pr-4">{t('parishes.table_city')}</th>
                <th className="py-2 pr-4">{t('parishes.table_region')}</th>
                <th className="py-2 pr-4" />
              </tr>
            </thead>
            <tbody>
              {parishes.map((p) => {
                const rowPending = isRowPending && pendingRowId === p.id
                return (
                  <tr key={p.id} className="border-b border-line/50" data-testid={`parish-row-${p.id}`}>
                    <td className="py-2 pr-4">{p.name}</td>
                    <td className="py-2 pr-4">{p.city ?? '—'}</td>
                    <td className="py-2 pr-4">{p.region ?? '—'}</td>
                    <td className="py-2 pr-4">
                      <button
                        type="button"
                        disabled={rowPending}
                        onClick={() => handleApprove(p.id)}
                        className="text-xs font-medium text-gold hover:text-gold-dark disabled:opacity-50"
                      >
                        {rowPending ? t('parishes.approve_pending') : t('parishes.approve')}
                      </button>
                      {rowMessage?.id === p.id && (
                        <p role="alert" className="text-xs text-red-600 mt-1">{rowMessage.text}</p>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
