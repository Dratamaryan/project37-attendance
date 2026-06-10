import { getTranslations } from 'next-intl/server'
import { EventForm } from '../_components/EventForm'

export default async function AdminEventsNewPage() {
  const t = await getTranslations('admin.events')

  return (
    <main className="px-4 md:px-6 py-8">
      <div className="max-w-2xl mx-auto">
        <h1 className="font-heading text-3xl font-semibold text-charcoal mb-8">
          {t('create_button')}
        </h1>
        <EventForm mode="create" />
      </div>
    </main>
  )
}
