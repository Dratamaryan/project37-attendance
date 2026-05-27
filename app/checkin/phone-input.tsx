'use client'

import { useRef } from 'react'
import { useTranslations } from 'next-intl'
import {
  SUPPORTED_COUNTRIES,
  COUNTRY_DIAL_CODES,
  type SupportedCountry,
} from '@/lib/utils/phone'

const COUNTRY_FLAGS: Record<SupportedCountry, string> = {
  ID: '🇮🇩',
  SG: '🇸🇬',
  MY: '🇲🇾',
  AU: '🇦🇺',
  NZ: '🇳🇿',
}

type Props = {
  value: string
  country: SupportedCountry
  onPhoneChange: (rawPhone: string, country: SupportedCountry) => void
  inputRef?: React.RefObject<HTMLInputElement | null>
}

export function PhoneInput({ value, country, onPhoneChange, inputRef }: Props) {
  const t = useTranslations('checkin')
  const internalRef = useRef<HTMLInputElement>(null)
  const resolvedRef = inputRef ?? internalRef

  function handleCountryChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value as SupportedCountry
    onPhoneChange(value, next)
    // Re-focus the phone input after country selection.
    // setTimeout(0) lets the browser finish its blur/focus cycle before we steal focus back.
    // If this proves unreliable on iOS Safari, switch to requestAnimationFrame.
    setTimeout(() => resolvedRef.current?.focus(), 0)
  }

  return (
    <div>
      <label className="block text-xs uppercase tracking-widest text-muted font-semibold mb-2">
        {t('phone_label')}
      </label>
      <div className="flex gap-2 items-stretch">
        <select
          value={country}
          onChange={handleCountryChange}
          aria-label={t('country_label')}
          className="px-3 bg-cream border border-line rounded-sm text-sm font-medium text-ink-2 cursor-pointer min-w-[90px] focus:outline-none focus:border-gold"
        >
          {SUPPORTED_COUNTRIES.map((c) => (
            <option key={c} value={c}>
              {COUNTRY_FLAGS[c]} {COUNTRY_DIAL_CODES[c].code} {COUNTRY_DIAL_CODES[c].label.split(' (')[0]}
            </option>
          ))}
        </select>
        <input
          ref={resolvedRef}
          type="tel"
          inputMode="numeric"
          aria-label={t('phone_label')}
          value={value}
          onChange={(e) => onPhoneChange(e.target.value, country)}
          placeholder={t('phone_placeholder')}
          autoFocus
          autoComplete="tel"
          className="flex-1 px-5 py-4 bg-cream border border-line rounded-sm font-heading text-2xl tracking-wide transition-all focus:outline-none focus:border-gold focus:bg-white focus:shadow-[0_0_0_3px_#F5EFD9] placeholder:text-[#9A9183]"
        />
      </div>
    </div>
  )
}
