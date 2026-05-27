'use client'

import { useTranslations } from 'next-intl'
import { formatPhoneForDisplay } from '@/lib/utils/phone'
import type { RecentItem } from './checkin-client'

type Props = {
  items: RecentItem[]
  onItemClick: (item: RecentItem) => void
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')
}

export function RecentPanel({ items, onItemClick }: Props) {
  const t = useTranslations('checkin')

  return (
    <div data-testid="recent-panel" className="bg-white border border-line rounded-[4px]">
      <div className="px-5 py-4 border-b border-line flex items-center justify-between">
        <h4 className="font-heading text-lg font-semibold text-charcoal">
          {t('recent_title')}
        </h4>
        {items.length > 0 && (
          <span className="text-xs text-muted tabular-nums">{items.length}</span>
        )}
      </div>

      {items.length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted italic text-center">
          {t('recent_empty')}
        </p>
      ) : (
        <ul>
          {items.map((item) => (
            <li key={item.person.id}>
              <button
                type="button"
                onClick={() => onItemClick(item)}
                className="w-full px-5 py-3.5 flex items-center gap-3.5 border-b border-line last:border-0 hover:bg-cream transition-colors text-left"
              >
                <div
                  className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold font-heading flex-shrink-0 ${
                    item.isNew ? 'bg-gold text-white' : 'bg-cream-2 text-charcoal'
                  }`}
                >
                  {getInitials(item.person.full_name)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink-2 leading-tight">
                    {item.person.full_name}
                    {item.isNew && (
                      <span className="ml-1.5 inline-block px-1.5 py-px bg-gold text-white text-[10px] font-semibold uppercase tracking-wide rounded-sm">
                        {t('recent_new_badge')}
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-muted mt-0.5">
                    {formatPhoneForDisplay(item.person.phone_e164)}
                  </p>
                </div>
                <span className="text-xs text-muted tabular-nums flex-shrink-0">
                  {item.checkedInAt.toLocaleTimeString('id-ID', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
