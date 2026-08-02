import { createClient } from '@/lib/supabase/server'
import { getTranslations, getLocale } from 'next-intl/server'
import { redirect } from 'next/navigation'
import { subDays, addDays } from 'date-fns'
import { listEvents, listInstancesForEvent } from '@/lib/actions/events'
import { NotAuthorized } from '@/app/admin/_components/not-authorized'
import { requireActiveAdmin } from '@/lib/auth/require-admin'
import { EventDetailHeader } from '../_components/EventDetailHeader'
import { InstanceList } from '../_components/InstanceList'

type Props = {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | undefined>>
}

export default async function AdminEventDetailPage({ params, searchParams }: Props) {
  const { id: eventId } = await params
  const sp = await searchParams

  // Admin-only: events layout allows organizers for list/create/edit; detail is admin-only (D14)
  const supabase = await createClient()
  const authResult = await requireActiveAdmin(supabase)
  if (authResult.status === 'unauthenticated') redirect('/login')
  if (authResult.status === 'denied') return <NotAuthorized />

  const t      = await getTranslations('admin.events.detail')
  const locale = await getLocale()

  // D8: no getEvent(id) action yet — use listEvents().find() (same as edit page)
  const eventsResult = await listEvents({})
  if (eventsResult.status === 'error') redirect('/admin/events')
  const event = eventsResult.events.find(e => e.id === eventId)
  if (!event) redirect('/admin/events?event_not_found=1')

  // Wider window: ±365 days (spec: "T10 UI may pass a custom range")
  const now = new Date()
  const instancesResult = await listInstancesForEvent(eventId, {
    from: subDays(now, 365),
    to:   addDays(now, 365),
  })
  const instances = instancesResult.status === 'ok' ? instancesResult.instances : []

  const instanceCancelled = sp.instance_cancelled
  const alreadyCancelled  = sp.already_cancelled === '1'

  return (
    <main className="px-4 md:px-6 py-8">
      <div className="max-w-5xl mx-auto">
        {/* Cancel success banner */}
        {instanceCancelled && (
          <div
            role="status"
            className="mb-6 px-4 py-3 rounded-lg bg-green-50 border border-green-200 text-sm text-green-700"
          >
            {t('banner.instance_cancelled')}
          </div>
        )}
        {/* Already-cancelled benign banner */}
        {alreadyCancelled && (
          <div
            role="status"
            className="mb-6 px-4 py-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-700"
          >
            {t('banner.already_cancelled')}
          </div>
        )}

        <EventDetailHeader event={event} eventId={eventId} locale={locale} />

        <div className="mt-10">
          {instancesResult.status === 'error' ? (
            <p className="text-sm text-red-600">{t('instances_error')}</p>
          ) : (
            <InstanceList instances={instances} event={event} eventId={eventId} />
          )}
        </div>
      </div>
    </main>
  )
}
