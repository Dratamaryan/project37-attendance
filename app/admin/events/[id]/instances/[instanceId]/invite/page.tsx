// Vercel's Route Segment Config docs document `maxDuration` on page.tsx /
// layout.tsx / route.ts — this page is what actually invokes `sendInvites`
// (T9's send loop budgets for a 300s wall), so this export is what governs
// the real runtime, not the `maxDuration` export on the 'use server' action
// module alone (see lib/actions/invites.ts). Deploy-verified in the T10 verify
// report — do not remove without re-verifying.
export const maxDuration = 300

import { createClient } from '@/lib/supabase/server'
import { getTranslations, getLocale } from 'next-intl/server'
import { redirect } from 'next/navigation'
import { subDays, addDays } from 'date-fns'
import { listEvents, listInstancesForEvent } from '@/lib/actions/events'
import { NotAuthorized } from '@/app/admin/_components/not-authorized'
import { requireActiveAdmin } from '@/lib/auth/require-admin'
import { formatJakarta } from '@/lib/events/timezone'
import { displayInstanceName } from '@/lib/events/display'
import Link from 'next/link'
import { InvitePanel } from './_components/InvitePanel'

type Props = {
  params: Promise<{ id: string; instanceId: string }>
}

export default async function AdminInviteRecipientsPage({ params }: Props) {
  const { id: eventId, instanceId } = await params

  // Admin-only (D14) — the shared events/layout.tsx allows organizers too, so
  // this page must gate itself independently. This is the tier-3 guard: it
  // must hold even if a future change loosens the layout's role gate.
  const supabase = await createClient()
  const authResult = await requireActiveAdmin(supabase)
  if (authResult.status === 'unauthenticated') redirect('/login')
  if (authResult.status === 'denied') return <NotAuthorized />

  const t      = await getTranslations('admin.events.invite')
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
        <nav className="text-sm text-muted mb-6">
          <Link href="/admin/events" className="hover:text-gold transition-colors">
            {t('breadcrumb')}
          </Link>
          {' / '}
          <Link href={`/admin/events/${eventId}`} className="hover:text-gold transition-colors">
            {eventDisplayName}
          </Link>
          {' / '}
          <Link href={`/admin/events/${eventId}/instances/${instanceId}`} className="hover:text-gold transition-colors">
            {shortDate}
          </Link>
          {' / '}
          <span className="text-charcoal">{t('breadcrumb')}</span>
        </nav>

        <div className="mb-6">
          <h1 className="font-heading text-2xl font-semibold text-charcoal">{t('title')}</h1>
          <p className="text-muted text-sm mt-1">{displayName} — {shortDate}</p>
        </div>

        <InvitePanel eventInstanceId={instanceId} />
      </div>
    </main>
  )
}
