'use client'

import { useTranslations } from 'next-intl'
import { maskPhoneTail } from '@/lib/utils/phone'
import type { PersonSummary } from '@/lib/actions/people.types'

type Props = {
  people: PersonSummary[]
  /** True when a 6th match existed — the organizer should narrow, not scroll. */
  hasMore: boolean
  onSelect: (person: PersonSummary) => void
}

/**
 * Candidate list for check-in by name. A name is not unique (phone is), so this
 * is the disambiguation step: the organizer taps the right person to SELECT
 * them for review. Selection is not a mutation — tapping only sets the parent's
 * selectedNamePerson, which renders the same PersonCard the phone flow uses;
 * that card's own "Check in" button is the only thing that writes. Because a
 * selection immediately swaps this list out for the confirm card, this
 * component is never visible while a check-in is in flight or disabled, so
 * unlike PersonCard it carries no pending/disabled props of its own.
 *
 * The phone is masked to its last four digits — enough to tell two people with
 * the same name apart, without printing full numbers onto a screen that is
 * routinely held up in a crowd.
 */
export function NameMatchList({ people, hasMore, onSelect }: Props) {
  const t = useTranslations('checkin')

  return (
    <div
      data-testid="name-match-list"
      className="mt-4 bg-white border border-line rounded-[4px] overflow-hidden animate-[slideDown_0.3s_ease-out]"
    >
      <p className="px-4 py-2 text-xs uppercase tracking-widest text-muted font-semibold bg-cream border-b border-line">
        {t('name_search.matches_label')}
      </p>

      <ul>
        {people.map((person) => (
          <li key={person.id} className="border-b border-line last:border-b-0">
            <button
              type="button"
              onClick={() => onSelect(person)}
              // min-h-[44px] tap target (T4); min-w-0 on the flex text column so a
              // long name shrinks instead of pushing the row past the viewport.
              className="w-full flex items-center gap-3 text-left px-4 py-3 min-h-[44px] hover:bg-[#FBF6E8] active:bg-[#F5EFD9] transition-colors"
            >
              <div className="min-w-0 flex-1">
                <p className="font-heading text-lg font-semibold text-charcoal leading-tight truncate">
                  {person.full_name}
                </p>
                {person.nickname && (
                  <p className="text-sm text-muted mt-0.5 truncate">{person.nickname}</p>
                )}
              </div>
              <span className="flex-shrink-0 text-sm text-ink-2 tabular-nums">
                {maskPhoneTail(person.phone_e164)}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {hasMore && (
        <p
          data-testid="name-match-has-more"
          className="px-4 py-2 text-xs text-muted italic bg-cream border-t border-line"
        >
          {t('name_search.has_more')}
        </p>
      )}
    </div>
  )
}
