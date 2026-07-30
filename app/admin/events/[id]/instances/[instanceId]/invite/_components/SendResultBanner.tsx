'use client'

import { useTranslations } from 'next-intl'
import type { SendInvitesResult } from '@/lib/actions/invites.types'

type Props = {
  result: Extract<SendInvitesResult, { status: 'ok' }>
}

export function SendResultBanner({ result }: Props) {
  const t = useTranslations('admin.events.invite.send')

  return (
    <div role="status" data-testid="send-result-banner" className="p-3 bg-green-50 border border-green-200 rounded-sm text-sm text-green-800">
      <p>
        {t('result', { sent: result.sent, failed: result.failed, skipped: result.skippedAlreadySent })}
      </p>
      {result.remaining > 0 && (
        <p className="font-medium mt-1" data-testid="send-remaining-hint">
          {t('remaining', { remaining: result.remaining })}
        </p>
      )}
    </div>
  )
}
