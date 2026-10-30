'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { rescheduleInstance } from '@/lib/actions/events'
import type { RescheduleErrorCode } from '@/lib/actions/events.types'

type Props = {
  instanceId: string
  /** Current slot, already formatted in WIB ('yyyy-MM-dd HH:mm') */
  fromLabel: string
  /** Form defaults: the current slot's WIB date ('yyyy-MM-dd') and time ('HH:mm') */
  defaultDate: string
  defaultTime: string
}

const MAX_REASON_LENGTH = 500  // same cap as reschedule_instance()

// S9.5-T4: two steps — form (date, time, reason), then a confirm step that
// spells out the consequences before anything is written.
export function RescheduleInstanceDialog({ instanceId, fromLabel, defaultDate, defaultTime }: Props) {
  const t      = useTranslations('admin.events.instance')
  const router = useRouter()

  const [step,   setStep]   = useState<'closed' | 'form' | 'confirm'>('closed')
  const [date,   setDate]   = useState(defaultDate)
  const [time,   setTime]   = useState(defaultTime)
  const [reason, setReason] = useState('')
  const [error,  setError]  = useState<RescheduleErrorCode | null>(null)
  const [isPending, startTransition] = useTransition()

  function handleOpen() {
    setStep('form')
    setDate(defaultDate)
    setTime(defaultTime)
    setReason('')
    setError(null)
  }

  function handleClose() {
    if (isPending) return
    setStep('closed')
    setError(null)
  }

  function handleContinue() {
    if (!date) return setError('invalid_date')
    if (!time) return setError('invalid_time')
    if (!reason.trim()) return setError('reason_required')
    setError(null)
    setStep('confirm')
  }

  // useTransition inside event handler (button click) — valid per React 19 rule.
  function handleConfirm() {
    setError(null)
    startTransition(async () => {
      const result = await rescheduleInstance(instanceId, date, time, reason)
      if (result.status === 'ok') {
        setStep('closed')
        router.push(`/admin/events/${result.event_id}/instances/${result.instance_id}?rescheduled=1`)
        return
      }
      setError(result.code)
      setStep('form')
    })
  }

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        className="inline-flex items-center px-3 py-1.5 border border-line text-charcoal bg-cream rounded-lg text-sm font-medium hover:bg-cream-2 transition-colors"
      >
        {t('reschedule_button')}
      </button>

      {step !== 'closed' && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="reschedule-dialog-title"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
        >
          <div className="bg-cream rounded-xl border border-line shadow-lg max-w-md w-full p-6">
            {step === 'form' ? (
              <>
                <h2
                  id="reschedule-dialog-title"
                  className="font-heading text-xl font-semibold text-charcoal mb-2"
                >
                  {t('reschedule.title')}
                </h2>
                <p className="text-sm text-muted mb-4">{t('reschedule.intro')}</p>

                <div className="grid grid-cols-2 gap-3 mb-4">
                  <div>
                    <label htmlFor="reschedule-date" className="block text-sm font-medium text-charcoal mb-1.5">
                      {t('reschedule.date_label')}
                    </label>
                    <input
                      id="reschedule-date"
                      type="date"
                      value={date}
                      onChange={e => setDate(e.target.value)}
                      required
                      className="w-full px-3 py-2 border border-line rounded-lg text-sm text-charcoal focus:outline-none focus:ring-2 focus:ring-gold/50"
                    />
                  </div>
                  <div>
                    <label htmlFor="reschedule-time" className="block text-sm font-medium text-charcoal mb-1.5">
                      {t('reschedule.time_label')}
                    </label>
                    <input
                      id="reschedule-time"
                      type="time"
                      value={time}
                      onChange={e => setTime(e.target.value)}
                      required
                      className="w-full px-3 py-2 border border-line rounded-lg text-sm text-charcoal focus:outline-none focus:ring-2 focus:ring-gold/50"
                    />
                  </div>
                </div>

                <label htmlFor="reschedule-reason" className="block text-sm font-medium text-charcoal mb-1.5">
                  {t('reschedule.reason_label')}
                </label>
                <textarea
                  id="reschedule-reason"
                  value={reason}
                  onChange={e => setReason(e.target.value.slice(0, MAX_REASON_LENGTH))}
                  placeholder={t('reschedule.reason_placeholder')}
                  rows={3}
                  maxLength={MAX_REASON_LENGTH}
                  required
                  className="w-full px-3 py-2 border border-line rounded-lg text-sm text-charcoal placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-gold/50 resize-none"
                />
                <p className="text-xs text-muted mt-1 text-right" aria-live="polite">
                  {reason.length}/{MAX_REASON_LENGTH}
                </p>

                {error && (
                  <p role="alert" className="text-sm text-red-600 mt-3">
                    {t(`reschedule.errors.${error}`)}
                  </p>
                )}

                <div className="flex gap-3 mt-6 justify-end">
                  <button
                    type="button"
                    onClick={handleClose}
                    className="px-4 py-2 text-sm font-medium text-charcoal border border-line rounded-lg hover:bg-cream-2 transition-colors"
                  >
                    {t('reschedule.keep')}
                  </button>
                  <button
                    type="button"
                    onClick={handleContinue}
                    className="px-4 py-2 text-sm font-medium text-cream bg-gold rounded-lg hover:bg-gold-dark transition-colors"
                  >
                    {t('reschedule.continue')}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2
                  id="reschedule-dialog-title"
                  className="font-heading text-xl font-semibold text-charcoal mb-4"
                >
                  {t('reschedule.confirm_title')}
                </h2>

                <dl className="text-sm text-charcoal space-y-1 mb-4" data-testid="reschedule-summary">
                  <div>{t('reschedule.confirm_from', { date: fromLabel })}</div>
                  <div>{t('reschedule.confirm_to', { date: `${date} ${time}` })}</div>
                  <div className="break-words">{t('reschedule.confirm_reason', { reason: reason.trim() })}</div>
                </dl>

                <ul className="list-disc pl-5 text-sm text-red-700 space-y-1" data-testid="reschedule-warnings">
                  <li>{t('reschedule.warning_cancelled')}</li>
                  <li>{t('reschedule.warning_new_link')}</li>
                  <li>{t('reschedule.warning_existing')}</li>
                </ul>

                <div className="flex gap-3 mt-6 justify-end">
                  <button
                    type="button"
                    onClick={() => setStep('form')}
                    disabled={isPending}
                    className="px-4 py-2 text-sm font-medium text-charcoal border border-line rounded-lg hover:bg-cream-2 transition-colors disabled:opacity-50"
                  >
                    {t('reschedule.back')}
                  </button>
                  <button
                    type="button"
                    onClick={handleConfirm}
                    disabled={isPending}
                    className="px-4 py-2 text-sm font-medium text-cream bg-red-600 rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50"
                  >
                    {isPending ? t('reschedule.confirming') : t('reschedule.confirm')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  )
}
