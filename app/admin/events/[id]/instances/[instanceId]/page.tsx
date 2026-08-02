import { createClient } from '@/lib/supabase/server'
import { getTranslations, getLocale } from 'next-intl/server'
import { redirect } from 'next/navigation'
import { subDays, addDays } from 'date-fns'
import { listEvents, listInstancesForEvent } from '@/lib/actions/events'
import { listRecentAttendanceForInstance } from '@/lib/actions/attendance'
import { NotAuthorized } from '@/app/admin/_components/not-authorized'
import { requireActiveAdmin } from '@/lib/auth/require-admin'
import { formatJakarta } from '@/lib/events/timezone'
import { displayInstanceName } from '@/lib/events/display'
import Link from 'next/link'
import { AttendeeTable } from '../../../_components/AttendeeTable'
import { CancelInstanceDialog } from '../../../_components/CancelInstanceDialog'

type Props = {
  params: Promise<{ id: string; instanceId: string }>
}

function StatusBadge({ status }: { status: string }) {
  const classes: Record<string, string> = {
    scheduled: 'bg-blue-100 text-blue-700',
    cancelled: 'bg-red-100 text-red-700',
    completed: 'bg-green-100 text-green-700',
  }
  const labels: Record<string, string> = {
    scheduled: 'Scheduled',
    cancelled: 'Cancelled',
    completed: 'Completed',
  }
  const cls = classes[status] ?? 'bg-gray-100 text-gray-700'
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {labels[status] ?? status}
    </span>
  )
}

export default async function AdminInstanceDetailPage({ params }: Props) {
  const { id: eventId, instanceId } = await params

  // Admin-only check (D14)
  const supabase = await createClient()
  const authResult = await requireActiveAdmin(supabase)
  if (authResult.status === 'unauthenticated') redirect('/login')
  if (authResult.status === 'denied') return <NotAuthorized />

  const t      = await getTranslations('admin.events.instance')
  const locale = await getLocale()

  // Fetch parent event (D8)
  const eventsResult = await listEvents({})
  if (eventsResult.status === 'error') redirect('/admin/events')
  const event = eventsResult.events.find(e => e.id === eventId)
  if (!event) redirect('/admin/events?event_not_found=1')

  // Fetch instance via listInstancesForEvent with wide range, then find by instanceId
  const now = new Date()
  const instancesResult = await listInstancesForEvent(eventId, {
    from: subDays(now, 365),
    to:   addDays(now, 365),
  })
  if (instancesResult.status === 'error') redirect(`/admin/events/${eventId}`)
  const instance = instancesResult.instances.find(i => i.id === instanceId)
  if (!instance) redirect(`/admin/events/${eventId}`)

  // Attendee list — limit 500 (D1), admin client used by impl for deleted visibility
  const attendanceResult = await listRecentAttendanceForInstance({
    eventInstanceId: instanceId,
    limit: 500,
  })
  const attendances = attendanceResult.status === 'ok' ? attendanceResult.attendances : []

  const dateStr    = formatJakarta(new Date(instance.scheduled_at), 'PPP p')
  const shortDate  = formatJakarta(new Date(instance.scheduled_at), 'PP')
  const displayName = displayInstanceName({
    scheduledAt: new Date(instance.scheduled_at),
    snapshot:    instance.event_name_snapshot,
    snapshotId:  instance.event_name_snapshot_id,
    liveName:    event.name,
    liveNameId:  event.name_id,
    locale:      locale as 'en' | 'id',
  })

  const eventDisplayName = locale === 'id' ? (event.name_id ?? event.name) : event.name

  return (
    <main className="px-4 md:px-6 py-8">
      <div className="max-w-5xl mx-auto">
        {/* Breadcrumb */}
        <nav className="text-sm text-muted mb-6">
          <Link href="/admin/events" className="hover:text-gold transition-colors">
            {t('breadcrumb_events')}
          </Link>
          {' / '}
          <Link href={`/admin/events/${eventId}`} className="hover:text-gold transition-colors">
            {eventDisplayName}
          </Link>
          {' / '}
          <span className="text-charcoal">{shortDate}</span>
        </nav>

        {/* Instance header */}
        <div className="flex items-start justify-between gap-4 mb-8">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <h1 className="font-heading text-2xl font-semibold text-charcoal">
                {dateStr}
              </h1>
              <StatusBadge status={instance.status} />
            </div>
            <p className="text-muted text-sm">{displayName}</p>
            {instance.notes && (
              <p className="text-muted text-sm mt-1 italic">{instance.notes}</p>
            )}
          </div>

          {/* Cancel affordance — only for scheduled instances */}
          {instance.status === 'scheduled' && (
            <CancelInstanceDialog instanceId={instanceId} eventId={eventId} />
          )}
        </div>

        {/* Attendee count */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-heading text-lg font-semibold text-charcoal">
            {t('attendee_count', { count: String(attendances.length) })}
          </h2>
        </div>

        {/* Attendee table */}
        {attendanceResult.status === 'error' ? (
          <p className="text-sm text-red-600 py-4">{t('table.error')}</p>
        ) : (
          <AttendeeTable attendances={attendances} />
        )}
      </div>
    </main>
  )
}
