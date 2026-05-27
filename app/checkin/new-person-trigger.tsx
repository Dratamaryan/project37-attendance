'use client'

import { useTranslations } from 'next-intl'
import { formatPhoneForDisplay } from '@/lib/utils/phone'

type Props = {
  normalizedE164: string
}

export function NewPersonTrigger({ normalizedE164 }: Props) {
  const t = useTranslations('checkin')
  const display = formatPhoneForDisplay(normalizedE164)

  return (
    <div className="mt-4 p-5 bg-cream-2 border border-dashed border-[#D9D1BD] rounded-[4px] animate-[slideDown_0.3s_ease-out]">
      <div className="flex items-center gap-3 mb-4 pb-4 border-b border-line">
        <div className="w-8 h-8 rounded-full bg-charcoal text-cream flex items-center justify-center flex-shrink-0">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </div>
        <p className="text-sm text-ink-2">
          {t('lookup_not_found')}
          {' '}
          <span className="font-medium text-charcoal">{display}</span>
        </p>
      </div>
      <button
        type="button"
        onClick={() => {/* Task 9 wires this up */}}
        className="px-4 py-2.5 bg-charcoal text-cream text-sm font-medium rounded-sm hover:bg-ink-2 active:translate-y-px transition-all min-h-[44px]"
      >
        {t('add_new_person')}
      </button>
    </div>
  )
}
