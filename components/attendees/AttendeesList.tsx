'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { formatJakarta } from '@/lib/events/timezone'
import type { InstanceAdultAttendee, InstanceChildAttendee } from '@/lib/actions/instance-attendees.types'

type Props = {
  adults: InstanceAdultAttendee[]
  childAttendees: InstanceChildAttendee[]
}

/** Digits of a masked phone — "•••• 1234" → "1234"; null/bare mask → "". */
function last4(masked: string | null): string {
  return masked?.replace(/\D/g, '') ?? ''
}

function matches(query: string, names: Array<string | null>, maskedPhone: string | null): boolean {
  if (query === '') return true
  if (/^\d+$/.test(query)) return last4(maskedPhone).includes(query)
  return names.some(n => n?.toLowerCase().includes(query) ?? false)
}

export function AttendeesList({ adults, childAttendees }: Props) {
  const t = useTranslations('checkin.attendees')
  const [search, setSearch] = useState('')
  const query = search.trim().toLowerCase()

  const shownAdults = adults.filter(a => matches(query, [a.full_name, a.nickname], a.phone_masked))
  const shownChildren = childAttendees.filter(c => matches(query, [c.child_name, c.parent_name], c.parent_phone_masked))
  const noResults = query !== '' && shownAdults.length === 0 && shownChildren.length === 0

  return (
    <div>
      <input
        type="search"
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder={t('search_placeholder')}
        aria-label={t('search_placeholder')}
        className="w-full mb-6 px-3 py-2.5 border border-line rounded-[4px] bg-white text-sm text-charcoal placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-gold/50"
      />

      {noResults && (
        <p className="py-4 text-center text-sm text-muted italic">{t('search_no_results')}</p>
      )}

      <section aria-labelledby="attendees-adults" className="mb-8">
        <h2 id="attendees-adults" className="font-heading text-xl font-semibold text-charcoal mb-3">
          {t('section_adults')} <span className="text-sm text-muted tabular-nums font-sans">· {shownAdults.length}</span>
        </h2>
        {adults.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted italic text-center bg-white border border-line rounded-[4px]">
            {t('empty_adults')}
          </p>
        ) : shownAdults.length > 0 && (
          <ul className="bg-white border border-line rounded-[4px]">
            {shownAdults.map(a => (
              <li
                key={a.attendance_id}
                data-testid="adult-row"
                className="px-4 py-3 flex items-center gap-3 border-b border-line last:border-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink-2 leading-tight flex items-center gap-1.5 flex-wrap">
                    <span>{a.full_name}</span>
                    {a.nickname && <span className="text-xs text-muted font-normal">({a.nickname})</span>}
                    {a.is_first_timer && (
                      <span
                        data-testid="first-timer-badge"
                        className="inline-block px-1.5 py-px bg-gold-light text-gold-dark text-[10px] font-semibold uppercase tracking-wide rounded-sm"
                      >
                        {t('first_timer_badge')}
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-muted font-mono mt-0.5">{a.phone_masked}</p>
                </div>
                <span className="text-xs text-muted tabular-nums flex-shrink-0">
                  {formatJakarta(new Date(a.checked_in_at), 'HH:mm')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="attendees-children">
        <h2 id="attendees-children" className="font-heading text-xl font-semibold text-charcoal mb-3">
          {t('section_children')} <span className="text-sm text-muted tabular-nums font-sans">· {shownChildren.length}</span>
        </h2>
        {childAttendees.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted italic text-center bg-white border border-line rounded-[4px]">
            {t('empty_children')}
          </p>
        ) : shownChildren.length > 0 && (
          <ul className="bg-white border border-line rounded-[4px]">
            {shownChildren.map(c => (
              <li
                key={c.child_attendance_id}
                data-testid="child-row"
                className="px-4 py-3 flex items-center gap-3 border-b border-line last:border-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink-2 leading-tight">{c.child_name}</p>
                  <p className="text-xs text-muted mt-0.5">
                    {c.parent_name ? t('parent_label', { name: c.parent_name }) : t('parent_unknown')}
                    {c.parent_phone_masked && <span className="font-mono"> · {c.parent_phone_masked}</span>}
                  </p>
                </div>
                <span className="text-xs text-muted tabular-nums flex-shrink-0">
                  {formatJakarta(new Date(c.checked_in_at), 'HH:mm')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
