'use client'

import { useTranslations } from 'next-intl'
import { formatDayMonth } from '@/lib/utils/date-display'
import type { ChildWithParentSummary } from '@/lib/actions/children.types'

type Props = {
  child: ChildWithParentSummary
  onCheckIn: (child: ChildWithParentSummary) => void
  /** Returns to the match list it came from — the parent never re-queries. */
  onBack: () => void
  /** Localized 12-element month array (index 0 = January) for formatDayMonth. */
  months: string[]
  /** True while the createChildAttendance server action is in flight. */
  checkInPending?: boolean
  /** True when no event instance is selected — button disabled with inline notice. */
  checkInDisabled?: boolean
}

/**
 * Confirm step for child check-in (mirrors PersonCard). Its "Check in" button
 * is the ONLY control that writes a child_attendance row — selecting a match
 * only renders this card.
 */
export function ChildCard({
  child,
  onCheckIn,
  onBack,
  months,
  checkInPending = false,
  checkInDisabled = false,
}: Props) {
  const t = useTranslations('checkin')

  return (
    <>
      <div className="mt-4 flex items-center gap-3 text-sm">
        <button
          type="button"
          onClick={onBack}
          className="text-muted hover:text-charcoal transition-colors underline underline-offset-2 min-h-[44px]"
        >
          {t('child.back_to_results')}
        </button>
      </div>
      <div
        data-testid="child-card"
        className="mt-4 p-5 bg-[#FBF6E8] border border-[#F5EFD9] rounded-[4px] animate-[slideDown_0.3s_ease-out]"
      >
        <div className="min-w-0 mb-4">
          <p className="font-heading text-2xl font-semibold text-charcoal leading-tight">
            {child.full_name}
          </p>
          <p className="text-sm text-ink-2 mt-1">
            {t('child.parent_label', { name: child.parent_full_name })}
          </p>
          <p className="text-sm text-muted mt-0.5">
            {t('child.birthday_label', { date: formatDayMonth(child.birth_date, months) })}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => onCheckIn(child)}
            disabled={checkInPending || checkInDisabled}
            className="px-5 py-3 bg-charcoal text-cream text-sm font-medium rounded-sm hover:bg-ink-2 active:translate-y-px transition-all min-h-[44px] disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {checkInPending ? t('child.check_in_button_pending') : t('child.check_in_button')}
          </button>
          {checkInDisabled && (
            <p className="text-xs text-muted italic">{t('results.no_event_selected')}</p>
          )}
        </div>
      </div>
    </>
  )
}
