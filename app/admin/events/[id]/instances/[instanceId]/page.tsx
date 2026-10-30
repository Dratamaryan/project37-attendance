import { createClient } from '@/lib/supabase/server'
import { getTranslations, getLocale } from 'next-intl/server'
import { redirect } from 'next/navigation'
import { subDays, addDays } from 'date-fns'
import { listEvents, listInstancesForEvent } from '@/lib/actions/events'
import { impl_getInstanceAttendees } from '@/lib/actions/instance-attendees.impl'
import { NotAuthorized } from '@/app/admin/_components/not-authorized'
import { requireActiveAdmin } from '@/lib/auth/require-admin'
import { formatJakarta } from '@/lib/events/timezone'
import { displayInstanceName } from '@/lib/events/display'
import Link from 'next/link'
import { CancelInstanceDialog } from '../../../_components/CancelInstanceDialog'
import { RescheduleInstanceDialog } from '../../../_components/RescheduleInstanceDialog'
import { AttendeesList } from '@/components/attendees/AttendeesList'
import { impl_getInstanceRsvpPanel } from '@/lib/rsvp/admin.impl'
import { buildWhatsAppShareUrl, formatShareDateLabel, type ShareLocale } from '@/lib/rsvp/share'
import { RsvpPanel } from '../../../_components/RsvpPanel'

type Props = {
  params: Promise<{ id: string; instanceId: string }>
  searchParams?: Promise<Record<string, string | undefined>>
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

export default async function AdminInstanceDetailPage({ params, searchParams }: Props) {
  const { id: eventId, instanceId } = await params
  const sp = (await searchParams) ?? {}

  // Admin-only check (D14)
  const supabase = await createClient()
  const authResult = await requireActiveAdmin(supabase)
  if (authResult.status === 'unauthenticated') redirect('/login')
  if (authResult.status === 'denied') return <NotAuthorized />

  const t      = await getTranslations('admin.events.instance')
  const tA     = await getTranslations('checkin.attendees')
  const tR     = await getTranslations('admin.events.instance.rsvp')
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

  // Attendee list — the SAME data + component as /checkin/[instanceId]/attendees
  // (S8-T5 C4): RLS server client, phones masked server-side, soft-deleted excluded.
  const attendees = await impl_getInstanceAttendees({ supabase, instanceId })

  // RSVP panel (S9-R3) — RLS server client; read-time cross-tab, never writes.
  const rsvp = await impl_getInstanceRsvpPanel(instanceId, supabase)

  const dateStr    = formatJakarta(new Date(instance.scheduled_at), 'PPP p')
  // S9.5-T4: reschedule is offered only where reschedule_instance() would
  // accept it — a future scheduled occurrence of a recurring, active event.
  const canReschedule =
    instance.status === 'scheduled' &&
    new Date(instance.scheduled_at).getTime() > now.getTime() &&
    event.active &&
    event.event_type !== 'adhoc' &&
    !!event.recurrence_rule
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

  // Both WhatsApp share texts are built here, independent of the admin's UI
  // locale — the panel defaults to Indonesian and lets the admin switch.
  const rsvpUrl = rsvp.status === 'ok' ? rsvp.panel.link.url : null
  const shareUrl = (shareLocale: ShareLocale, url: string) => buildWhatsAppShareUrl({
    eventName: displayInstanceName({
      scheduledAt: new Date(instance.scheduled_at),
      snapshot:    instance.event_name_snapshot,
      snapshotId:  instance.event_name_snapshot_id,
      liveName:    event.name,
      liveNameId:  event.name_id,
      locale:      shareLocale,
    }),
    dateLabel: formatShareDateLabel(new Date(instance.scheduled_at), shareLocale),
    url,
    locale: shareLocale,
  })
  const whatsAppUrls = rsvpUrl ? { id: shareUrl('id', rsvpUrl), en: shareUrl('en', rsvpUrl) } : null

  return (
    <main className="px-4 md:px-6 py-8">
      <div className="max-w-5xl mx-auto">
        {/* Reschedule success banner — shown on the NEW occurrence (S9.5-T4) */}
        {sp.rescheduled === '1' && (
          <div
            role="status"
            data-testid="reschedule-success-banner"
            className="mb-6 px-4 py-3 rounded-lg bg-green-50 border border-green-200 text-sm text-green-700"
          >
            {t('reschedule.banner_success')}
          </div>
        )}

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
          <div className="flex items-start gap-4">
            {instance.image_url && (
              // <img>, not next/image (S9-P0): legacy pasted URLs may be on any
              // host, so remotePatterns can't cover them.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={instance.image_url}
                alt={displayName}
                className="w-24 h-24 rounded-lg border border-line object-cover flex-shrink-0"
                data-testid="instance-image"
              />
            )}
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
          </div>

          <div className="flex items-center gap-3">
            <Link
              href={`/admin/events/${eventId}/instances/${instanceId}/edit`}
              className="inline-flex items-center px-3 py-1.5 border border-line text-charcoal bg-cream rounded-lg text-sm font-medium hover:bg-cream-2 transition-colors"
            >
              {t('edit_button')}
            </Link>
            {canReschedule && (
              <RescheduleInstanceDialog
                instanceId={instanceId}
                fromLabel={formatJakarta(new Date(instance.scheduled_at), 'yyyy-MM-dd HH:mm')}
                defaultDate={formatJakarta(new Date(instance.scheduled_at), 'yyyy-MM-dd')}
                defaultTime={formatJakarta(new Date(instance.scheduled_at), 'HH:mm')}
              />
            )}
            {/* Cancel affordance — only for scheduled instances */}
            {instance.status === 'scheduled' && (
              <CancelInstanceDialog instanceId={instanceId} eventId={eventId} />
            )}
          </div>
        </div>

        {/* Attendees — shared list + admin export (S8-T5) */}
        {attendees.status === 'ok' ? (
          <>
            <div className="flex items-center justify-between gap-4 mb-4">
              <p className="text-sm text-muted tabular-nums" data-testid="attendee-summary">
                {tA('summary', { adults: String(attendees.adults.length), children: String(attendees.children.length) })}
              </p>
              <a
                href={`/api/admin/export/instance/${instanceId}`}
                data-testid="instance-export-link"
                className="text-sm font-medium text-cream bg-gold hover:bg-gold-dark transition-colors rounded-sm px-3 py-1.5 flex-shrink-0"
              >
                {tA('export_button')}
              </a>
            </div>
            <AttendeesList adults={attendees.adults} childAttendees={attendees.children} />
          </>
        ) : (
          <p role="alert" className="text-sm text-red-600 py-4">{tA('error')}</p>
        )}

        {/* RSVP — link, totals, cross-tab, responses (S9-R3) */}
        {rsvp.status === 'ok' ? (
          <RsvpPanel
            instanceId={instanceId}
            instanceStatus={instance.status}
            panel={rsvp.panel}
            whatsAppUrls={whatsAppUrls}
          />
        ) : (
          <p role="alert" data-testid="rsvp-panel-error" className="text-sm text-red-600 py-4">{tR('error_load')}</p>
        )}
      </div>
    </main>
  )
}
