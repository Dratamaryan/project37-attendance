'use client'

import { useState, useRef } from 'react'
import { useTranslations } from 'next-intl'

type Props = {
  previewUrl: string | null
  consent: boolean
  onFileSelect: (file: File, previewUrl: string) => void
  onClear: () => void
  onConsentChange: (consent: boolean) => void
}

const MAX_BYTES = 5 * 1024 * 1024
// Extension-based allowlist. Extension is the most reliable signal across
// browsers — iOS Safari sometimes reports HEIC as '' or 'image/heic'
// inconsistently; MIME type alone is not sufficient.
const HEIC_EXTS = new Set(['heic', 'heif'])
const ALLOWED_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp'])
const ACCEPTED_MIME = ['image/jpeg', 'image/png', 'image/webp']

export function PhotoUpload({ previewUrl, consent, onFileSelect, onClear, onConsentChange }: Props) {
  const t = useTranslations('checkin.form')
  const [fileError, setFileError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  function reject(msg: string) {
    setFileError(msg)
    if (inputRef.current) inputRef.current.value = ''
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setFileError(null)

    // Extension check first — most reliable across browsers and iOS versions.
    const ext = file.name.split('.').pop()?.toLowerCase() ?? ''

    if (HEIC_EXTS.has(ext)) {
      reject(t('photo_heic_warning'))
      return
    }

    // MIME-type HEIC check as a second layer for files with missing/no extension.
    // image/heic-sequence covers Live Photo bursts from iOS Camera.
    if (file.type === 'image/heic' || file.type === 'image/heif' || file.type === 'image/heic-sequence') {
      reject(t('photo_heic_warning'))
      return
    }

    if (!ALLOWED_EXTS.has(ext)) {
      reject(t('photo_invalid_type'))
      return
    }

    if (!ACCEPTED_MIME.includes(file.type)) {
      reject(t('photo_invalid_type'))
      return
    }

    if (file.size > MAX_BYTES) {
      reject(t('photo_too_large'))
      return
    }

    const objectUrl = URL.createObjectURL(file)
    onFileSelect(file, objectUrl)
  }

  function handleClear() {
    if (inputRef.current) inputRef.current.value = ''
    onClear()
    setFileError(null)
  }

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium text-charcoal">{t('photo_label')}</p>

      {previewUrl ? (
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={previewUrl}
            alt="Preview"
            className="w-16 h-16 rounded-full object-cover flex-shrink-0"
          />
          <button
            type="button"
            onClick={handleClear}
            className="text-sm text-[#A85959] hover:underline"
          >
            {t('photo_remove_button')}
          </button>
        </div>
      ) : (
        <div>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="px-3 py-2 text-sm border border-line rounded-sm hover:bg-cream-2 text-charcoal transition-colors"
          >
            {t('photo_upload_button')}
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
            onChange={handleChange}
            className="hidden"
            data-testid="photo-input"
          />
          <p className="text-xs text-muted mt-1.5">{t('photo_max_size')}</p>
        </div>
      )}

      {fileError && (
        <p className="text-xs text-[#A85959]" role="alert">
          {fileError}
        </p>
      )}

      <div className="flex items-start gap-2 pt-1">
        <input
          type="checkbox"
          id="photo-consent"
          checked={consent}
          onChange={(e) => onConsentChange(e.target.checked)}
          className="mt-0.5 h-4 w-4 flex-shrink-0 rounded border-line accent-charcoal"
        />
        <div>
          <label htmlFor="photo-consent" className="text-sm text-ink-2 cursor-pointer leading-snug">
            {t('consent_label')}
          </label>
          <p className="text-xs text-muted mt-0.5">{t('consent_help')}</p>
        </div>
      </div>
    </div>
  )
}
