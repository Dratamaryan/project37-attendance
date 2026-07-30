'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import type { NoEmailRecipient } from '@/lib/actions/invites.types'

type Props = {
  recipients: NoEmailRecipient[]
}

// F/4 — first-class deliverable, not an edge case: this is the primary output
// on day one (F/5 — the roster has no emails yet), so it's a headline element,
// not a footnote.
export function NoEmailList({ recipients }: Props) {
  const t = useTranslations('admin.events.invite.no_email')
  const [copied, setCopied] = useState(false)

  const copyText = recipients.map(r => `${r.fullName} — ${r.phoneE164}`).join('\n')

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(copyText)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard API unavailable/denied — the selectable <textarea> below is
      // the fallback, no error UI needed.
    }
  }

  return (
    <section className="p-4 bg-amber-50 border border-amber-200 rounded-sm" aria-label={t('title', { count: recipients.length })}>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h3 className="font-heading text-base font-semibold text-charcoal">
            {t('title', { count: recipients.length })}
          </h3>
          <p className="text-sm text-muted mt-0.5">{t('subtitle')}</p>
        </div>
        {recipients.length > 0 && (
          <button
            type="button"
            onClick={handleCopy}
            data-testid="no-email-copy-button"
            className="text-sm font-medium text-cream bg-gold hover:bg-gold-dark transition-colors rounded-sm px-3 py-1.5 shrink-0"
          >
            {copied ? t('copied') : t('copy_button')}
          </button>
        )}
      </div>

      {recipients.length === 0 ? (
        <p className="text-sm text-muted italic mt-3">{t('empty')}</p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-sm border border-amber-200 mt-3 bg-cream">
            <table className="min-w-full divide-y divide-line">
              <thead>
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium text-muted">{t('table.name')}</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-muted">{t('table.phone')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {recipients.map(r => (
                  <tr key={r.personId}>
                    <td className="px-3 py-2 text-sm text-charcoal">{r.fullName}</td>
                    <td className="px-3 py-2 text-sm text-charcoal">{r.phoneE164}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Selectable fallback for browsers/contexts without Clipboard API access */}
          <textarea
            readOnly
            value={copyText}
            aria-label={t('copy_button')}
            data-testid="no-email-copy-fallback"
            className="w-full mt-3 text-xs text-muted border border-amber-200 rounded-sm px-2 py-1.5 bg-cream resize-y"
            rows={Math.min(recipients.length + 1, 6)}
          />
        </>
      )}
    </section>
  )
}
