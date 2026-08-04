import { createClient } from '@/lib/supabase/server'
import { getTranslations, getLocale } from 'next-intl/server'
import { redirect } from 'next/navigation'
import { subDays, addDays } from 'date-fns'
import { listEvents, listInstancesForEvent } from '@/lib/actions/events'
import { NotAuthorized } from '@/app/admin/_components/not-authorized'
import { requireActiveAdmin } from '@/lib/auth/require-admin'
import { formatJakarta } from '@/lib/events/timezone'
import Link from 'next/link'
import { InstanceEditForm } from '../../../../_components/InstanceEditForm'

type Props = {
  params: Promise<{ id: string; instanceId: string }>
}

export default async function AdminInstanceEditPage({ params }: Props) {
  const { id: eventId, instanceId } = await params

  const supabase = await createClient()
  const authResult = await requireActiveAdmin(supabase)
  if (authResult.status === 'unauthenticated') redirect('/login')
  if (authResult.status === 'denied') return <NotAuthorized />

  const t      = await getTranslations('admin.events.instance')
  const te     = await getTranslations('admin.events.instance.edit')
  const locale = await getLocale()

  const eventsResult = await listEvents({})
  if (eventsResult.status === 'error') redirect('/admin/events')
  const event = eventsResult.events.find(e => e.id === eventId)
  if (!event) redirect('/admin/events?event_not_found=1')

  const now = new Date()
  const instancesResult = await listInstancesForEvent(eventId, {
    from: subDays(now, 365),
    to:   addDays(now, 365),
  })
  if (instancesResult.status === 'error') redirect(`/admin/events/${eventId}`)
  const instance = instancesResult.instances.find(i => i.id === instanceId)
  if (!instance) redirect(`/admin/events/${eventId}`)

  const shortDate = formatJakarta(new Date(instance.scheduled_at), 'PP')
  const eventDisplayName = locale === 'id' ? (event.name_id ?? event.name) : event.name

  return (
    <main className="px-4 md:px-6 py-8">
      <div className="max-w-2xl mx-auto">
        <nav className="text-sm text-muted mb-6">
          <Link href="/admin/events" className="hover:text-gold transition-colors">
            {t('breadcrumb_events')}
          </Link>
          {' / '}
          <Link href={`/admin/events/${eventId}`} className="hover:text-gold transition-colors">
            {eventDisplayName}
          </Link>
          {' / '}
          <Link
            href={`/admin/events/${eventId}/instances/${instanceId}`}
            className="hover:text-gold transition-colors"
          >
            {shortDate}
          </Link>
          {' / '}
          <span className="text-charcoal">{te('title')}</span>
        </nav>

        <h1 className="font-heading text-3xl font-semibold text-charcoal mb-8">
          {te('title')}
        </h1>

        <InstanceEditForm eventId={eventId} instance={instance} />
      </div>
    </main>
  )
}
