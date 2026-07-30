'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import type { HasEmailRecipient } from '@/lib/actions/invites.types'
import { resendInvite } from '@/lib/actions/invites'

type Props = {
  eventInstanceId: string
  recipients: HasEmailRecipient[]
}

type RowResult =
  | { kind: 'ok'; sequence: number }
  | { kind: 'failed'; message: string }
  | { kind: 'not_found' }
  | { kind: 'forbidden' | 'error'; message: string }

function ResendCell({ eventInstanceId, personId }: { eventInstanceId: string; personId: string }) {
  const t = useTranslations('admin.events.invite.recipients')
  const [result, setResult] = useState<RowResult | null>(null)
  const [isPending, startTransition] = useTransition()

  function handleResend() {
    startTransition(async () => {
      const res = await resendInvite(eventInstanceId, personId)
      if (res.status === 'ok') {
        setResult({ kind: 'ok', sequence: res.sequence })
      } else if (res.status === 'send_failed') {
        setResult({ kind: 'failed', message: res.message })
      } else if (res.status === 'not_found') {
        setResult({ kind: 'not_found' })
      } else {
        setResult({ kind: res.status, message: res.message })
      }
    })
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={handleResend}
        disabled={isPending}
        data-testid={`resend-button-${personId}`}
        className="text-xs font-medium text-charcoal border border-line rounded-sm px-2 py-1 hover:bg-cream-2 transition-colors disabled:opacity-50"
      >
        {isPending ? t('resending') : t('resend_button')}
      </button>
      {result && (
        <span
          role="status"
          data-testid={`resend-result-${personId}`}
          className={`text-xs ${result.kind === 'ok' ? 'text-green-700' : 'text-red-600'}`}
        >
          {result.kind === 'ok' && t('resend_ok', { sequence: result.sequence })}
          {result.kind === 'not_found' && t('resend_not_found')}
          {(result.kind === 'failed' || result.kind === 'forbidden' || result.kind === 'error') &&
            t('resend_failed', { message: result.message })}
        </span>
      )}
    </div>
  )
}

export function RecipientPreviewTable({ eventInstanceId, recipients }: Props) {
  const t = useTranslations('admin.events.invite.recipients')

  if (recipients.length === 0) return null

  return (
    <section aria-label={t('title', { count: recipients.length })}>
      <h3 className="font-heading text-base font-semibold text-charcoal mb-2">
        {t('title', { count: recipients.length })}
      </h3>
      <div className="overflow-x-auto rounded-sm border border-line bg-cream">
        <table className="min-w-full divide-y divide-line">
          <thead>
            <tr>
              <th className="px-3 py-2 text-left text-xs font-medium text-muted">{t('table.name')}</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-muted">{t('table.email')}</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-muted">{t('table.action')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {recipients.map(r => (
              <tr key={r.personId}>
                <td className="px-3 py-2 text-sm text-charcoal">{r.fullName}</td>
                <td className="px-3 py-2 text-sm text-charcoal">{r.email}</td>
                <td className="px-3 py-2 text-sm">
                  <ResendCell eventInstanceId={eventInstanceId} personId={r.personId} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
