'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { createChild } from '@/lib/actions/children'
import type { ChildSummary } from '@/lib/actions/children.types'
import type { PersonSummary } from '@/lib/actions/people.types'

type Props = {
  /** The resolved parent (parentForChild) — the only source of parent_person_id. */
  parent: Pick<PersonSummary, 'id' | 'full_name'>
  /**
   * Called on 'created' AND 'duplicate_warning' — the row exists in both cases.
   * `existing` is the pre-existing same-name siblings (empty when none).
   */
  onCreated: (child: ChildSummary, existing: ChildSummary[]) => void
  onCancel: () => void
}

type BannerError = 'parent_not_found' | 'forbidden' | 'error' | 'validation' | null

const FIELD_CLASSES =
  'w-full px-3 py-2 text-sm bg-white border rounded-sm focus:outline-none focus:border-charcoal placeholder:text-muted'
const FIELD_NORMAL = 'border-line'
const FIELD_ERROR = 'border-[#A85959] bg-[#FDF5F5]'

/**
 * S8-T4b: organizer "add child" on the check-in floor. CREATE-ONLY — no edit or
 * delete here (admin-only). Deliberately minimal: name, birth date, gender; no
 * notes field on the floor.
 *
 * Creating is NOT checking in: success only hands the new child back to the
 * parent, which renders the ChildCard confirm step. That card's button remains
 * the only child_attendance write.
 *
 * The birth-date input has no `max`: the server validates against today in
 * Asia/Jakarta, and computing it here via toISOString() would be the UTC date.
 */
export function NewChildForm({ parent, onCreated, onCancel }: Props) {
  const t = useTranslations('checkin')
  const [fullName, setFullName] = useState('')
  const [birthDate, setBirthDate] = useState('')
  const [gender, setGender] = useState<'male' | 'female' | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, boolean>>({})
  const [banner, setBanner] = useState<BannerError>(null)
  const [isPending, startTransition] = useTransition()

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (isPending) return
    if (!fullName.trim()) {
      setFieldErrors({ full_name: true })
      setBanner('validation')
      return
    }
    setFieldErrors({})
    setBanner(null)

    startTransition(async () => {
      const result = await createChild({
        parentPersonId: parent.id,
        full_name:      fullName,
        birth_date:     birthDate || null,
        gender,
      })
      switch (result.status) {
        case 'created':
          onCreated(result.child, [])
          break
        case 'duplicate_warning':
          onCreated(result.child, result.existing)
          break
        case 'validation_error':
          setFieldErrors(Object.fromEntries(Object.keys(result.field_errors).map((k) => [k, true])))
          setBanner('validation')
          break
        case 'parent_not_found':
          setBanner('parent_not_found')
          break
        case 'forbidden':
          console.error('[new-child-form] createChild forbidden:', result.message)
          setBanner('forbidden')
          break
        case 'error':
          console.error('[new-child-form] createChild failed:', result.message)
          setBanner('error')
          break
      }
    })
  }

  const fieldClass = (field: string) =>
    `${FIELD_CLASSES} ${fieldErrors[field] ? FIELD_ERROR : FIELD_NORMAL}`

  return (
    <div
      data-testid="new-child-form"
      className="mt-4 bg-cream-2 border border-[#D9D1BD] rounded-[4px] animate-[slideDown_0.3s_ease-out]"
    >
      <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-line">
        <div className="min-w-0">
          <p className="font-heading text-lg font-semibold text-charcoal">{t('child.add.title')}</p>
          <p className="text-sm text-ink-2 mt-0.5">{t('child.add.parent_label', { name: parent.full_name })}</p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          disabled={isPending}
          className="text-sm text-muted hover:text-charcoal transition-colors min-h-[44px] disabled:opacity-60"
        >
          {t('child.add.cancel_button')}
        </button>
      </div>

      <form onSubmit={handleSubmit} noValidate>
        <div className="px-5 py-4 space-y-5">
          {banner && (
            <div
              role="alert"
              className="text-sm text-[#A85959] bg-[#FDF5F5] border border-[#F5D5D5] rounded-sm px-3 py-2"
            >
              {t(`child.add.error.${banner}`)}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="new-child-full-name" className="block text-xs font-medium text-charcoal mb-1">
                {t('child.add.full_name_label')}
                <span className="text-[#A85959] ml-0.5">*</span>
              </label>
              <input
                id="new-child-full-name"
                type="text"
                value={fullName}
                onChange={(e) => {
                  setFullName(e.target.value)
                  setFieldErrors((fe) => ({ ...fe, full_name: false }))
                }}
                placeholder={t('child.add.full_name_placeholder')}
                autoComplete="off"
                className={fieldClass('full_name')}
                aria-required="true"
                aria-invalid={!!fieldErrors.full_name}
              />
              {fieldErrors.full_name && (
                <p className="text-xs text-[#A85959] mt-1">{t('child.add.field_error.full_name')}</p>
              )}
            </div>
            {/* min-w-0: WebKit's native date control has a larger min-content
                floor (same fix as NewPersonForm). */}
            <div className="min-w-0">
              <label htmlFor="new-child-birth-date" className="block text-xs font-medium text-charcoal mb-1">
                {t('child.add.birth_date_label')}
              </label>
              <input
                id="new-child-birth-date"
                type="date"
                value={birthDate}
                onChange={(e) => setBirthDate(e.target.value)}
                min="1900-01-01"
                className={`${fieldClass('birth_date')} min-h-[44px]`}
                aria-invalid={!!fieldErrors.birth_date}
              />
              {fieldErrors.birth_date && (
                <p className="text-xs text-[#A85959] mt-1">{t('child.add.field_error.birth_date')}</p>
              )}
            </div>
          </div>

          <fieldset>
            <legend className="text-xs font-medium text-charcoal mb-2">{t('child.add.gender_label')}</legend>
            <div className="flex flex-wrap gap-3">
              {(['male', 'female', null] as const).map((val) => {
                const id = `new-child-gender-${val ?? 'null'}`
                return (
                  <label key={id} htmlFor={id} className="flex items-center gap-1.5 text-sm text-ink-2 cursor-pointer min-h-[44px]">
                    <input
                      type="radio"
                      name="new-child-gender"
                      id={id}
                      checked={gender === val}
                      onChange={() => setGender(val)}
                      className="accent-charcoal"
                    />
                    {t(`child.add.gender_${val ?? 'unspecified'}`)}
                  </label>
                )
              })}
            </div>
          </fieldset>
        </div>

        <div className="px-5 py-4 border-t border-line flex flex-col sm:flex-row gap-3">
          <button
            type="submit"
            disabled={isPending}
            className="flex-1 py-3 bg-charcoal text-cream text-sm font-medium rounded-sm hover:bg-ink-2 active:translate-y-px transition-all min-h-[44px] disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {isPending ? t('child.add.submit_button_pending') : t('child.add.submit_button')}
          </button>
        </div>
      </form>
    </div>
  )
}
