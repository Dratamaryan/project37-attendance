import { getTranslations } from 'next-intl/server'
import { redirect } from 'next/navigation'
import { hasFutureOccurrences, listEvents } from '@/lib/actions/events'
import { createClient } from '@/lib/supabase/server'
import { requireActiveAdmin } from '@/lib/auth/require-admin'
import { EventForm } from '../../_components/EventForm'
import type { EventRow } from '@/lib/actions/events.types'

type Props = {
  params: Promise<{ id: string }>
}

export default async function AdminEventEditPage({ params }: Props) {
  const { id } = await params
  const t = await getTranslations('admin.events')

  // Re-use listEvents and filter by id — no separate single-event action needed.
  const result = await listEvents({})
  if (result.status === 'error') {
    redirect('/admin/events')
  }

  const event: EventRow | undefined = result.events.find(e => e.id === id)

  if (!event) {
    // Redirect with flag so the list page can show an error banner.
    redirect('/admin/events?event_not_found=1')
  }

  // S9.5-T5.5: schedule fields are locked while upcoming occurrences exist
  // (enforced by trg_events_schedule_lock; this only drives the form state).
  const scheduleLocked = await hasFutureOccurrences(event.id)
  // S9.5-T5.5 P2: admins may move a locked schedule (R/A); this only drives
  // the form — apply_event_schedule_change() enforces admin-only.
  const isAdmin = (await requireActiveAdmin(await createClient())).status === 'ok'

  return (
    <main className="px-4 md:px-6 py-8">
      <div className="max-w-2xl mx-auto">
        <h1 className="font-heading text-3xl font-semibold text-charcoal mb-2">
          {t('form.submit_update')}
        </h1>
        <p className="text-muted text-sm mb-8">{event.name}</p>
        <EventForm mode="edit" initialData={event} scheduleLocked={scheduleLocked} isAdmin={isAdmin} />
      </div>
    </main>
  )
}
