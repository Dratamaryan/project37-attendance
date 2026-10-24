'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import type { EventInstanceRow } from '@/lib/actions/events.types'
import { EventImageUpload } from './EventImageUpload'

type Props = {
  eventId: string
  instance: EventInstanceRow
  /** Occurrence display name — alt text for the image preview. */
  displayName: string
}

// Occurrence-details edit surface. The image is uploaded to Storage via its
// own server actions (S9-P0 — paste-a-URL removed); upload/remove apply
// immediately, so there is no Save step. A future field is a new block here.
export function InstanceEditForm({ eventId, instance, displayName }: Props) {
  const t = useTranslations('admin.events.instance.edit')
  const router = useRouter()

  return (
    <div>
      <fieldset className="space-y-5">
        <legend className="font-heading text-lg font-semibold text-charcoal mb-1">
          {t('section.details')}
        </legend>

        <EventImageUpload
          instanceId={instance.id}
          imageUrl={instance.image_url}
          altText={displayName}
        />
      </fieldset>

      <div className="flex items-center gap-3 mt-8">
        <button
          type="button"
          onClick={() => router.push(`/admin/events/${eventId}/instances/${instance.id}`)}
          className="px-5 py-2.5 border border-line text-charcoal rounded-lg text-sm font-medium hover:bg-cream-2 transition-colors"
        >
          {t('back')}
        </button>
      </div>
    </div>
  )
}
