'use client'

import { useState } from 'react'
import Image from 'next/image'
import { useTranslations } from 'next-intl'
import { formatJakarta } from '@/lib/events/timezone'
import type { AttendanceWithPerson } from '@/lib/actions/attendance.types'

type Props = {
  attendances: AttendanceWithPerson[]
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .slice(0, 2)
    .map(w => w[0]?.toUpperCase() ?? '')
    .join('')
}

export function AttendeeTable({ attendances }: Props) {
  const t = useTranslations('admin.events.instance')
  const [search, setSearch] = useState('')

  if (attendances.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted italic">
        {t('table.empty')}
      </p>
    )
  }

  // Sort ASC by checked_in_at (chronological check-in order — T2-08 acceptance)
  const sorted = [...attendances].sort((a, b) =>
    a.checked_in_at.localeCompare(b.checked_in_at),
  )

  const filtered = search
    ? sorted.filter(a => {
        const q = search.toLowerCase()
        return (
          a.person.full_name.toLowerCase().includes(q) ||
          (a.person.nickname?.toLowerCase().includes(q) ?? false) ||
          a.person.phone_e164.includes(q)
        )
      })
    : sorted

  return (
    <div>
      <div className="mb-4">
        <input
          type="text"
          placeholder={t('search_placeholder')}
          value={search}
          onChange={e => setSearch(e.target.value)}
          aria-label={t('search_placeholder')}
          className="w-full px-3 py-2 border border-line rounded-lg text-sm text-charcoal placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-gold/50"
        />
      </div>

      {filtered.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted italic">
          {t('search_no_results')}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="min-w-full divide-y divide-line">
            <thead className="bg-cream-2">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-muted uppercase tracking-wider w-12">
                  {t('table.photo')}
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-muted uppercase tracking-wider">
                  {t('table.name')}
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-muted uppercase tracking-wider">
                  {t('table.phone')}
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-muted uppercase tracking-wider whitespace-nowrap">
                  {t('table.checked_in_at')}
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-muted uppercase tracking-wider whitespace-nowrap">
                  {t('table.checked_in_by')}
                </th>
              </tr>
            </thead>
            <tbody className="bg-cream divide-y divide-line">
              {filtered.map(att => {
                const isDeleted = att.person.deleted_at !== null
                const timeStr   = formatJakarta(new Date(att.checked_in_at), 'HH:mm')
                return (
                  <tr
                    key={att.id}
                    data-testid="attendee-row"
                    className={isDeleted ? 'opacity-60' : undefined}
                  >
                    {/* Photo thumb */}
                    <td className="px-4 py-3">
                      <div className="w-8 h-8 rounded-full overflow-hidden flex items-center justify-center bg-cream-2 flex-shrink-0">
                        {att.person.photo_signed_url ? (
                          <Image
                            src={att.person.photo_signed_url}
                            alt={att.person.full_name}
                            width={32}
                            height={32}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <span className="text-xs font-semibold text-charcoal font-heading">
                            {getInitials(att.person.full_name)}
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Name + nickname + (deleted) badge */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-sm font-medium text-charcoal leading-tight">
                          {att.person.full_name}
                        </span>
                        {att.person.nickname && (
                          <span className="text-xs text-muted">({att.person.nickname})</span>
                        )}
                        {isDeleted && (
                          <span
                            data-testid="deleted-badge"
                            className="inline-block px-1.5 py-px border border-[#A8924A] text-[#A8924A] text-[10px] font-semibold uppercase tracking-wide rounded-sm"
                          >
                            {t('deleted_badge')}
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Phone */}
                    <td className="px-4 py-3 text-sm text-muted font-mono whitespace-nowrap">
                      {att.person.phone_e164}
                    </td>

                    {/* Checked-in at */}
                    <td className="px-4 py-3 text-sm text-muted tabular-nums whitespace-nowrap">
                      {timeStr}
                    </td>

                    {/* Checked-in by */}
                    <td className="px-4 py-3 text-sm text-muted">
                      {att.checked_in_by_email ?? att.checked_in_by}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
