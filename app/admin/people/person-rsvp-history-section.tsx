import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { formatJakarta } from '@/lib/events/timezone'
import type { ListPersonRsvpHistoryResult } from '@/lib/rsvp/admin.types'

type Props = {
  /** Loaded server-side by page.tsx via impl_listPersonRsvpHistory. */
  result: ListPersonRsvpHistoryResult
}

/**
 * S9-R3b: the person's RSVPs on the admin person page — every RSVP that
 * resolves to them (matched at submit or via a later phone match), newest
 * occurrence first. Server-rendered and read-only (no client state); rendered
 * by page.tsx UNDER PersonChildrenSection with the same section styling. No
 * phone is shown. A load failure renders an alert in place of the list
 * without affecting the rest of the page.
 */
export function PersonRsvpHistorySection({ result }: Props) {
  const t = useTranslations('admin.people.rsvp_history')

  return (
    <section data-testid="person-rsvp-history" className="mt-10 pt-6 border-t border-line">
      <h2 className="text-xs font-semibold text-muted uppercase tracking-wider mb-3">{t('title')}</h2>

      {result.status !== 'ok' ? (
        <p role="alert" className="text-sm text-[#A85959]">{t('error')}</p>
      ) : result.rows.length === 0 ? (
        <p data-testid="person-rsvp-empty" className="text-sm text-muted">{t('empty')}</p>
      ) : (
        <ul className="bg-white border border-line rounded-sm divide-y divide-line">
          {result.rows.map(row => (
            <li key={row.rsvp_id} data-testid="person-rsvp-row" className="px-4 py-3">
              <p className="text-sm text-charcoal flex items-center gap-2 flex-wrap">
                <span className="tabular-nums text-muted">{formatJakarta(new Date(row.scheduled_at), 'yyyy-MM-dd HH:mm')}</span>
                <Link
                  href={`/admin/events/${row.event_id}/instances/${row.instance_id}`}
                  className="font-medium hover:text-gold transition-colors"
                >
                  {row.display_name}
                </Link>
                {row.instance_status === 'cancelled' && (
                  <span
                    data-testid="person-rsvp-cancelled"
                    className="inline-block px-1.5 py-px bg-red-50 text-red-700 text-[10px] font-semibold uppercase tracking-wide rounded-sm"
                  >
                    {t('cancelled')}
                  </span>
                )}
              </p>
              <p className="text-xs text-muted mt-0.5">
                {t(`status.${row.rsvp_status}`)}
                {' · '}{t('children', { count: row.children_count })}
                {' · '}{row.attended ? t('attended_yes') : t('attended_no')}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
