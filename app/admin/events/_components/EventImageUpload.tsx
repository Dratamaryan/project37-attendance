'use client'

import { useState, useRef, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { uploadInstanceImage, removeInstanceImage } from '@/lib/storage/event-images'
import {
  EVENT_IMAGE_MAX_BYTES,
  EVENT_IMAGE_MIME_TYPES,
} from '@/lib/storage/event-images.types'

type Props = {
  instanceId: string
  /** Current event_instances.image_url — Storage public URL or a legacy pasted URL. */
  imageUrl: string | null
  /** Alt text for the preview — the occurrence's display name. */
  altText: string
}

type Status = { kind: 'success' | 'error'; message: string } | null

const ACCEPTED_MIME: readonly string[] = EVENT_IMAGE_MIME_TYPES

// Modelled on app/checkin/photo-upload.tsx, minus consent fields. Upload and
// remove act immediately (each is its own server action + audit row) — there
// is no separate Save step. The client precheck is UX only; the server action
// re-validates size, MIME and magic bytes.
export function EventImageUpload({ instanceId, imageUrl, altText }: Props) {
  const t = useTranslations('admin.events.instance.edit')
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [pendingAction, setPendingAction] = useState<'upload' | 'remove' | null>(null)
  const [currentUrl, setCurrentUrl] = useState<string | null>(imageUrl)
  const [status, setStatus] = useState<Status>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  function resetInput() {
    if (inputRef.current) inputRef.current.value = ''
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setStatus(null)

    if (!ACCEPTED_MIME.includes(file.type)) {
      setStatus({ kind: 'error', message: t('image.error_invalid_type') })
      resetInput()
      return
    }
    if (file.size > EVENT_IMAGE_MAX_BYTES) {
      setStatus({ kind: 'error', message: t('image.error_too_large') })
      resetInput()
      return
    }

    setPendingAction('upload')
    startTransition(async () => {
      try {
        const result = await uploadInstanceImage(instanceId, file)
        switch (result.status) {
          case 'uploaded':
            setCurrentUrl(result.url)
            setStatus({ kind: 'success', message: t('image.uploaded') })
            router.refresh()
            break
          case 'too_large':
            setStatus({ kind: 'error', message: t('image.error_too_large') })
            break
          case 'invalid_type':
            setStatus({ kind: 'error', message: t('image.error_invalid_type') })
            break
          case 'not_authorized':
            setStatus({ kind: 'error', message: t('forbidden_banner') })
            break
          case 'not_found':
            setStatus({ kind: 'error', message: t('image.error_not_found') })
            break
          case 'error':
            setStatus({ kind: 'error', message: t('error_banner') })
            break
        }
      } catch (err) {
        // A server action can throw (e.g. body over bodySizeLimit) rather
        // than return a discriminated result.
        console.error('[EventImageUpload] upload threw', err)
        setStatus({ kind: 'error', message: t('error_banner') })
      } finally {
        setPendingAction(null)
        resetInput()
      }
    })
  }

  function handleRemove() {
    setStatus(null)
    setPendingAction('remove')
    startTransition(async () => {
      try {
        const result = await removeInstanceImage(instanceId)
        switch (result.status) {
          case 'removed':
          case 'no_image':
            setCurrentUrl(null)
            setStatus({ kind: 'success', message: t('image.removed') })
            router.refresh()
            break
          case 'not_authorized':
            setStatus({ kind: 'error', message: t('forbidden_banner') })
            break
          case 'not_found':
            setStatus({ kind: 'error', message: t('image.error_not_found') })
            break
          case 'error':
            setStatus({ kind: 'error', message: t('error_banner') })
            break
        }
      } catch (err) {
        console.error('[EventImageUpload] remove threw', err)
        setStatus({ kind: 'error', message: t('error_banner') })
      } finally {
        setPendingAction(null)
      }
    })
  }

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium text-charcoal">{t('image.label')}</p>

      {currentUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={currentUrl}
          alt={altText}
          className="w-full max-w-sm rounded-lg border border-line object-cover"
          data-testid="event-image-preview"
        />
      ) : (
        <p className="text-sm text-muted">{t('image.none')}</p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={isPending}
          className="px-3 py-2 text-sm border border-line rounded-sm hover:bg-cream-2 text-charcoal transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {pendingAction === 'upload'
            ? t('image.uploading')
            : currentUrl ? t('image.replace_button') : t('image.choose_button')}
        </button>
        {currentUrl && (
          <button
            type="button"
            onClick={handleRemove}
            disabled={isPending}
            className="text-sm text-[#A85959] hover:underline disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {pendingAction === 'remove' ? t('image.removing') : t('image.remove_button')}
          </button>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={handleChange}
          className="hidden"
          data-testid="event-image-input"
        />
      </div>

      <div className="space-y-0.5">
        <p className="text-xs text-muted">{t('image.help_public')}</p>
        <p className="text-xs text-muted">{t('image.help_consent')}</p>
      </div>

      {status && (
        <p
          className={`text-xs ${status.kind === 'error' ? 'text-[#A85959]' : 'text-green-700'}`}
          role={status.kind === 'error' ? 'alert' : 'status'}
        >
          {status.message}
        </p>
      )}
    </div>
  )
}
