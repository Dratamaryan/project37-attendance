'use client'

import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { formatJakarta } from '@/lib/events/timezone'
import { displayInstanceName } from '@/lib/events/display'
import type { EventInstanceRow, EventRow } from '@/lib/actions/events.types'

type Props = {
  instances: EventInstanceRow[]
  event: EventRow
  eventId: string
}

type InstanceGroups = {
  upcoming: EventInstanceRow[]
  past:     EventInstanceRow[]
  cancelled: EventInstanceRow[]
}

export function groupInstances(instances: EventInstanceRow[], now: Date): InstanceGroups {
  const upcoming: EventInstanceRow[] = []
  const past:     EventInstanceRow[] = []
  const cancelled: EventInstanceRow[] = []

  for (const inst of instances) {
    if (inst.status === 'cancelled') {
      cancelled.push(inst)
    } else if (new Date(inst.scheduled_at) >= now) {
      upcoming.push(inst)
    } else {
      past.push(inst)
    }
  }

  upcoming.sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at))  // ASC: nearest first
  past.sort((a, b) => b.scheduled_at.localeCompare(a.scheduled_at))       // DESC: most recent first
  cancelled.sort((a, b) => b.scheduled_at.localeCompare(a.scheduled_at))  // DESC

  return { upcoming, past, cancelled }
}

function StatusBadge({ status }: { status: string }) {
  const t = useTranslations('admin.events.instance')
  const classes: Record<string, string> = {
    scheduled: 'bg-blue-100 text-blue-700',
    cancelled:  'bg-red-100 text-red-700',
    completed:  'bg-green-100 text-green-700',
  }
  const cls = classes[status] ?? 'bg-gray-100 text-gray-700'
  const key = `status.${status}` as Parameters<typeof t>[0]
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {t(key)}
    </span>
  )
}

function InstanceRowItem({
  instance,
  eventId,
  displayName,
}: {
  instance: EventInstanceRow
  eventId: string
  displayName: string
}) {
  const t = useTranslations('admin.events.detail')
  const dateStr = formatJakarta(new Date(instance.scheduled_at), 'PPP p')

  return (
    <tr className="hover:bg-cream-2 transition-colors">
      <td className="px-4 py-3">
        <Link
          href={`/admin/events/${eventId}/instances/${instance.id}`}
          className="text-sm font-medium text-charcoal hover:text-gold transition-colors"
        >
          {dateStr}
        </Link>
      </td>
      <td className="px-4 py-3 whitespace-nowrap">
        <StatusBadge status={instance.status} />
      </td>
      <td className="px-4 py-3 text-sm text-muted">{displayName}</td>
      <td className="px-4 py-3 whitespace-nowrap">
        {/* Admin-only by construction: this row only renders on
            /admin/events/[id], which is itself admin-gated (D14) — an
            organizer never sees this link. The invite page also gates itself
            independently (defense in depth). */}
        <Link
          href={`/admin/events/${eventId}/instances/${instance.id}/invite`}
          data-testid={`invite-link-${instance.id}`}
          className="text-sm font-medium text-gold hover:text-gold-dark transition-colors"
        >
          {t('invite_link')}
        </Link>
      </td>
    </tr>
  )
}

function InstanceGroup({
  title,
  instances,
  eventId,
  event,
  locale,
  emptyLabel,
}: {
  title: string
  instances: EventInstanceRow[]
  eventId: string
  event: EventRow
  locale: string
  emptyLabel: string
}) {
  return (
    <section className="mb-8" aria-label={title}>
      <h3 className="font-heading text-lg font-semibold text-charcoal mb-3">
        {title}
        <span className="ml-2 text-sm font-normal text-muted">({instances.length})</span>
      </h3>
      {instances.length === 0 ? (
        <p className="text-sm text-muted italic py-2">{emptyLabel}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="min-w-full divide-y divide-line">
            <tbody className="bg-cream divide-y divide-line">
              {instances.map(inst => {
                const name = displayInstanceName({
                  scheduledAt: new Date(inst.scheduled_at),
                  snapshot:    inst.event_name_snapshot,
                  snapshotId:  inst.event_name_snapshot_id,
                  liveName:    event.name,
                  liveNameId:  event.name_id,
                  locale:      locale as 'en' | 'id',
                })
                return (
                  <InstanceRowItem
                    key={inst.id}
                    instance={inst}
                    eventId={eventId}
                    displayName={name}
                  />
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

export function InstanceList({ instances, event, eventId }: Props) {
  const t      = useTranslations('admin.events.detail')
  const locale = useLocale()
  const groups = groupInstances(instances, new Date())

  return (
    <div>
      <InstanceGroup
        title={t('group.upcoming')}
        instances={groups.upcoming}
        eventId={eventId}
        event={event}
        locale={locale}
        emptyLabel={t('group.empty')}
      />
      <InstanceGroup
        title={t('group.past')}
        instances={groups.past}
        eventId={eventId}
        event={event}
        locale={locale}
        emptyLabel={t('group.empty')}
      />
      <InstanceGroup
        title={t('group.cancelled')}
        instances={groups.cancelled}
        eventId={eventId}
        event={event}
        locale={locale}
        emptyLabel={t('group.empty')}
      />
    </div>
  )
}
