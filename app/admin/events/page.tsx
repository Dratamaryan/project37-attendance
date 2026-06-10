import { createClient } from '@/lib/supabase/server'
import { getTranslations } from 'next-intl/server'
import { listEvents } from '@/lib/actions/events'
import { formatJakarta } from '@/lib/events/timezone'
import Link from 'next/link'
import type { EventRow } from '@/lib/actions/events.types'

type NextInstanceMap = Record<string, string | null>

type SearchParams = Promise<Record<string, string | undefined>>

type Props = { searchParams: SearchParams }

// Fetch the next scheduled instance date for each event_id in one query.
async function fetchNextInstances(eventIds: string[]): Promise<NextInstanceMap> {
  if (eventIds.length === 0) return {}

  const supabase = await createClient()
  const now = new Date().toISOString()

  const { data } = await supabase
    .from('event_instances')
    .select('event_id, scheduled_at')
    .in('event_id', eventIds)
    .gte('scheduled_at', now)
    .eq('status', 'scheduled')
    .order('scheduled_at', { ascending: true })

  const map: NextInstanceMap = {}
  for (const id of eventIds) map[id] = null
  if (data) {
    for (const row of data) {
      if (!map[row.event_id]) {
        map[row.event_id] = row.scheduled_at as string
      }
    }
  }
  return map
}

function EventTypeBadge({ type, label }: { type: string; label: string }) {
  const colors: Record<string, string> = {
    friday_biweekly: 'bg-blue-100 text-blue-700',
    sunday_monthly: 'bg-purple-100 text-purple-700',
    adhoc: 'bg-amber-100 text-amber-700',
    other_recurring: 'bg-teal-100 text-teal-700',
  }
  const cls = colors[type] ?? 'bg-gray-100 text-gray-700'
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {label}
    </span>
  )
}

function EventRow({
  event,
  nextAt,
  t,
  tType,
}: {
  event: EventRow
  nextAt: string | null
  t: (key: string) => string
  tType: (key: string) => string
}) {
  const nextDisplay = nextAt
    ? formatJakarta(new Date(nextAt), 'PPP')
    : t('next_instance_none')

  return (
    <tr className={event.active ? undefined : 'opacity-50'}>
      {/* Name */}
      <td className="px-4 py-3">
        <div className="text-sm font-medium text-charcoal leading-tight">{event.name}</div>
        {event.name_id && (
          <div className="text-xs text-muted leading-tight">{event.name_id}</div>
        )}
      </td>

      {/* Type badge */}
      <td className="px-4 py-3 whitespace-nowrap">
        <EventTypeBadge type={event.event_type} label={tType(event.event_type)} />
      </td>

      {/* Next instance */}
      <td className="px-4 py-3 whitespace-nowrap text-sm text-muted">{nextDisplay}</td>

      {/* Active badge */}
      <td className="px-4 py-3 whitespace-nowrap">
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
            event.active
              ? 'bg-green-100 text-green-700'
              : 'bg-gray-100 text-gray-500'
          }`}
        >
          {event.active ? t('badge.active') : t('badge.inactive')}
        </span>
      </td>

      {/* Edit link */}
      <td className="px-4 py-3 whitespace-nowrap text-right text-sm">
        <Link
          href={`/admin/events/${event.id}/edit`}
          className="text-gold hover:text-gold-dark font-medium transition-colors"
        >
          {t('table.edit')}
        </Link>
      </td>
    </tr>
  )
}

export default async function AdminEventsPage({ searchParams }: Props) {
  const sp = await searchParams
  const t = await getTranslations('admin.events')

  const result = await listEvents({})
  const events: EventRow[] = result.status === 'ok' ? result.events : []

  const nextInstances =
    result.status === 'ok' ? await fetchNextInstances(events.map(e => e.id)) : {}

  const createdId = sp.created
  const instanceCount = sp.instances ? Number(sp.instances) : 0
  const updatedId = sp.updated
  const eventNotFound = sp.event_not_found === '1'

  return (
    <main className="px-4 md:px-6 py-8">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h1 className="font-heading text-3xl font-semibold text-charcoal">{t('title')}</h1>
          <Link
            href="/admin/events/new"
            className="inline-flex items-center gap-2 px-4 py-2 bg-gold text-cream rounded-lg text-sm font-semibold hover:bg-gold-dark transition-colors"
          >
            + {t('create_button')}
          </Link>
        </div>

        {/* Not-found banner */}
        {eventNotFound && (
          <div
            role="alert"
            className="mb-6 px-4 py-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700"
          >
            {t('banner.not_found')}
          </div>
        )}

        {/* Success banners */}
        {createdId && (
          <div
            role="status"
            className="mb-6 px-4 py-3 rounded-lg bg-green-50 border border-green-200 text-sm text-green-700"
          >
            {t('banner.created', { count: instanceCount })}
          </div>
        )}
        {updatedId && !createdId && (
          <div
            role="status"
            className="mb-6 px-4 py-3 rounded-lg bg-green-50 border border-green-200 text-sm text-green-700"
          >
            {t('banner.updated')}
          </div>
        )}

        {/* Error */}
        {result.status === 'error' && (
          <div role="alert" className="py-8 text-center text-sm text-red-600">
            {t('error')}
          </div>
        )}

        {/* Empty state */}
        {result.status === 'ok' && events.length === 0 && (
          <div className="py-16 text-center">
            <p className="text-muted mb-4">{t('empty_state')}</p>
            <Link
              href="/admin/events/new"
              className="inline-flex items-center gap-2 px-4 py-2 bg-gold text-cream rounded-lg text-sm font-semibold hover:bg-gold-dark transition-colors"
            >
              {t('empty_create')}
            </Link>
          </div>
        )}

        {/* Table */}
        {result.status === 'ok' && events.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="min-w-full divide-y divide-line">
              <thead className="bg-cream-2">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-muted uppercase tracking-wider">
                    {t('table.name')}
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-muted uppercase tracking-wider">
                    {t('table.type')}
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-muted uppercase tracking-wider">
                    {t('table.next_instance')}
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-muted uppercase tracking-wider">
                    {t('table.status')}
                  </th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="bg-cream divide-y divide-line">
                {events.map(event => (
                  <EventRow
                    key={event.id}
                    event={event}
                    nextAt={nextInstances[event.id] ?? null}
                    t={t}
                    tType={key => t(`type.${key}`)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  )
}
