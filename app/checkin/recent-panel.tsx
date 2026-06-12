'use client'

import Image from 'next/image'
import { useTranslations } from 'next-intl'
import { formatJakarta } from '@/lib/events/timezone'
import type { AttendanceWithPerson } from '@/lib/actions/attendance.types'

type Props = {
  attendances: AttendanceWithPerson[]
  isLoading?: boolean
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')
}

export function RecentPanel({ attendances, isLoading = false }: Props) {
  const t = useTranslations('checkin')

  return (
    <div data-testid="recent-panel" className="bg-white border border-line rounded-[4px]">
      <div className="px-5 py-4 border-b border-line flex items-center justify-between">
        <h4 className="font-heading text-lg font-semibold text-charcoal">
          {t('recent_title')}
        </h4>
        {attendances.length > 0 && (
          <span className="text-xs text-muted tabular-nums">{attendances.length}</span>
        )}
      </div>

      {isLoading ? (
        <p className="px-5 py-6 text-sm text-muted italic text-center">
          {t('recent_panel.loading')}
        </p>
      ) : attendances.length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted italic text-center">
          {t('recent_panel.empty')}
        </p>
      ) : (
        <ul>
          {attendances.map((attendance) => {
            const isDeleted = attendance.person.deleted_at !== null
            const timeStr = formatJakarta(new Date(attendance.checked_in_at), 'HH:mm')

            return (
              <li
                key={attendance.id}
                className="px-5 py-3.5 flex items-center gap-3.5 border-b border-line last:border-0"
              >
                {/* Avatar: photo if available, else initials */}
                <div className={`w-9 h-9 rounded-full flex-shrink-0 overflow-hidden flex items-center justify-center ${isDeleted ? 'opacity-50' : ''}`}>
                  {attendance.person.photo_signed_url ? (
                    <Image
                      src={attendance.person.photo_signed_url}
                      alt={attendance.person.full_name}
                      width={36}
                      height={36}
                      className="w-full h-full object-cover rounded-full"
                    />
                  ) : (
                    <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold font-heading ${isDeleted ? 'bg-cream-2 text-muted' : 'bg-cream-2 text-charcoal'}`}>
                      {getInitials(attendance.person.full_name)}
                    </div>
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <p className={`text-sm font-medium leading-tight flex items-center gap-1.5 flex-wrap ${isDeleted ? 'text-muted' : 'text-ink-2'}`}>
                    {attendance.person.full_name}
                    {isDeleted && (
                      <span
                        data-testid="deleted-badge"
                        className="inline-block px-1.5 py-px border border-[#A8924A] text-[#A8924A] text-[10px] font-semibold uppercase tracking-wide rounded-sm"
                      >
                        {t('recent_panel.deleted_badge')}
                      </span>
                    )}
                  </p>
                  {attendance.person.nickname && (
                    <p className={`text-xs mt-0.5 ${isDeleted ? 'text-muted opacity-60' : 'text-muted'}`}>
                      {attendance.person.nickname}
                    </p>
                  )}
                </div>

                <span className="text-xs text-muted tabular-nums flex-shrink-0">
                  {timeStr}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
