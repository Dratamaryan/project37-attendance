'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { cancelInstance } from '@/lib/actions/events'

type Props = {
  instanceId: string
  eventId: string
}

const MAX_REASON_LENGTH = 500  // D4: cancel reason max 500 chars

export function CancelInstanceDialog({ instanceId, eventId }: Props) {
  const t      = useTranslations('admin.events.instance')
  const router = useRouter()

  const [isOpen,  setIsOpen]  = useState(false)
  const [reason,  setReason]  = useState('')
  const [error,   setError]   = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function handleOpen() {
    setIsOpen(true)
    setReason('')
    setError(null)
  }

  function handleClose() {
    if (isPending) return
    setIsOpen(false)
    setError(null)
  }

  // useTransition inside event handler (button click) — valid per React 19 rule.
  function handleConfirm() {
    setError(null)
    startTransition(async () => {
      const result = await cancelInstance(instanceId, reason.trim() || undefined)

      if (result.status === 'ok') {
        setIsOpen(false)
        router.push(`/admin/events/${eventId}?instance_cancelled=${instanceId}`)
        return
      }
      if (result.status === 'already_cancelled') {
        setIsOpen(false)
        router.push(`/admin/events/${eventId}?already_cancelled=1`)
        return
      }
      if (result.status === 'not_found') {
        setError(t('cancel_dialog.error_not_found'))
        return
      }
      // forbidden / error
      setError(t('cancel_dialog.error'))
    })
  }

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        className="inline-flex items-center px-3 py-1.5 border border-red-300 text-red-700 bg-red-50 rounded-lg text-sm font-medium hover:bg-red-100 transition-colors"
      >
        {t('cancel_button')}
      </button>

      {isOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="cancel-dialog-title"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
        >
          <div className="bg-cream rounded-xl border border-line shadow-lg max-w-md w-full p-6">
            <h2
              id="cancel-dialog-title"
              className="font-heading text-xl font-semibold text-charcoal mb-4"
            >
              {t('cancel_dialog.title')}
            </h2>

            <label htmlFor="cancel-reason" className="block text-sm font-medium text-charcoal mb-1.5">
              {t('cancel_dialog.reason_label')}
            </label>
            <textarea
              id="cancel-reason"
              value={reason}
              onChange={e => setReason(e.target.value.slice(0, MAX_REASON_LENGTH))}
              placeholder={t('cancel_dialog.reason_placeholder')}
              rows={3}
              maxLength={MAX_REASON_LENGTH}
              className="w-full px-3 py-2 border border-line rounded-lg text-sm text-charcoal placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-gold/50 resize-none"
            />
            <p className="text-xs text-muted mt-1 text-right" aria-live="polite">
              {reason.length}/{MAX_REASON_LENGTH}
            </p>

            {error && (
              <p role="alert" className="text-sm text-red-600 mt-3">
                {error}
              </p>
            )}

            <div className="flex gap-3 mt-6 justify-end">
              <button
                type="button"
                onClick={handleClose}
                disabled={isPending}
                className="px-4 py-2 text-sm font-medium text-charcoal border border-line rounded-lg hover:bg-cream-2 transition-colors disabled:opacity-50"
              >
                {t('cancel_dialog.cancel')}
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                disabled={isPending}
                className="px-4 py-2 text-sm font-medium text-cream bg-red-600 rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50"
              >
                {isPending ? t('cancel_dialog.confirming') : t('cancel_dialog.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
