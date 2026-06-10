// Pure helper that synthesises a recurrence rule string from the event type.
// The RRuleInput component is only rendered for the 'other_recurring' type.

import { useTranslations } from 'next-intl'

// Maps event_type → RRULE string (or null for adhoc).
// These strings MUST match the seed data used in T2/T4.
export function buildRRule(
  event_type: string,
  rawRRule?: string,
): string | null {
  switch (event_type) {
    case 'friday_biweekly':
      return 'FREQ=WEEKLY;INTERVAL=2;BYDAY=FR'
    case 'sunday_monthly':
      return 'FREQ=MONTHLY;BYDAY=1SU'
    case 'adhoc':
      return null
    case 'other_recurring':
      return rawRRule?.trim() || null
    default:
      return null
  }
}

type RRuleInputProps = {
  value: string
  onChange: (v: string) => void
  error?: string
}

export function RRuleInput({ value, onChange, error }: RRuleInputProps) {
  const t = useTranslations('admin.events.form')

  return (
    <div>
      <label className="block text-sm font-medium text-charcoal mb-1">
        {t('rrule_label')}
      </label>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={t('rrule_placeholder')}
        className={`w-full px-3 py-2 border rounded-lg text-sm text-charcoal bg-cream focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold transition-colors font-mono ${error ? 'border-red-400' : 'border-line'}`}
        aria-describedby="rrule-help"
      />
      <p id="rrule-help" className="mt-1 text-xs text-muted">
        {t('rrule_help')}
      </p>
      {error && (
        <p className="mt-1 text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
