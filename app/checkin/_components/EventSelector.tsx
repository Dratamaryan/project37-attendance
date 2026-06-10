'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import Link from 'next/link'
import { formatJakarta } from '@/lib/events/timezone'
import type { NearestInstanceRow } from '@/lib/actions/events.types'

type Props = {
  instances: NearestInstanceRow[]
  isAdmin: boolean
  onInstanceChange: (id: string) => void
}

function hoursDiff(scheduledAt: string): { past: boolean; hours: number } {
  const diffMs = Date.now() - new Date(scheduledAt).getTime()
  return {
    past: diffMs > 0,
    hours: Math.round(Math.abs(diffMs) / 3_600_000),
  }
}

export function EventSelector({ instances, isAdmin, onInstanceChange }: Props) {
  const t = useTranslations('checkin.event_selector')
  const [selectedId, setSelectedId] = useState<string | null>(instances[0]?.id ?? null)
  const [open, setOpen] = useState(false)

  if (instances.length === 0) {
    return (
      <div
        role="status"
        className="mb-6 flex items-center justify-between gap-3 px-4 py-3 bg-[#FAF8F3] border border-[#E8E2D3] rounded-[4px] text-sm text-[#6B6357]"
      >
        <span>{t('no_events')}</span>
        {isAdmin && (
          <Link
            href="/admin/events/new"
            className="text-xs font-medium text-[#A8924A] hover:text-[#8B7635] underline underline-offset-2 flex-shrink-0"
          >
            {t('no_events_admin_link')}
          </Link>
        )}
      </div>
    )
  }

  const selected = instances.find((i) => i.id === selectedId) ?? instances[0]
  const others = instances.filter((i) => i.id !== selected.id).slice(0, 4)

  const formattedTime = formatJakarta(new Date(selected.scheduled_at), 'd MMM yyyy · HH:mm')
  const { past, hours } = hoursDiff(selected.scheduled_at)
  const indicator = past
    ? t('ended_ago', { hours: String(hours) })
    : t('starts_in', { hours: String(hours) })

  function handleSelect(id: string) {
    setSelectedId(id)
    setOpen(false)
    onInstanceChange(id)
  }

  return (
    <div className="mb-6 relative" data-testid="event-selector">
      {/* Header card */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={t('select_event')}
        className="w-full text-left px-4 py-3 bg-[#FAF8F3] border border-[#E8E2D3] rounded-[4px] hover:border-[#A8924A] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#A8924A]"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-widest text-[#A8924A] font-semibold mb-0.5">
              {t('event_label')}
            </p>
            <p className="font-heading text-lg font-semibold text-[#0F0F0F] leading-snug truncate">
              {selected.event_name_snapshot}
            </p>
            <p className="text-xs text-[#3D3833] mt-0.5">{formattedTime}</p>
            <p
              className={`text-xs mt-1 font-medium ${past ? 'text-[#6B6357]' : 'text-[#5C8A6B]'}`}
              data-testid={past ? 'indicator-past' : 'indicator-future'}
            >
              {indicator}
            </p>
          </div>
          {others.length > 0 && (
            <span
              aria-hidden="true"
              className={`mt-1 flex-shrink-0 text-[#6B6357] transition-transform ${open ? 'rotate-180' : ''}`}
            >
              ▾
            </span>
          )}
        </div>
      </button>

      {/* Dropdown */}
      {open && others.length > 0 && (
        <ul
          role="listbox"
          aria-label={t('select_event')}
          className="absolute z-10 top-full left-0 right-0 mt-1 bg-white border border-[#E8E2D3] rounded-[4px] shadow-[0_4px_12px_rgba(0,0,0,0.08)] overflow-hidden"
        >
          {others.map((inst) => {
            const instTime = formatJakarta(new Date(inst.scheduled_at), 'd MMM yyyy · HH:mm')
            return (
              <li key={inst.id} role="option" aria-selected={inst.id === selectedId}>
                <button
                  type="button"
                  onClick={() => handleSelect(inst.id)}
                  className="w-full text-left px-4 py-3 hover:bg-[#FAF8F3] transition-colors border-b border-[#E8E2D3] last:border-b-0"
                >
                  <p className="text-sm font-medium text-[#0F0F0F] truncate">
                    {inst.event_name_snapshot}
                  </p>
                  <p className="text-xs text-[#6B6357] mt-0.5">{instTime}</p>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
