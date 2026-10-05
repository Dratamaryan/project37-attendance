'use client'

import { useTranslations } from 'next-intl'
import { formatDayMonth } from '@/lib/utils/date-display'
import type { ChildWithParentSummary } from '@/lib/actions/children.types'

type Props = {
  childMatches: ChildWithParentSummary[]
  /** True when a 6th match existed — the organizer should narrow, not scroll. */
  hasMore: boolean
  onSelect: (child: ChildWithParentSummary) => void
  /** Localized 12-element month array (index 0 = January) for formatDayMonth. */
  months: string[]
}

/**
 * Candidate list for child check-in — both the parent-first path (a parent's
 * children) and the child-name search render it. Children have no phone, so
 * the disambiguators are the parent's name and the birth date as day + month
 * (no year — the screen is routinely held up in a crowd).
 *
 * Selection is not a mutation: tapping a row only calls onSelect, which renders
 * the ChildCard confirm step; that card's own "Check in" button is the only
 * thing that writes (S7-T5 select ≠ commit). There is no un-check-in path in the
 * app, so a row tap must never check a child in.
 */
export function ChildMatchList({ childMatches, hasMore, onSelect, months }: Props) {
  const t = useTranslations('checkin')

  return (
    <div
      data-testid="child-match-list"
      className="mt-4 bg-white border border-line rounded-[4px] overflow-hidden animate-[slideDown_0.3s_ease-out]"
    >
      <p className="px-4 py-2 text-xs uppercase tracking-widest text-muted font-semibold bg-cream border-b border-line">
        {t('child.matches_label')}
      </p>

      <ul>
        {childMatches.map((child) => (
          <li key={child.id} className="border-b border-line last:border-b-0">
            <button
              type="button"
              onClick={() => onSelect(child)}
              // min-h-[44px] tap target (T4); min-w-0 on the flex text column so a
              // long name shrinks instead of pushing the row past the viewport.
              className="w-full flex items-center gap-3 text-left px-4 py-3 min-h-[44px] hover:bg-[#FBF6E8] active:bg-[#F5EFD9] transition-colors"
            >
              <div className="min-w-0 flex-1">
                <p className="font-heading text-lg font-semibold text-charcoal leading-tight truncate">
                  {child.full_name}
                </p>
                <p className="text-sm text-muted mt-0.5 truncate">
                  {t('child.parent_label', { name: child.parent_full_name })}
                </p>
              </div>
              <span className="flex-shrink-0 text-sm text-ink-2 tabular-nums">
                {formatDayMonth(child.birth_date, months)}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {hasMore && (
        <p
          data-testid="child-match-has-more"
          className="px-4 py-2 text-xs text-muted italic bg-cream border-t border-line"
        >
          {t('child.has_more')}
        </p>
      )}
    </div>
  )
}
