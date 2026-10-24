import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { NextIntlClientProvider } from 'next-intl'
import { getMessages, getTranslations } from 'next-intl/server'
import { PublicShell } from '@/components/PublicShell'
import { submitRsvp } from '@/lib/rsvp/public'
import { getRsvpPageData, resolveRsvpLocale } from '@/lib/rsvp/public.impl'
import type { RsvpLocale } from '@/lib/rsvp/public.types'
import { RsvpForm } from './rsvp-form'
import { RsvpNotAvailable } from './rsvp-not-available'

// Every request reads the live link state (open/closed can change any minute)
// and the visitor's locale cookie — never prerender or cache.
export const dynamic = 'force-dynamic'

type Props = {
  params: Promise<{ token: string }>
}

// Cookie 'locale' when id|en, else 'id' — deliberately NOT the admin
// default_language that i18n/request.ts falls back to for other pages.
async function rsvpLocale(): Promise<RsvpLocale> {
  const store = await cookies()
  return resolveRsvpLocale(store.get('locale')?.value)
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { token } = await params
  const locale = await rsvpLocale()
  const t = await getTranslations({ locale, namespace: 'rsvp.meta' })
  const data = await getRsvpPageData(token, locale)

  // Token URLs are capabilities: never indexed, never leaked via Referer.
  const base: Metadata = {
    robots: { index: false, follow: false },
    referrer: 'no-referrer',
  }

  if (data.kind !== 'open') {
    return { ...base, title: t('title_generic') }
  }

  const { event } = data
  const title = t('title', { event: event.name })
  const description = [event.dateLabel, event.timeLabel, event.location]
    .filter((part): part is string => !!part)
    .join(' · ')

  return {
    ...base,
    title,
    description,
    openGraph: {
      title,
      description,
      type: 'website',
      images: event.imageUrl ? [event.imageUrl] : undefined,
    },
  }
}

export default async function RsvpPage({ params }: Props) {
  const { token } = await params
  const locale = await rsvpLocale()
  const data = await getRsvpPageData(token, locale)

  if (data.kind === 'disabled') notFound()

  const t = await getTranslations({ locale, namespace: 'rsvp' })

  if (data.kind === 'closed') {
    return (
      <PublicShell logoHref={null} locale={locale}>
        <main className="flex-1 w-full max-w-xl mx-auto px-4 sm:px-6 py-10">
          <RsvpNotAvailable title={t('closed.title')} body={t('closed.body')} headingLevel={1} />
        </main>
      </PublicShell>
    )
  }

  const { event } = data
  const messages = await getMessages({ locale })

  return (
    <PublicShell logoHref={null} locale={locale}>
      <main className="flex-1 w-full max-w-xl mx-auto px-4 sm:px-6 py-8">
        <header className="mb-6">
          {event.imageUrl && (
            // <img>, not next/image (S9-P0): legacy pasted URLs may be on any
            // host, so remotePatterns can't cover them.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={event.imageUrl}
              alt={event.name}
              className="w-full max-h-80 object-cover rounded-2xl border border-line mb-5"
              data-testid="rsvp-event-image"
            />
          )}
          <h1 className="font-heading text-3xl font-semibold text-charcoal leading-tight mb-2">
            {event.name}
          </h1>
          <p className="text-sm text-ink-2">{event.dateLabel}</p>
          <p className="text-sm text-ink-2">{event.timeLabel}</p>
          {event.location && <p className="text-sm text-muted mt-1">{event.location}</p>}
        </header>

        {/* Pinned to the page's own locale: the root layout's provider follows
            i18n/request.ts (cookie else admin default), which /rsvp does not. */}
        <NextIntlClientProvider locale={locale} messages={{ rsvp: messages.rsvp }}>
          <RsvpForm action={submitRsvp.bind(null, token)} />
        </NextIntlClientProvider>
      </main>
    </PublicShell>
  )
}
