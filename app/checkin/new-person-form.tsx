'use client'

import { useReducer, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { createPerson, updatePerson, lookupByPhone } from '@/lib/actions/people'
import { uploadPhoto } from '@/lib/storage/photos'
import { formatPhoneForDisplay } from '@/lib/utils/phone'
import { ParishAutocomplete } from './parish-autocomplete'
import { PhotoUpload } from './photo-upload'
import type { PersonSummary, SupportedCountry } from '@/lib/actions/people.types'

type Props = {
  normalizedE164: string
  country: SupportedCountry
  onSuccess: (person: PersonSummary) => void
  onUseExisting: (person: PersonSummary) => void
  onPhotoError: () => void
  onCancel: () => void
}

type FormState = {
  full_name: string
  nickname: string
  birth_date: string
  email: string
  birth_place: string
  gender: 'male' | 'female' | null
  marital_status: 'married' | 'single' | null
  origin_parish: string | null
  current_city: string
  current_area: string
  photoFile: File | null
  photoPreviewUrl: string | null
  consent: boolean
  fieldErrors: Record<string, string>
  submitError: string | null
  submitErrorType: 'duplicate_phone' | 'validation_error' | 'error' | 'photo_upload' | null
  duplicateExisting: { id: string; full_name: string } | null
  parishCreating: boolean
}

type FormAction =
  | { type: 'SET_TEXT_FIELD'; field: 'full_name' | 'nickname' | 'birth_date' | 'email' | 'birth_place' | 'current_city' | 'current_area'; value: string }
  | { type: 'SET_GENDER'; value: 'male' | 'female' | null }
  | { type: 'SET_MARITAL'; value: 'married' | 'single' | null }
  | { type: 'SET_PARISH'; value: string | null }
  | { type: 'SET_PARISH_CREATING'; value: boolean }
  | { type: 'SET_PHOTO'; file: File; previewUrl: string }
  | { type: 'CLEAR_PHOTO' }
  | { type: 'SET_CONSENT'; value: boolean }
  | { type: 'SET_FIELD_ERRORS'; errors: Record<string, string> }
  | { type: 'SET_SUBMIT_ERROR'; errorType: FormState['submitErrorType']; message: string; existing?: { id: string; full_name: string } }
  | { type: 'CLEAR_ERRORS' }
  | { type: 'RESET' }

const INITIAL_STATE: FormState = {
  full_name: '',
  nickname: '',
  birth_date: '',
  email: '',
  birth_place: '',
  gender: null,
  marital_status: null,
  origin_parish: null,
  current_city: '',
  current_area: '',
  photoFile: null,
  photoPreviewUrl: null,
  consent: false,
  fieldErrors: {},
  submitError: null,
  submitErrorType: null,
  duplicateExisting: null,
  parishCreating: false,
}

function reducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case 'SET_TEXT_FIELD':
      return {
        ...state,
        [action.field]: action.value,
        fieldErrors: { ...state.fieldErrors, [action.field]: '' },
      }
    case 'SET_GENDER':
      return { ...state, gender: action.value }
    case 'SET_MARITAL':
      return { ...state, marital_status: action.value }
    case 'SET_PARISH':
      return { ...state, origin_parish: action.value }
    case 'SET_PARISH_CREATING':
      return { ...state, parishCreating: action.value }
    case 'SET_PHOTO':
      if (state.photoPreviewUrl) URL.revokeObjectURL(state.photoPreviewUrl)
      return { ...state, photoFile: action.file, photoPreviewUrl: action.previewUrl }
    case 'CLEAR_PHOTO':
      if (state.photoPreviewUrl) URL.revokeObjectURL(state.photoPreviewUrl)
      return { ...state, photoFile: null, photoPreviewUrl: null }
    case 'SET_CONSENT':
      return { ...state, consent: action.value }
    case 'SET_FIELD_ERRORS':
      return { ...state, fieldErrors: action.errors }
    case 'SET_SUBMIT_ERROR':
      return {
        ...state,
        submitError: action.message,
        submitErrorType: action.errorType,
        duplicateExisting: action.existing ?? null,
      }
    case 'CLEAR_ERRORS':
      return { ...state, fieldErrors: {}, submitError: null, submitErrorType: null, duplicateExisting: null }
    case 'RESET': {
      if (state.photoPreviewUrl) URL.revokeObjectURL(state.photoPreviewUrl)
      return INITIAL_STATE
    }
  }
}

// Compare against INITIAL_STATE so browser autofill doesn't trigger the confirm dialog.
function hasChanges(state: FormState): boolean {
  return (
    state.full_name !== INITIAL_STATE.full_name ||
    state.nickname !== INITIAL_STATE.nickname ||
    state.birth_date !== INITIAL_STATE.birth_date ||
    state.email !== INITIAL_STATE.email ||
    state.birth_place !== INITIAL_STATE.birth_place ||
    state.gender !== INITIAL_STATE.gender ||
    state.marital_status !== INITIAL_STATE.marital_status ||
    state.origin_parish !== INITIAL_STATE.origin_parish ||
    state.current_city !== INITIAL_STATE.current_city ||
    state.current_area !== INITIAL_STATE.current_area ||
    state.photoFile !== INITIAL_STATE.photoFile
  )
}

function clientValidate(state: FormState): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!state.full_name.trim()) errors.full_name = 'required'
  if (!state.nickname.trim()) errors.nickname = 'required'
  if (!state.birth_date) errors.birth_date = 'required'
  if (state.birth_date) {
    const today = new Date().toISOString().split('T')[0]
    if (state.birth_date > today) errors.birth_date = 'future_date'
  }
  return errors
}

const FIELD_CLASSES =
  'w-full px-3 py-2 text-sm bg-white border rounded-sm focus:outline-none focus:border-charcoal placeholder:text-muted'
const FIELD_NORMAL = 'border-line'
const FIELD_ERROR = 'border-[#A85959] bg-[#FDF5F5]'

export function NewPersonForm({
  normalizedE164,
  country,
  onSuccess,
  onUseExisting,
  onPhotoError,
  onCancel,
}: Props) {
  const t = useTranslations('checkin.form')
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE)
  const [isPending, startTransition] = useTransition()

  const displayPhone = formatPhoneForDisplay(normalizedE164)

  function handleCancel() {
    if (hasChanges(state) && !window.confirm(t('discard_confirm'))) return
    dispatch({ type: 'RESET' })
    onCancel()
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const errors = clientValidate(state)
    if (Object.keys(errors).length > 0) {
      dispatch({ type: 'SET_FIELD_ERRORS', errors })
      dispatch({ type: 'SET_SUBMIT_ERROR', errorType: 'validation_error', message: '' })
      return
    }
    dispatch({ type: 'CLEAR_ERRORS' })

    startTransition(async () => {
      const createResult = await createPerson({
        phone_e164_raw: normalizedE164,
        country,
        full_name: state.full_name.trim(),
        nickname: state.nickname.trim(),
        birth_date: state.birth_date,
        email: state.email.trim() || null,
        birth_place: state.birth_place.trim() || null,
        gender: state.gender,
        marital_status: state.marital_status,
        origin_parish: state.origin_parish || null,
        current_city: state.current_city.trim() || null,
        current_area: state.current_area.trim() || null,
        photo_publish_consent: state.consent,
        photo_consent_at: state.consent ? new Date().toISOString() : null,
      })

      if (createResult.status === 'duplicate_phone') {
        dispatch({
          type: 'SET_SUBMIT_ERROR',
          errorType: 'duplicate_phone',
          message: '',
          existing: createResult.existing,
        })
        return
      }

      if (createResult.status === 'validation_error') {
        dispatch({ type: 'SET_FIELD_ERRORS', errors: createResult.field_errors })
        dispatch({ type: 'SET_SUBMIT_ERROR', errorType: 'validation_error', message: '' })
        return
      }

      if (createResult.status === 'error') {
        console.error('[new-person-form] createPerson error:', createResult.message)
        dispatch({
          type: 'SET_SUBMIT_ERROR',
          errorType: 'error',
          message: createResult.message,
        })
        return
      }

      // status === 'created'
      const person = createResult.person

      if (state.photoFile) {
        // try/catch is required: uploadPhoto may throw (not return a discriminated
        // union) if Next.js rejects the request body before the action runs
        // (e.g. body size limit exceeded) or if a network/RSC error occurs.
        // Photo failure must NEVER crash the page or block adding to the recent panel.
        let photoFailed = false
        try {
          const uploadResult = await uploadPhoto({
            personId: person.id,
            file: state.photoFile,
            consent: state.consent,
          })
          if (uploadResult.status === 'uploaded') {
            await updatePerson(person.id, { photo_url: uploadResult.path })
          } else {
            console.warn('[checkin] photo upload non-success:', uploadResult.status)
            photoFailed = true
          }
        } catch (err) {
          console.error('[checkin] photo upload threw:', err)
          photoFailed = true
        }

        if (photoFailed) {
          dispatch({ type: 'SET_SUBMIT_ERROR', errorType: 'photo_upload', message: '' })
          onPhotoError()
          onSuccess(person)
          return
        }
      }

      dispatch({ type: 'RESET' })
      onSuccess(person)
    })
  }

  async function handleUseExisting() {
    if (!state.duplicateExisting) return
    const result = await lookupByPhone(normalizedE164, country)
    if (result.status === 'found') {
      dispatch({ type: 'RESET' })
      onUseExisting(result.person)
    }
  }

  const fieldClass = (field: string) =>
    `${FIELD_CLASSES} ${state.fieldErrors[field] ? FIELD_ERROR : FIELD_NORMAL}`

  return (
    <div className="mt-4 bg-cream-2 border border-[#D9D1BD] rounded-[4px] animate-[slideDown_0.3s_ease-out]">
      {/* Header */}
      <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-line">
        <p className="font-heading text-lg font-semibold text-charcoal">{t('title')}</p>
        <button
          type="button"
          onClick={handleCancel}
          className="text-sm text-muted hover:text-charcoal transition-colors"
        >
          {t('cancel_button')}
        </button>
      </div>

      <form onSubmit={handleSubmit} noValidate>
        <div className="px-5 py-4 space-y-5">
          {/* Phone display (read-only) */}
          <div className="flex items-center gap-3 text-sm">
            <span className="font-medium text-charcoal">{displayPhone}</span>
            <button
              type="button"
              onClick={handleCancel}
              className="text-muted hover:text-charcoal transition-colors underline underline-offset-2"
            >
              {t('change_phone')}
            </button>
          </div>

          {/* Global error banner */}
          {state.submitErrorType === 'error' && (
            <div role="alert" className="text-sm text-[#A85959] bg-[#FDF5F5] border border-[#F5D5D5] rounded-sm px-3 py-2">
              {t('error_generic')}
            </div>
          )}
          {state.submitErrorType === 'validation_error' && Object.keys(state.fieldErrors).length > 0 && (
            <div role="alert" className="text-sm text-[#A85959] bg-[#FDF5F5] border border-[#F5D5D5] rounded-sm px-3 py-2">
              {t('error_validation')}
            </div>
          )}
          {state.submitErrorType === 'photo_upload' && (
            <div role="alert" className="text-sm text-[#8B7635] bg-[#FBF6E8] border border-[#F5EFD9] rounded-sm px-3 py-2">
              {t('error_photo_upload')}
            </div>
          )}
          {state.submitErrorType === 'duplicate_phone' && state.duplicateExisting && (
            <div role="alert" className="text-sm bg-[#FDF5F5] border border-[#F5D5D5] rounded-sm px-3 py-2 space-y-2">
              <p className="text-[#A85959]">
                {t('error_duplicate_phone', { name: state.duplicateExisting.full_name })}
              </p>
              <button
                type="button"
                onClick={handleUseExisting}
                className="text-charcoal underline underline-offset-2 font-medium hover:text-ink-2"
              >
                {t('use_existing_button')}
              </button>
            </div>
          )}

          {/* Required fields — two-column on sm+ */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-charcoal mb-1">
                {t('full_name_label')}
                <span className="text-[#A85959] ml-0.5">*</span>
              </label>
              <input
                type="text"
                value={state.full_name}
                onChange={(e) => dispatch({ type: 'SET_TEXT_FIELD', field: 'full_name', value: e.target.value })}
                placeholder={t('full_name_placeholder')}
                autoComplete="name"
                className={fieldClass('full_name')}
                aria-label={t('full_name_label')}
                aria-required="true"
                aria-invalid={!!state.fieldErrors.full_name}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-charcoal mb-1">
                {t('nickname_label')}
                <span className="text-[#A85959] ml-0.5">*</span>
              </label>
              <input
                type="text"
                value={state.nickname}
                onChange={(e) => dispatch({ type: 'SET_TEXT_FIELD', field: 'nickname', value: e.target.value })}
                placeholder={t('nickname_placeholder')}
                autoComplete="nickname"
                className={fieldClass('nickname')}
                aria-label={t('nickname_label')}
                aria-required="true"
                aria-invalid={!!state.fieldErrors.nickname}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-charcoal mb-1">
                {t('birth_date_label')}
                <span className="text-[#A85959] ml-0.5">*</span>
              </label>
              <input
                type="date"
                value={state.birth_date}
                onChange={(e) => dispatch({ type: 'SET_TEXT_FIELD', field: 'birth_date', value: e.target.value })}
                min="1900-01-01"
                max={new Date().toISOString().split('T')[0]}
                className={fieldClass('birth_date')}
                aria-label={t('birth_date_label')}
                aria-required="true"
                aria-invalid={!!state.fieldErrors.birth_date}
              />
            </div>
          </div>

          {/* Optional fields */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-charcoal mb-1">
                {t('email_label')}
              </label>
              <input
                type="email"
                value={state.email}
                onChange={(e) => dispatch({ type: 'SET_TEXT_FIELD', field: 'email', value: e.target.value })}
                placeholder={t('email_placeholder')}
                autoComplete="email"
                className={fieldClass('email')}
                aria-label={t('email_label')}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-charcoal mb-1">
                {t('birth_place_label')}
              </label>
              <input
                type="text"
                value={state.birth_place}
                onChange={(e) => dispatch({ type: 'SET_TEXT_FIELD', field: 'birth_place', value: e.target.value })}
                className={`${FIELD_CLASSES} ${FIELD_NORMAL}`}
                aria-label={t('birth_place_label')}
              />
            </div>

            {/* Gender — full row on mobile, col on tablet */}
            <div className="sm:col-span-1">
              <p className="text-xs font-medium text-charcoal mb-2">{t('gender_label')}</p>
              <div className="flex flex-wrap gap-3">
                {(['male', 'female', null] as const).map((val) => {
                  const label =
                    val === 'male' ? t('gender_male') :
                    val === 'female' ? t('gender_female') :
                    t('gender_unspecified')
                  const id = `gender-${val ?? 'null'}`
                  return (
                    <label key={id} className="flex items-center gap-1.5 text-sm text-ink-2 cursor-pointer">
                      <input
                        type="radio"
                        name="gender"
                        id={id}
                        checked={state.gender === val}
                        onChange={() => dispatch({ type: 'SET_GENDER', value: val })}
                        className="accent-charcoal"
                      />
                      {label}
                    </label>
                  )
                })}
              </div>
            </div>

            {/* Marital status */}
            <div className="sm:col-span-1">
              <p className="text-xs font-medium text-charcoal mb-2">{t('marital_status_label')}</p>
              <div className="flex flex-wrap gap-3">
                {(['single', 'married', null] as const).map((val) => {
                  const label =
                    val === 'single' ? t('marital_single') :
                    val === 'married' ? t('marital_married') :
                    '—'
                  const id = `marital-${val ?? 'null'}`
                  return (
                    <label key={id} className="flex items-center gap-1.5 text-sm text-ink-2 cursor-pointer">
                      <input
                        type="radio"
                        name="marital_status"
                        id={id}
                        checked={state.marital_status === val}
                        onChange={() => dispatch({ type: 'SET_MARITAL', value: val })}
                        className="accent-charcoal"
                      />
                      {label}
                    </label>
                  )
                })}
              </div>
            </div>

            {/* Parish — full width */}
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-charcoal mb-1">
                {t('origin_parish_label')}
              </label>
              <ParishAutocomplete
                value={state.origin_parish}
                onChange={(val) => dispatch({ type: 'SET_PARISH', value: val })}
                onCreatingChange={(creating) => dispatch({ type: 'SET_PARISH_CREATING', value: creating })}
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-charcoal mb-1">
                {t('current_city_label')}
              </label>
              <input
                type="text"
                value={state.current_city}
                onChange={(e) => dispatch({ type: 'SET_TEXT_FIELD', field: 'current_city', value: e.target.value })}
                className={`${FIELD_CLASSES} ${FIELD_NORMAL}`}
                aria-label={t('current_city_label')}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-charcoal mb-1">
                {t('current_area_label')}
              </label>
              <input
                type="text"
                value={state.current_area}
                onChange={(e) => dispatch({ type: 'SET_TEXT_FIELD', field: 'current_area', value: e.target.value })}
                className={`${FIELD_CLASSES} ${FIELD_NORMAL}`}
                aria-label={t('current_area_label')}
              />
            </div>
          </div>

          {/* Photo + consent */}
          <div className="pt-1 border-t border-line">
            <PhotoUpload
              previewUrl={state.photoPreviewUrl}
              consent={state.consent}
              onFileSelect={(file, url) => dispatch({ type: 'SET_PHOTO', file, previewUrl: url })}
              onClear={() => dispatch({ type: 'CLEAR_PHOTO' })}
              onConsentChange={(val) => dispatch({ type: 'SET_CONSENT', value: val })}
            />
          </div>
        </div>

        {/* Sticky action row */}
        <div className="sticky bottom-0 px-5 py-4 bg-cream-2 border-t border-line flex flex-col sm:flex-row gap-3">
          <button
            type="submit"
            disabled={isPending || state.parishCreating}
            className="flex-1 py-3 bg-charcoal text-cream text-sm font-medium rounded-sm hover:bg-ink-2 active:translate-y-px transition-all min-h-[44px] disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {isPending ? t('submit_button_pending') : t('submit_button')}
          </button>
          <button
            type="button"
            onClick={handleCancel}
            disabled={isPending}
            className="sm:w-auto w-full py-3 px-5 border border-line text-sm text-charcoal rounded-sm hover:bg-white transition-colors min-h-[44px] disabled:opacity-60"
          >
            {t('cancel_button')}
          </button>
        </div>
      </form>
    </div>
  )
}
