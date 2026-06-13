import { getTranslations } from 'next-intl/server'
import Link from 'next/link'
import type { EventRow } from '@/lib/actions/events.types'

// Exported so unit tests can inject a mock translator and assert keys, not hardcoded strings.
export function resolveRruleDesc(
  eventType: string,
  recurrenceRule: string | null | undefined,
  t: (key: string) => string,
): string {
  switch (eventType) {
    case 'friday_monthly':
    case 'sunday_monthly':
    case 'adhoc':
      return t(eventType)
    default:
      return recurrenceRule ?? t('other_recurring')
  }
}

type Props = {
  event: EventRow
  eventId: string
  locale: string
}

function EventTypeBadge({ type, label }: { type: string; label: string }) {
  const colors: Record<string, string> = {
    friday_monthly:  'bg-blue-100 text-blue-700',
    sunday_monthly:  'bg-purple-100 text-purple-700',
    adhoc:           'bg-amber-100 text-amber-700',
    other_recurring: 'bg-teal-100 text-teal-700',
  }
  const cls = colors[type] ?? 'bg-gray-100 text-gray-700'
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {label}
    </span>
  )
}

export async function EventDetailHeader({ event, eventId, locale }: Props) {
  const t      = await getTranslations('admin.events.detail')
  const tType  = await getTranslations('admin.events.type')
  const tRrule = await getTranslations('admin.events.rrule')

  const displayName = locale === 'id'
    ? (event.name_id ?? event.name)
    : event.name

  type RruleKey = Parameters<typeof tRrule>[0]
  const recurrenceDesc = resolveRruleDesc(
    event.event_type,
    event.recurrence_rule,
    (key) => tRrule(key as RruleKey),
  )

  return (
    <div className="flex flex-col gap-4">
      {/* Breadcrumb */}
      <nav className="text-sm text-muted">
        <Link href="/admin/events" className="hover:text-gold transition-colors">
          {t('breadcrumb')}
        </Link>
        {' / '}
        <span className="text-charcoal">{displayName}</span>
      </nav>

      {/* Header row */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-semibold text-charcoal leading-tight">
            {displayName}
          </h1>
          {event.name_id && locale !== 'id' && (
            <p className="text-muted text-sm mt-1">{event.name_id}</p>
          )}
        </div>
        <Link
          href={`/admin/events/${eventId}/edit`}
          className="flex-shrink-0 inline-flex items-center px-4 py-2 border border-line bg-cream-2 rounded-lg text-sm font-medium text-charcoal hover:bg-line transition-colors"
        >
          {t('edit_button')}
        </Link>
      </div>

      {/* Meta badges + info */}
      <div className="flex flex-wrap gap-2 items-center">
        <EventTypeBadge type={event.event_type} label={tType(event.event_type)} />
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
            event.active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
          }`}
        >
          {event.active ? t('status.active') : t('status.inactive')}
        </span>
      </div>

      {/* Details grid */}
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3 text-sm">
        {event.location && (
          <>
            <dt className="text-muted">{t('location_label')}</dt>
            <dd className="text-charcoal">{event.location}</dd>
          </>
        )}
        <dt className="text-muted">{t('duration_label')}</dt>
        <dd className="text-charcoal">{event.duration_min} min</dd>
        <dt className="text-muted">{t('recurrence_label')}</dt>
        <dd className="text-charcoal">{recurrenceDesc}</dd>
      </dl>
    </div>
  )
}
