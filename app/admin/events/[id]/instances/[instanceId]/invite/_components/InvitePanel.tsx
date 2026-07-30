'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import type { RecipientFilter, ResolveRecipientsResult, SendInvitesResult } from '@/lib/actions/invites.types'
import { resolveRecipients, sendInvites } from '@/lib/actions/invites'
import { FilterPicker } from './FilterPicker'
import { NoEmailList } from './NoEmailList'
import { RecipientPreviewTable } from './RecipientPreviewTable'
import { SendResultBanner } from './SendResultBanner'

type Props = {
  eventInstanceId: string
}

type OkSendResult = Extract<SendInvitesResult, { status: 'ok' }>

export function InvitePanel({ eventInstanceId }: Props) {
  const t = useTranslations('admin.events.invite')

  const [filter, setFilter] = useState<RecipientFilter>({})
  const [preview, setPreview] = useState<ResolveRecipientsResult | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [isPreviewing, startPreview] = useTransition()

  const [sendResult, setSendResult] = useState<OkSendResult | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const [isSending, startSend] = useTransition()

  function handlePreview() {
    setPreviewError(null)
    startPreview(async () => {
      try {
        const result = await resolveRecipients(filter)
        setPreview(result)
        setSendResult(null)
      } catch {
        setPreviewError(t('filter.error'))
      }
    })
  }

  function handleSend() {
    setSendError(null)
    startSend(async () => {
      const result = await sendInvites(eventInstanceId, filter)
      if (result.status === 'ok') {
        setSendResult(result)
        setPreview({ hasEmail: preview?.hasEmail ?? [], noEmail: result.noEmail })
      } else if (result.status === 'forbidden') {
        setSendError(t('send.forbidden'))
      } else {
        setSendError(t('send.error'))
      }
    })
  }

  return (
    <div className="space-y-6">
      <FilterPicker
        filter={filter}
        onChange={setFilter}
        onPreview={handlePreview}
        isPreviewing={isPreviewing}
      />

      {previewError && (
        <p role="alert" className="text-sm text-red-600">{previewError}</p>
      )}

      {!preview && !previewError && (
        <p className="text-sm text-muted italic">{t('preview.empty')}</p>
      )}

      {preview && (
        <>
          <p className="text-sm text-charcoal" data-testid="preview-summary">
            {t('preview.summary', { hasEmail: preview.hasEmail.length, noEmail: preview.noEmail.length })}
          </p>

          <NoEmailList recipients={preview.noEmail} />

          <div>
            <button
              type="button"
              onClick={handleSend}
              disabled={isSending}
              data-testid="send-button"
              className="text-sm font-medium text-cream bg-gold hover:bg-gold-dark transition-colors rounded-sm px-4 py-2 disabled:opacity-50"
            >
              {isSending ? t('send.sending') : t('send.button')}
            </button>
          </div>

          {sendError && (
            <p role="alert" className="text-sm text-red-600">{sendError}</p>
          )}
          {sendResult && <SendResultBanner result={sendResult} />}

          <RecipientPreviewTable eventInstanceId={eventInstanceId} recipients={preview.hasEmail} />
        </>
      )}
    </div>
  )
}
