'use client'

import { useReducer, useTransition, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import { useTranslations } from 'next-intl'
import { updatePerson, softDeletePerson, restorePerson, setPhotoConsent } from '@/lib/actions/people'
import { uploadPhoto, deletePhoto } from '@/lib/storage/photos'
import { ParishAutocomplete } from '@/app/checkin/parish-autocomplete'
import { formatPhoneForDisplay } from '@/lib/utils/phone'
import type { PersonFull } from '@/lib/actions/people.types'

// ── Types ─────────────────────────────────────────────────────────────────────

type Props = {
  person: PersonFull
  signedPhotoUrl: string | null
}

type TextField =
  | 'full_name' | 'nickname' | 'email' | 'birth_place' | 'birth_date'
  | 'current_city' | 'current_area' | 'kepanitiaan' | 'tribe' | 'notes'

type EditFormState = {
  full_name: string
  nickname: string
  email: string
  birth_place: string
  birth_date: string
  current_city: string
  current_area: string
  kepanitiaan: string
  tribe: string
  notes: string
  gender: 'male' | 'female' | null
  marital_status: 'married' | 'single' | null
  origin_parish: string | null
  // photo
  photoFile: File | null
  photoPreviewUrl: string | null
  removePhoto: boolean
  photo_url: string | null
  // consent (read-only in reducer — toggled via direct API call)
  photo_publish_consent: boolean
  photo_consent_at: string | null
  photo_consent_version: string | null
  // form state
  fieldErrors: Record<string, string>
  submitError: string | null
  // last_updated display
  updated_at: string
  // baseline for dirty detection — updated on SAVE_SUCCEEDED
  _baseline: Baseline
}

type EditFormAction =
  | { type: 'SET_TEXT'; field: TextField; value: string }
  | { type: 'SET_GENDER'; value: 'male' | 'female' | null }
  | { type: 'SET_MARITAL'; value: 'married' | 'single' | null }
  | { type: 'SET_PARISH'; value: string | null }
  | { type: 'STAGE_PHOTO'; file: File; previewUrl: string }
  | { type: 'CANCEL_STAGED_PHOTO' }
  | { type: 'MARK_REMOVE_PHOTO' }
  | { type: 'SET_FIELD_ERRORS'; errors: Record<string, string> }
  | { type: 'SET_SUBMIT_ERROR'; message: string }
  | { type: 'CLEAR_ERRORS' }
  | { type: 'CONSENT_UPDATED'; consent: boolean; consent_at: string | null; consent_version: string | null }
  | { type: 'REVERT_CONSENT'; prev_consent: boolean }
  | { type: 'SAVE_SUCCEEDED'; updated_at: string; new_photo_url?: string | null; photo_removed?: boolean; new_baseline: Baseline }

// ── Baseline helpers ──────────────────────────────────────────────────────────
// The baseline lives inside reducer state (not a useRef) to avoid reading a ref
// during render, which triggers the react-hooks/refs lint rule.

type Baseline = {
  full_name: string; nickname: string; email: string
  birth_place: string; birth_date: string
  current_city: string; current_area: string
  kepanitiaan: string; tribe: string; notes: string
  gender: 'male' | 'female' | null
  marital_status: 'married' | 'single' | null
  origin_parish: string | null
}

function buildBaseline(s: Pick<EditFormState, keyof Baseline>): Baseline {
  return {
    full_name: s.full_name, nickname: s.nickname, email: s.email,
    birth_place: s.birth_place, birth_date: s.birth_date,
    current_city: s.current_city, current_area: s.current_area,
    kepanitiaan: s.kepanitiaan, tribe: s.tribe, notes: s.notes,
    gender: s.gender, marital_status: s.marital_status, origin_parish: s.origin_parish,
  }
}

function hasChanges(state: EditFormState): boolean {
  if (state.photoFile !== null || state.removePhoto) return true
  const b = state._baseline
  const keys = Object.keys(b) as (keyof Baseline)[]
  return keys.some(k => state[k] !== b[k])
}

// ── Initial state ─────────────────────────────────────────────────────────────

function buildInitialState(person: PersonFull): EditFormState {
  const base = {
    full_name:      person.full_name,
    nickname:       person.nickname,
    email:          person.email ?? '',
    birth_place:    person.birth_place ?? '',
    birth_date:     person.birth_date ?? '',
    current_city:   person.current_city ?? '',
    current_area:   person.current_area ?? '',
    kepanitiaan:    person.kepanitiaan ?? '',
    tribe:          person.tribe ?? '',
    notes:          person.notes ?? '',
    gender:         person.gender,
    marital_status: person.marital_status,
    origin_parish:  person.origin_parish,
  }
  return {
    ...base,
    photoFile:             null,
    photoPreviewUrl:       null,
    removePhoto:           false,
    photo_url:             person.photo_url,
    photo_publish_consent: person.photo_publish_consent,
    photo_consent_at:      person.photo_consent_at,
    photo_consent_version: person.photo_consent_version,
    fieldErrors:           {},
    submitError:           null,
    updated_at:            person.updated_at,
    _baseline:             buildBaseline(base),
  }
}

// ── Reducer ───────────────────────────────────────────────────────────────────

function reducer(state: EditFormState, action: EditFormAction): EditFormState {
  switch (action.type) {
    case 'SET_TEXT':
      return { ...state, [action.field]: action.value, fieldErrors: { ...state.fieldErrors, [action.field]: '' } }
    case 'SET_GENDER':
      return { ...state, gender: action.value }
    case 'SET_MARITAL':
      return { ...state, marital_status: action.value }
    case 'SET_PARISH':
      return { ...state, origin_parish: action.value }
    case 'STAGE_PHOTO': {
      if (state.photoPreviewUrl) URL.revokeObjectURL(state.photoPreviewUrl)
      return { ...state, photoFile: action.file, photoPreviewUrl: action.previewUrl, removePhoto: false }
    }
    case 'CANCEL_STAGED_PHOTO': {
      if (state.photoPreviewUrl) URL.revokeObjectURL(state.photoPreviewUrl)
      return { ...state, photoFile: null, photoPreviewUrl: null }
    }
    case 'MARK_REMOVE_PHOTO': {
      if (state.photoPreviewUrl) URL.revokeObjectURL(state.photoPreviewUrl)
      return { ...state, photoFile: null, photoPreviewUrl: null, removePhoto: true }
    }
    case 'SET_FIELD_ERRORS':
      return { ...state, fieldErrors: action.errors }
    case 'SET_SUBMIT_ERROR':
      return { ...state, submitError: action.message }
    case 'CLEAR_ERRORS':
      return { ...state, fieldErrors: {}, submitError: null }
    case 'CONSENT_UPDATED':
      return {
        ...state,
        photo_publish_consent: action.consent,
        photo_consent_at:      action.consent_at,
        photo_consent_version: action.consent_version,
      }
    case 'REVERT_CONSENT':
      return { ...state, photo_publish_consent: action.prev_consent }
    case 'SAVE_SUCCEEDED': {
      const nextPhotoUrl = action.photo_removed
        ? null
        : action.new_photo_url !== undefined
          ? action.new_photo_url
          : state.photo_url
      return {
        ...state,
        removePhoto:     false,
        photoFile:       null,
        photoPreviewUrl: null,
        photo_url:       nextPhotoUrl,
        fieldErrors:     {},
        submitError:     null,
        updated_at:      action.updated_at,
        _baseline:       action.new_baseline,
      }
    }
  }
}

// ── File validation constants (verbatim from app/checkin/photo-upload.tsx) ───
// Sprint 5: extract shared validator into a lib/utils/photo-validation.ts module
// and remove this duplication. Both this section and PhotoUpload implement the
// same HEIC/extension/size checks — keep them in sync until then.
const MAX_BYTES = 5 * 1024 * 1024
const HEIC_EXTS = new Set(['heic', 'heif'])
const ALLOWED_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp'])
const ACCEPTED_MIME = ['image/jpeg', 'image/png', 'image/webp']

// ── Helpers ───────────────────────────────────────────────────────────────────

const AVATAR_COLORS = [
  'bg-amber-200 text-amber-800', 'bg-blue-200 text-blue-800',
  'bg-green-200 text-green-800', 'bg-rose-200 text-rose-800',
  'bg-purple-200 text-purple-800', 'bg-teal-200 text-teal-800',
  'bg-orange-200 text-orange-800', 'bg-indigo-200 text-indigo-800',
]
function colorForName(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}
function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) return (parts[0][0] ?? '?').toUpperCase()
  return ((parts[0][0] ?? '') + (parts[parts.length - 1][0] ?? '')).toUpperCase()
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

const FIELD_BASE = 'w-full px-3 py-2 text-sm bg-white border rounded-sm focus:outline-none focus:border-charcoal placeholder:text-muted transition-colors'
const FIELD_NORMAL = 'border-line'
const FIELD_ERROR = 'border-[#A85959] bg-[#FDF5F5]'
const FIELD_READONLY = 'border-line bg-cream-2 text-muted cursor-not-allowed'

// ── Component ─────────────────────────────────────────────────────────────────

export function EditPersonForm({ person, signedPhotoUrl }: Props) {
  const t = useTranslations('admin.people.edit')
  const router = useRouter()
  const [state, dispatch] = useReducer(reducer, buildInitialState(person))
  const [isPending, startTransition] = useTransition()
  const [isConsentPending, startConsentTransition] = useTransition()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null)

  const isDeleted = person.deleted_at !== null
  const dirty = hasChanges(state)

  // safeDispatch: no-ops for a deleted person — enforces read-only at dispatch level,
  // making DevTools bypass ineffective.
  const safeDispatch: typeof dispatch = (action) => {
    if (isDeleted) return
    dispatch(action)
  }

  function showToast(message: string, type: 'success' | 'error' = 'success') {
    setToast({ message, type })
    setTimeout(() => setToast(null), 3500)
  }

  function handleCancel() {
    if (dirty && !window.confirm(t('unsaved_changes'))) return
    router.push('/admin/people')
  }

  // ── File validation ────────────────────────────────────────────────────────

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setFileError(null)

    // Extension-first check — most reliable across browsers and iOS versions.
    // Must match accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
    // on the input element. See T1-14 hotfix: accept attr must include HEIC/HEIF
    // so Safari delivers the raw HEIC file instead of auto-converting to JPEG.
    const ext = file.name.split('.').pop()?.toLowerCase() ?? ''

    if (HEIC_EXTS.has(ext)) {
      setFileError('iPhone HEIC photos aren\'t supported yet. Switch to JPEG in Camera settings.')
      if (fileInputRef.current) fileInputRef.current.value = ''
      return
    }
    if (file.type === 'image/heic' || file.type === 'image/heif' || file.type === 'image/heic-sequence') {
      setFileError('iPhone HEIC photos aren\'t supported yet. Switch to JPEG in Camera settings.')
      if (fileInputRef.current) fileInputRef.current.value = ''
      return
    }
    if (!ALLOWED_EXTS.has(ext)) {
      setFileError('Photo format not supported')
      if (fileInputRef.current) fileInputRef.current.value = ''
      return
    }
    if (!ACCEPTED_MIME.includes(file.type)) {
      setFileError('Photo format not supported')
      if (fileInputRef.current) fileInputRef.current.value = ''
      return
    }
    if (file.size > MAX_BYTES) {
      setFileError('Photo is too large (max 5MB)')
      if (fileInputRef.current) fileInputRef.current.value = ''
      return
    }

    const previewUrl = URL.createObjectURL(file)
    safeDispatch({ type: 'STAGE_PHOTO', file, previewUrl })
  }

  function handleRemovePhotoClick() {
    if (!window.confirm(t('photo.remove_confirm'))) return
    safeDispatch({ type: 'MARK_REMOVE_PHOTO' })
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  // ── Consent toggle (immediate API call, not via Save) ─────────────────────

  function handleConsentToggle() {
    if (isDeleted) return
    const newConsent = !state.photo_publish_consent
    const prevConsent = state.photo_publish_consent
    dispatch({ type: 'CONSENT_UPDATED', consent: newConsent, consent_at: newConsent ? new Date().toISOString() : null, consent_version: state.photo_consent_version })

    startConsentTransition(async () => {
      const result = await setPhotoConsent(person.id, newConsent)
      if (result.status === 'updated') {
        dispatch({
          type: 'CONSENT_UPDATED',
          consent:          result.person.photo_publish_consent,
          consent_at:       null,
          consent_version:  state.photo_consent_version,
        })
        showToast(newConsent ? t('success.consent_granted') : t('success.consent_revoked'))
      } else {
        dispatch({ type: 'REVERT_CONSENT', prev_consent: prevConsent })
        showToast(t('error.save_failed'), 'error')
      }
    })
  }

  // ── Save ───────────────────────────────────────────────────────────────────

  function handleSave() {
    if (isDeleted || !dirty) return
    dispatch({ type: 'CLEAR_ERRORS' })

    startTransition(async () => {
      // Build diff: only fields that changed vs saved baseline
      const baseline = state._baseline
      const diff: Parameters<typeof updatePerson>[1] = {}

      if (state.full_name !== baseline.full_name)           diff.full_name       = state.full_name.trim()
      if (state.nickname !== baseline.nickname)             diff.nickname        = state.nickname.trim()
      if (state.email !== baseline.email)                   diff.email           = state.email.trim() || null
      if (state.birth_place !== baseline.birth_place)       diff.birth_place     = state.birth_place.trim() || null
      if (state.birth_date !== baseline.birth_date)         diff.birth_date      = state.birth_date || null
      if (state.gender !== baseline.gender)                 diff.gender          = state.gender
      if (state.marital_status !== baseline.marital_status) diff.marital_status  = state.marital_status
      if (state.origin_parish !== baseline.origin_parish)   diff.origin_parish   = state.origin_parish
      if (state.current_city !== baseline.current_city)     diff.current_city    = state.current_city.trim() || null
      if (state.current_area !== baseline.current_area)     diff.current_area    = state.current_area.trim() || null
      if (state.kepanitiaan !== baseline.kepanitiaan)       diff.kepanitiaan     = state.kepanitiaan.trim() || null
      if (state.tribe !== baseline.tribe)                   diff.tribe           = state.tribe.trim() || null
      if (state.notes !== baseline.notes)                   diff.notes           = state.notes.trim() || null

      let newPhotoPath: string | null | undefined = undefined
      let photoRemoved = false

      // Photo upload: stage → upload → include path in diff
      if (state.photoFile) {
        const uploadResult = await uploadPhoto({ personId: person.id, file: state.photoFile, consent: state.photo_publish_consent })
        if (uploadResult.status === 'uploaded') {
          newPhotoPath = uploadResult.path
          diff.photo_url = newPhotoPath
        } else {
          showToast(t('error.photo_failed'), 'error')
          return
        }
      }

      // Photo removal: clear photo_url in diff
      if (state.removePhoto) {
        diff.photo_url = null
        photoRemoved = true
      }

      // If there are no field changes and no photo changes, nothing to save
      const hasDiff = Object.keys(diff).length > 0
      if (!hasDiff) {
        showToast(t('success.saved'))
        return
      }

      const result = await updatePerson(person.id, diff)

      if (result.status === 'updated') {
        // Old photo cleanup (best-effort — storage orphan is acceptable if this fails)
        const oldPhotoUrl = state.photo_url
        if (oldPhotoUrl && !oldPhotoUrl.startsWith('https://') && (newPhotoPath || photoRemoved)) {
          deletePhoto(oldPhotoUrl).catch(err =>
            console.warn('[edit-person-form] old photo cleanup failed:', err)
          )
        }
        // If consent was truthy and photo was removed, revoke consent
        if (photoRemoved && state.photo_publish_consent) {
          setPhotoConsent(person.id, false).catch(err =>
            console.warn('[edit-person-form] consent revoke after photo remove failed:', err)
          )
          dispatch({ type: 'CONSENT_UPDATED', consent: false, consent_at: null, consent_version: null })
        }

        dispatch({
          type:         'SAVE_SUCCEEDED',
          updated_at:   new Date().toISOString(),
          new_photo_url: newPhotoPath,
          photo_removed: photoRemoved,
          new_baseline:  buildBaseline(state),
        })
        showToast(photoRemoved ? t('success.photo_removed') : newPhotoPath ? t('success.photo_replaced') : t('success.saved'))

      } else if (result.status === 'validation_error') {
        dispatch({ type: 'SET_FIELD_ERRORS', errors: result.field_errors })
        // Orphan cleanup: if photo was uploaded but save failed
        if (newPhotoPath) {
          deletePhoto(newPhotoPath).catch(err =>
            console.warn('[edit-person-form] new photo orphan cleanup failed:', err)
          )
        }

      } else if (result.status === 'not_found') {
        router.push('/admin/people')

      } else {
        dispatch({ type: 'SET_SUBMIT_ERROR', message: t('error.save_failed') })
        // Orphan cleanup
        if (newPhotoPath) {
          deletePhoto(newPhotoPath).catch(err =>
            console.warn('[edit-person-form] new photo orphan cleanup failed:', err)
          )
        }
      }
    })
  }

  // ── Soft-delete ────────────────────────────────────────────────────────────

  function handleDeleteConfirm() {
    setShowDeleteConfirm(false)
    startTransition(async () => {
      const result = await softDeletePerson(person.id)
      if (result.status === 'deleted') {
        router.push('/admin/people')
      } else {
        showToast(t('error.delete_failed'), 'error')
      }
    })
  }

  // ── Restore ────────────────────────────────────────────────────────────────

  function handleRestore() {
    startTransition(async () => {
      const result = await restorePerson(person.id)
      if (result.status === 'restored') {
        showToast(t('success.restored'))
        router.refresh()
      } else {
        showToast(t('error.restore_failed'), 'error')
      }
    })
  }

  // ── Field class helper ─────────────────────────────────────────────────────

  const fieldClass = (field: string) => {
    if (isDeleted) return `${FIELD_BASE} ${FIELD_READONLY}`
    return `${FIELD_BASE} ${state.fieldErrors[field] ? FIELD_ERROR : FIELD_NORMAL}`
  }

  // ── Photo display (current saved photo or staged preview) ─────────────────

  const displayPhotoUrl = state.removePhoto ? null : (state.photoPreviewUrl ?? signedPhotoUrl)

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="pb-24 md:pb-0">
      {/* Toast */}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-lg shadow-lg text-sm font-medium transition-all ${
            toast.type === 'error'
              ? 'bg-[#A85959] text-white'
              : 'bg-charcoal text-cream'
          }`}
        >
          {toast.message}
        </div>
      )}

      {/* Deleted banner */}
      {isDeleted && person.deleted_at && (
        <div className="mb-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 bg-[#FDF5F5] border border-[#F5D5D5] rounded-lg px-4 py-3">
          <p className="text-sm text-[#A85959]">
            {t('deleted_banner', { date: formatDate(person.deleted_at) })}
          </p>
          <button
            type="button"
            onClick={handleRestore}
            disabled={isPending}
            className="shrink-0 px-4 py-2 bg-charcoal text-cream text-sm font-medium rounded-sm hover:bg-ink-2 transition-colors disabled:opacity-60 min-h-[36px]"
          >
            {t('restore_button')}
          </button>
        </div>
      )}

      {/* Header */}
      <div className="mb-6">
        <h1 className="font-heading text-3xl font-semibold text-charcoal">{t('title')}</h1>
        <p className="text-muted text-sm mt-1">{t('subtitle_for', { name: person.full_name })}</p>
      </div>

      {/* Submit error banner */}
      {state.submitError && (
        <div role="alert" className="mb-4 text-sm text-[#A85959] bg-[#FDF5F5] border border-[#F5D5D5] rounded-sm px-3 py-2">
          {state.submitError}
        </div>
      )}

      {/* ── Section: Personal ─────────────────────────────────────────────── */}
      <section className="mb-6">
        <h2 className="text-xs font-semibold text-muted uppercase tracking-wider mb-3">
          {t('section.personal')}
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-xs font-medium text-charcoal mb-1">
              {/* full_name */}
              Full Name <span className="text-[#A85959]">*</span>
            </label>
            <input
              type="text"
              value={state.full_name}
              onChange={e => safeDispatch({ type: 'SET_TEXT', field: 'full_name', value: e.target.value })}
              readOnly={isDeleted}
              className={fieldClass('full_name')}
              aria-invalid={!!state.fieldErrors.full_name}
            />
            {state.fieldErrors.full_name && <p className="text-xs text-[#A85959] mt-1">{state.fieldErrors.full_name}</p>}
          </div>
          <div>
            <label className="block text-xs font-medium text-charcoal mb-1">Nickname <span className="text-[#A85959]">*</span></label>
            <input
              type="text"
              value={state.nickname}
              onChange={e => safeDispatch({ type: 'SET_TEXT', field: 'nickname', value: e.target.value })}
              readOnly={isDeleted}
              className={fieldClass('nickname')}
              aria-invalid={!!state.fieldErrors.nickname}
            />
            {state.fieldErrors.nickname && <p className="text-xs text-[#A85959] mt-1">{state.fieldErrors.nickname}</p>}
          </div>
          <div>
            <label className="block text-xs font-medium text-charcoal mb-1">Birth Date</label>
            <input
              type="date"
              value={state.birth_date}
              onChange={e => safeDispatch({ type: 'SET_TEXT', field: 'birth_date', value: e.target.value })}
              readOnly={isDeleted}
              min="1900-01-01"
              max={new Date().toISOString().split('T')[0]}
              className={fieldClass('birth_date')}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-charcoal mb-1">Birth Place</label>
            <input
              type="text"
              value={state.birth_place}
              onChange={e => safeDispatch({ type: 'SET_TEXT', field: 'birth_place', value: e.target.value })}
              readOnly={isDeleted}
              className={fieldClass('birth_place')}
            />
          </div>

          <div className="sm:col-span-1">
            <p className="text-xs font-medium text-charcoal mb-2">Gender</p>
            <div className="flex flex-wrap gap-3">
              {(['male', 'female', null] as const).map(val => (
                <label key={String(val)} className={`flex items-center gap-1.5 text-sm text-ink-2 ${isDeleted ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}>
                  <input
                    type="radio"
                    name="gender"
                    checked={state.gender === val}
                    onChange={() => safeDispatch({ type: 'SET_GENDER', value: val })}
                    disabled={isDeleted}
                    className="accent-charcoal"
                  />
                  {val === 'male' ? 'Male' : val === 'female' ? 'Female' : 'Prefer not to say'}
                </label>
              ))}
            </div>
          </div>

          <div className="sm:col-span-1">
            <p className="text-xs font-medium text-charcoal mb-2">Marital Status</p>
            <div className="flex flex-wrap gap-3">
              {(['single', 'married', null] as const).map(val => (
                <label key={String(val)} className={`flex items-center gap-1.5 text-sm text-ink-2 ${isDeleted ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}>
                  <input
                    type="radio"
                    name="marital_status"
                    checked={state.marital_status === val}
                    onChange={() => safeDispatch({ type: 'SET_MARITAL', value: val })}
                    disabled={isDeleted}
                    className="accent-charcoal"
                  />
                  {val === 'single' ? 'Single' : val === 'married' ? 'Married' : '—'}
                </label>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── Section: Contact ──────────────────────────────────────────────── */}
      <section className="mb-6">
        <h2 className="text-xs font-semibold text-muted uppercase tracking-wider mb-3">
          {t('section.contact')}
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {/* Phone — read-only always */}
          <div className="sm:col-span-2">
            <label className="block text-xs font-medium text-charcoal mb-1">Phone</label>
            <input
              type="text"
              value={formatPhoneForDisplay(person.phone_e164)}
              readOnly
              className={`${FIELD_BASE} ${FIELD_READONLY}`}
              aria-label="Phone (locked)"
            />
            <p className="text-xs text-muted mt-1">{t('phone_locked')}</p>
          </div>
          <div>
            <label className="block text-xs font-medium text-charcoal mb-1">Email</label>
            <input
              type="email"
              value={state.email}
              onChange={e => safeDispatch({ type: 'SET_TEXT', field: 'email', value: e.target.value })}
              readOnly={isDeleted}
              className={fieldClass('email')}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-charcoal mb-1">Current City</label>
            <input
              type="text"
              value={state.current_city}
              onChange={e => safeDispatch({ type: 'SET_TEXT', field: 'current_city', value: e.target.value })}
              readOnly={isDeleted}
              className={fieldClass('current_city')}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-charcoal mb-1">Area</label>
            <input
              type="text"
              value={state.current_area}
              onChange={e => safeDispatch({ type: 'SET_TEXT', field: 'current_area', value: e.target.value })}
              readOnly={isDeleted}
              className={fieldClass('current_area')}
            />
          </div>
        </div>
      </section>

      {/* ── Section: Community ────────────────────────────────────────────── */}
      <section className="mb-6">
        <h2 className="text-xs font-semibold text-muted uppercase tracking-wider mb-3">
          {t('section.community')}
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="block text-xs font-medium text-charcoal mb-1">Origin Parish</label>
            {isDeleted ? (
              <input
                type="text"
                value={state.origin_parish ?? ''}
                readOnly
                className={`${FIELD_BASE} ${FIELD_READONLY}`}
              />
            ) : (
              <ParishAutocomplete
                value={state.origin_parish}
                onChange={val => safeDispatch({ type: 'SET_PARISH', value: val })}
                onCreatingChange={() => {}}
              />
            )}
          </div>
        </div>
      </section>

      {/* ── Section: Admin fields ─────────────────────────────────────────── */}
      <section className="mb-6">
        <div className="bg-cream-2 border border-line rounded-lg p-4">
          <div className="flex items-center gap-2 mb-3">
            <h2 className="text-xs font-semibold text-muted uppercase tracking-wider">
              {t('section.admin_only')}
            </h2>
            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gold/10 text-gold-dark">
              {t('section.admin_only_help')}
            </span>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-charcoal mb-1">{t('kepanitiaan_label')}</label>
              <input
                type="text"
                value={state.kepanitiaan}
                onChange={e => safeDispatch({ type: 'SET_TEXT', field: 'kepanitiaan', value: e.target.value })}
                readOnly={isDeleted}
                placeholder={isDeleted ? undefined : t('kepanitiaan_placeholder')}
                className={fieldClass('kepanitiaan')}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-charcoal mb-1">{t('tribe_label')}</label>
              <input
                type="text"
                value={state.tribe}
                onChange={e => safeDispatch({ type: 'SET_TEXT', field: 'tribe', value: e.target.value })}
                readOnly={isDeleted}
                placeholder={isDeleted ? undefined : t('tribe_placeholder')}
                className={fieldClass('tribe')}
              />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-charcoal mb-1">{t('notes_label')}</label>
              <textarea
                value={state.notes}
                onChange={e => safeDispatch({ type: 'SET_TEXT', field: 'notes', value: e.target.value })}
                readOnly={isDeleted}
                placeholder={isDeleted ? undefined : t('notes_placeholder')}
                rows={3}
                className={`${fieldClass('notes')} resize-none`}
              />
            </div>
          </div>
        </div>
      </section>

      {/* ── Section: Photo & consent ──────────────────────────────────────── */}
      <section className="mb-8">
        <h2 className="text-xs font-semibold text-muted uppercase tracking-wider mb-3">
          {t('section.photo')}
        </h2>

        {/* Current / staged photo display */}
        <div className="flex items-start gap-4 mb-4">
          <div className="w-20 h-20 rounded-full overflow-hidden flex-shrink-0 relative">
            {displayPhotoUrl ? (
              <Image
                src={displayPhotoUrl}
                alt={person.full_name}
                fill
                className="object-cover"
                sizes="80px"
                unoptimized={!!state.photoPreviewUrl}
              />
            ) : (
              <div className={`w-20 h-20 rounded-full flex items-center justify-center text-xl font-semibold ${colorForName(person.full_name)}`}>
                {initials(person.full_name)}
              </div>
            )}
          </div>

          {!isDeleted && (
            <div className="flex flex-col gap-2 pt-1">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="text-sm text-gold hover:text-gold-dark font-medium transition-colors"
              >
                {state.photoFile ? '✓ ' : ''}{t('photo.replace')}
              </button>
              {(displayPhotoUrl || state.photoFile) && !state.removePhoto && (
                <button
                  type="button"
                  onClick={handleRemovePhotoClick}
                  className="text-sm text-[#A85959] hover:underline text-left"
                >
                  {t('photo.remove')}
                </button>
              )}
              {state.removePhoto && (
                <button
                  type="button"
                  onClick={() => safeDispatch({ type: 'CANCEL_STAGED_PHOTO' })}
                  className="text-sm text-muted hover:text-charcoal transition-colors"
                >
                  Undo remove
                </button>
              )}
              <input
                ref={fileInputRef}
                type="file"
                // Extension-first + include HEIC/HEIF in accept so Safari delivers
                // the raw file instead of silently converting — required for HEIC rejection.
                // See T1-14 hotfix. Must stay in sync with HEIC_EXTS / ALLOWED_EXTS above.
                accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
                onChange={handleFileChange}
                className="hidden"
                data-testid="photo-input"
              />
              {fileError && <p className="text-xs text-[#A85959]" role="alert">{fileError}</p>}
              {state.removePhoto && (
                <p className="text-xs text-[#A85959]">Photo will be removed on save</p>
              )}
            </div>
          )}
        </div>

        {/* Consent toggle — only when not deleted and there's a photo (or staged) */}
        {!isDeleted && !state.removePhoto && (
          <div className="flex items-start gap-3">
            <input
              type="checkbox"
              id="photo-consent"
              checked={state.photo_publish_consent}
              onChange={handleConsentToggle}
              disabled={isConsentPending || (!displayPhotoUrl && !state.photoFile)}
              className="mt-0.5 h-4 w-4 flex-shrink-0 rounded border-line accent-charcoal disabled:opacity-50"
            />
            <div>
              <label htmlFor="photo-consent" className="text-sm text-ink-2 cursor-pointer leading-snug">
                {t('consent.label')}
              </label>
              {state.photo_consent_at && (
                <p className="text-xs text-muted mt-0.5">
                  {state.photo_publish_consent
                    ? t('consent.granted_at', { date: formatDate(state.photo_consent_at) })
                    : t('consent.revoked_at', { date: formatDate(state.photo_consent_at) })
                  }
                </p>
              )}
              {state.photo_consent_version && (
                <p className="text-xs text-muted">{t('consent.version', { version: state.photo_consent_version })}</p>
              )}
            </div>
          </div>
        )}
      </section>

      {/* ── Soft-delete ───────────────────────────────────────────────────── */}
      {!isDeleted && (
        <div className="mb-8 pt-4 border-t border-line">
          <button
            type="button"
            onClick={() => setShowDeleteConfirm(true)}
            disabled={isPending}
            className="text-sm text-[#A85959] hover:underline disabled:opacity-60"
          >
            {t('soft_delete_button')}
          </button>
        </div>
      )}

      {/* Delete confirmation dialog */}
      {showDeleteConfirm && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-dialog-title"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-charcoal/50"
        >
          <div className="bg-cream rounded-lg shadow-xl max-w-sm w-full p-6">
            <h2 id="delete-dialog-title" className="font-heading text-lg font-semibold text-charcoal mb-2">
              {t('soft_delete_confirm.title')}
            </h2>
            <p className="text-sm text-muted mb-6">
              {t('soft_delete_confirm.message', { name: person.full_name })}
            </p>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={handleDeleteConfirm}
                disabled={isPending}
                className="flex-1 py-2 bg-[#A85959] text-white text-sm font-medium rounded-sm hover:bg-[#8B4545] transition-colors disabled:opacity-60"
              >
                {t('soft_delete_confirm.confirm')}
              </button>
              <button
                type="button"
                onClick={() => setShowDeleteConfirm(false)}
                className="flex-1 py-2 border border-line text-sm text-charcoal rounded-sm hover:bg-cream-2 transition-colors"
              >
                {t('soft_delete_confirm.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Sticky footer: Save + Cancel ──────────────────────────────────── */}
      {!isDeleted && (
        <div className="fixed bottom-0 left-0 right-0 md:static md:bottom-auto z-10 px-4 md:px-0 py-4 bg-cream-2 border-t border-line md:bg-transparent md:border-0 md:pt-4 flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
          <button
            type="button"
            onClick={handleSave}
            disabled={isPending || !dirty}
            className="flex-1 sm:flex-none sm:px-6 py-3 bg-charcoal text-cream text-sm font-medium rounded-sm hover:bg-ink-2 active:translate-y-px transition-all min-h-[44px] disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {isPending ? t('save_button_pending') : t('save_button')}
          </button>
          <button
            type="button"
            onClick={handleCancel}
            disabled={isPending}
            className="sm:w-auto w-full py-3 px-5 border border-line text-sm text-charcoal rounded-sm hover:bg-white transition-colors min-h-[44px] disabled:opacity-60"
          >
            {t('cancel_button')}
          </button>
          <p className="text-xs text-muted sm:ml-auto self-center">
            {t('last_updated', { date: formatDate(state.updated_at) })}
          </p>
        </div>
      )}
    </div>
  )
}
