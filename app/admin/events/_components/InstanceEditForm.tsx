'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { updateInstance } from '@/lib/actions/events'
import type { EventInstanceRow } from '@/lib/actions/events.types'

type Props = {
  eventId: string
  instance: EventInstanceRow
}

type FieldErrors = Record<string, string>

// Paste-a-URL only (locked decision) — validated https + parseable, not
// extension-sniffed (matches impl_updateInstance's server-side rule).
function isValidImageUrl(value: string): boolean {
  if (!value.startsWith('https://')) return false
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

export function InstanceEditForm({ eventId, instance }: Props) {
  const t = useTranslations('admin.events.instance.edit')
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [imageUrl, setImageUrl] = useState(instance.image_url ?? '')
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)

  function validate(): FieldErrors {
    const errors: FieldErrors = {}
    if (imageUrl.trim() !== '' && !isValidImageUrl(imageUrl.trim())) {
      errors.image_url = t('field_error_image_url')
    }
    return errors
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const errors = validate()
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors)
      return
    }
    setFieldErrors({})
    setFormError(null)

    startTransition(async () => {
      const result = await updateInstance(instance.id, {
        image_url: imageUrl.trim() || null,
      })

      if (result.status === 'ok') {
        router.push(`/admin/events/${eventId}/instances/${instance.id}?instance_updated=1`)
        return
      }
      if (result.status === 'invalid_input') {
        setFieldErrors({ [result.field]: result.message })
        return
      }
      setFormError(result.status === 'forbidden' ? t('forbidden_banner') : t('error_banner'))
    })
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      {formError && (
        <div
          role="alert"
          className="mb-6 px-4 py-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700"
        >
          {formError}
        </div>
      )}

      {/* Occurrence details — image today; a future field is a new block here, not a redesign */}
      <fieldset className="space-y-5">
        <legend className="font-heading text-lg font-semibold text-charcoal mb-1">
          {t('section.details')}
        </legend>

        <div>
          <label htmlFor="image_url" className="block text-sm font-medium text-charcoal mb-1">
            {t('image_url_label')}
          </label>
          <input
            id="image_url"
            type="text"
            value={imageUrl}
            onChange={e => setImageUrl(e.target.value)}
            placeholder={t('image_url_placeholder')}
            className={`w-full px-3 py-2 border rounded-lg text-sm text-charcoal bg-cream focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold transition-colors ${fieldErrors.image_url ? 'border-red-400' : 'border-line'}`}
          />
          <p className="mt-1 text-xs text-muted">{t('image_url_help')}</p>
          {fieldErrors.image_url && (
            <p className="mt-1 text-xs text-red-600" role="alert">
              {fieldErrors.image_url}
            </p>
          )}
        </div>
      </fieldset>

      <div className="flex items-center gap-3 mt-8">
        <button
          type="submit"
          disabled={isPending}
          className="px-5 py-2.5 bg-gold text-cream rounded-lg text-sm font-semibold hover:bg-gold-dark transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {isPending ? t('submit_pending') : t('submit')}
        </button>
        <button
          type="button"
          onClick={() => router.push(`/admin/events/${eventId}/instances/${instance.id}`)}
          disabled={isPending}
          className="px-5 py-2.5 border border-line text-charcoal rounded-lg text-sm font-medium hover:bg-cream-2 transition-colors disabled:opacity-60"
        >
          {t('cancel')}
        </button>
      </div>
    </form>
  )
}
