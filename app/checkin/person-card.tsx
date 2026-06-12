'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { getPhotoSignedUrl } from '@/lib/storage/photos'
import { formatPhoneForDisplay } from '@/lib/utils/phone'
import type { PersonSummary } from '@/lib/actions/people.types'

type Props = {
  person: PersonSummary
  onCheckIn: (person: PersonSummary) => void
  /** True while the createAttendance server action is in flight. */
  checkInPending?: boolean
  /** True when no event instance is selected — button disabled with inline notice. */
  checkInDisabled?: boolean
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')
}

export function PersonCard({
  person,
  onCheckIn,
  checkInPending = false,
  checkInDisabled = false,
}: Props) {
  const t = useTranslations('checkin')
  const [photoUrl, setPhotoUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!person.photo_url) return
    let cancelled = false

    getPhotoSignedUrl(person.photo_url).then((result) => {
      if (cancelled) return
      if (result.status === 'signed' || result.status === 'legacy_url') {
        setPhotoUrl(result.url)
      }
    })

    return () => {
      cancelled = true
      setPhotoUrl(null)
    }
  }, [person.photo_url])

  const initials = getInitials(person.full_name)

  return (
    <div className="mt-4 p-5 bg-[#FBF6E8] border border-[#F5EFD9] rounded-[4px] animate-[slideDown_0.3s_ease-out]">
      <div className="flex items-center gap-4 mb-4">
        {photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={photoUrl}
            alt={person.full_name}
            className="w-20 h-20 rounded-full object-cover flex-shrink-0"
          />
        ) : (
          <div
            aria-label={initials}
            className="w-20 h-20 rounded-full bg-gold text-white flex items-center justify-center font-heading text-2xl font-semibold flex-shrink-0"
          >
            {initials}
          </div>
        )}
        <div className="min-w-0">
          <p className="font-heading text-2xl font-semibold text-charcoal leading-tight">
            {person.full_name}
          </p>
          {person.nickname && (
            <p className="text-sm text-muted mt-0.5">{person.nickname}</p>
          )}
          <p className="text-sm text-ink-2 mt-1">
            {formatPhoneForDisplay(person.phone_e164)}
          </p>
          {person.origin_parish && (
            <p className="text-xs text-muted mt-0.5">{person.origin_parish}</p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => onCheckIn(person)}
          disabled={checkInPending || checkInDisabled}
          className="px-5 py-3 bg-charcoal text-cream text-sm font-medium rounded-sm hover:bg-ink-2 active:translate-y-px transition-all min-h-[44px] disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {checkInPending ? t('check_in_button_pending') : t('check_in_button')}
        </button>
        {checkInDisabled && (
          <p className="text-xs text-muted italic">{t('results.no_event_selected')}</p>
        )}
      </div>
    </div>
  )
}
