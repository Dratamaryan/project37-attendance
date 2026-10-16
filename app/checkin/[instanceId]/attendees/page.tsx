import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { createClient } from '@/lib/supabase/server'
import { requireActiveRole } from '@/lib/auth/require-admin'
import { NotAuthorized } from '@/app/admin/_components/not-authorized'
import { impl_getInstanceAttendees } from '@/lib/actions/instance-attendees.impl'
import { formatJakarta } from '@/lib/events/timezone'
import { AttendeesList } from './_components/AttendeesList'

type Props = {
  params: Promise<{ instanceId: string }>
}

/**
 * /checkin/[instanceId]/attendees — S8-T5 attendee list for one instance.
 *
 * Any ACTIVE app user (organizer or admin). Data comes from
 * impl_getInstanceAttendees on the user-session server client (RLS), and phones
 * are already masked there — only "•••• 1234" ever reaches the client. The
 * per-instance export link is rendered for admins only; the export route
 * enforces requireActiveAdmin on its own.
 */
export default async function InstanceAttendeesPage({ params }: Props) {
  const { instanceId } = await params

  const supabase = await createClient()
  const auth = await requireActiveRole(supabase, ['admin', 'organizer'])
  if (auth.status === 'unauthenticated') redirect('/login')
  if (auth.status === 'denied') return <NotAuthorized />

  const t = await getTranslations('checkin.attendees')
  const result = await impl_getInstanceAttendees({ supabase, instanceId })
  if (result.status === 'invalid_input' || result.status === 'not_found') notFound()

  const isAdmin = auth.role === 'admin'

  return (
    <main className="max-w-3xl mx-auto px-4 sm:px-6 py-6">
      <Link href="/checkin" className="text-sm text-muted hover:text-gold transition-colors">
        ← {t('back')}
      </Link>

      {result.status === 'error' ? (
        <p role="alert" className="mt-6 text-sm text-red-600">{t('error')}</p>
      ) : (
        <>
          <div className="mt-3 mb-6 pb-5 border-b border-line flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs uppercase tracking-widest text-gold-dark font-semibold mb-1">
                {t('title')}
              </p>
              <h1 className="font-heading text-3xl font-semibold text-charcoal leading-tight">
                {result.instance.event_name_snapshot}
              </h1>
              <p className="text-sm text-ink-2 mt-1">
                {t('scheduled_at', { when: formatJakarta(new Date(result.instance.scheduled_at), 'd MMM yyyy · HH:mm') })}
              </p>
              <p className="text-xs text-muted mt-1 tabular-nums" data-testid="attendee-summary">
                {t('summary', { adults: String(result.adults.length), children: String(result.children.length) })}
              </p>
            </div>
            {isAdmin && (
              <a
                href={`/api/admin/export/instance/${result.instance.id}`}
                data-testid="instance-export-link"
                className="self-start sm:self-auto text-sm font-medium text-cream bg-gold hover:bg-gold-dark transition-colors rounded-sm px-3 py-1.5 flex-shrink-0"
              >
                {t('export_button')}
              </a>
            )}
          </div>

          <AttendeesList adults={result.adults} childAttendees={result.children} />
        </>
      )}
    </main>
  )
}
