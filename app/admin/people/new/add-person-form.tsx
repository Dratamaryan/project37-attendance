'use client'

import { useEffect, useReducer, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { createPerson, lookupByName } from '@/lib/actions/people'
import type { CreateResult } from '@/lib/actions/people.types'
import { DEFAULT_COUNTRY, maskPhoneTail, type SupportedCountry } from '@/lib/utils/phone'
import { PhoneInput } from '@/app/checkin/phone-input'
import { nameKey, nameMatchQueries, mergeMatches, type NameMatch } from './name-matches'

// Local debounce hook — third copy of the pattern in checkin-client.tsx and
// people-list-client.tsx (extraction deferred; see S8-T10 verify report).
function useDebounce<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])

  return debounced
}

type Field = 'phone' | 'full_name' | 'nickname' | 'birth_date'
type FieldErrorCode = 'required' | 'future_date' | 'invalid_phone'
type Duplicate = Extract<CreateResult, { status: 'duplicate_phone' }>['existing']

type FormState = {
  phone: string
  country: SupportedCountry
  full_name: string
  nickname: string
  birth_date: string
  fieldErrors: Partial<Record<Field, FieldErrorCode>>
  duplicate: Duplicate | null
  submitError: boolean
}

type FormAction =
  | { type: 'SET_PHONE'; phone: string; country: SupportedCountry }
  | { type: 'SET_TEXT_FIELD'; field: 'full_name' | 'nickname' | 'birth_date'; value: string }
  | { type: 'SET_FIELD_ERRORS'; errors: Partial<Record<Field, FieldErrorCode>> }
  | { type: 'SET_DUPLICATE'; existing: Duplicate }
  | { type: 'SET_SUBMIT_ERROR' }
  | { type: 'CLEAR_ERRORS' }

const INITIAL_STATE: FormState = {
  phone: '',
  country: DEFAULT_COUNTRY,
  full_name: '',
  nickname: '',
  birth_date: '',
  fieldErrors: {},
  duplicate: null,
  submitError: false,
}

function reducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case 'SET_PHONE':
      // A new phone invalidates the previous duplicate result.
      return {
        ...state,
        phone: action.phone,
        country: action.country,
        duplicate: null,
        fieldErrors: { ...state.fieldErrors, phone: undefined },
      }
    case 'SET_TEXT_FIELD':
      return {
        ...state,
        [action.field]: action.value,
        fieldErrors: { ...state.fieldErrors, [action.field]: undefined },
      }
    case 'SET_FIELD_ERRORS':
      return { ...state, fieldErrors: action.errors }
    case 'SET_DUPLICATE':
      return { ...state, duplicate: action.existing }
    case 'SET_SUBMIT_ERROR':
      return { ...state, submitError: true }
    case 'CLEAR_ERRORS':
      return { ...state, fieldErrors: {}, duplicate: null, submitError: false }
  }
}

function todayIso(): string {
  return new Date().toISOString().split('T')[0]
}

function clientValidate(state: FormState): Partial<Record<Field, FieldErrorCode>> {
  const errors: Partial<Record<Field, FieldErrorCode>> = {}
  if (!state.phone.replace(/\D/g, '')) errors.phone = 'required'
  if (!state.full_name.trim()) errors.full_name = 'required'
  if (!state.nickname.trim()) errors.nickname = 'required'
  if (!state.birth_date) errors.birth_date = 'required'
  else if (state.birth_date > todayIso()) errors.birth_date = 'future_date'
  return errors
}

// Server field errors are English strings keyed by input name — map them to
// translated codes instead of rendering the raw text.
function mapServerFieldErrors(fieldErrors: Record<string, string>): Partial<Record<Field, FieldErrorCode>> {
  const errors: Partial<Record<Field, FieldErrorCode>> = {}
  if (fieldErrors.phone_e164_raw) errors.phone = 'invalid_phone'
  if (fieldErrors.full_name) errors.full_name = 'required'
  if (fieldErrors.nickname) errors.nickname = 'required'
  if (fieldErrors.birth_date) errors.birth_date = 'required'
  return errors
}

async function fetchNameMatches(fullName: string): Promise<NameMatch[]> {
  const queries = nameMatchQueries(fullName)
  if (queries.length === 0) return []
  try {
    return mergeMatches(await Promise.all(queries.map(q => lookupByName(q))))
  } catch (err) {
    // The warning is advisory — a failed lookup never blocks creation.
    console.warn('[add-person-form] name match failed', err)
    return []
  }
}

const FIELD_CLASSES =
  'w-full px-3 py-2 text-sm bg-white border rounded-sm focus:outline-none focus:border-charcoal placeholder:text-muted'
const FIELD_NORMAL = 'border-line'
const FIELD_ERROR = 'border-[#A85959] bg-[#FDF5F5]'

export function AddPersonForm() {
  const t = useTranslations('admin.people.add')
  const tf = useTranslations('checkin.form')
  const router = useRouter()
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE)
  const [isPending, startTransition] = useTransition()

  // ── Similar-name warning ──────────────────────────────────────────────────
  const debouncedName = useDebounce(state.full_name, 400)
  const [matchState, setMatchState] = useState<{ key: string; matches: NameMatch[] }>({ key: '', matches: [] })
  const [ackKey, setAckKey] = useState<string | null>(null)

  // Promise.then + cancelled flag: no startTransition in the effect and no
  // synchronous setState in its body.
  useEffect(() => {
    if (nameMatchQueries(debouncedName).length === 0) return
    let cancelled = false
    const key = nameKey(debouncedName)
    fetchNameMatches(debouncedName).then(matches => {
      if (!cancelled) setMatchState({ key, matches })
    })
    return () => { cancelled = true }
  }, [debouncedName])

  // Derived at render: only matches computed for the name in the box right now.
  const currentKey = nameKey(state.full_name)
  const visibleMatches = matchState.key === currentKey ? matchState.matches : []
  const warningOpen = visibleMatches.length > 0 && ackKey !== currentKey

  // ── Submit ────────────────────────────────────────────────────────────────
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    runSubmit(false)
  }

  function handleContinueAnyway() {
    setAckKey(currentKey)
    runSubmit(true)
  }

  function runSubmit(acknowledged: boolean) {
    const errors = clientValidate(state)
    if (Object.keys(errors).length > 0) {
      dispatch({ type: 'SET_FIELD_ERRORS', errors })
      return
    }
    dispatch({ type: 'CLEAR_ERRORS' })

    startTransition(async () => {
      // Similar-name gate. Resolve matches for the name actually being submitted,
      // so a fast submit before the debounce settles can't skip the warning.
      const key = nameKey(state.full_name)
      let matches = matchState.key === key ? matchState.matches : null
      if (matches === null) {
        matches = await fetchNameMatches(state.full_name)
        setMatchState({ key, matches })
      }
      if (matches.length > 0 && !acknowledged && ackKey !== key) return // panel now visible

      const result = await createPerson({
        phone_e164_raw: state.phone,
        country:        state.country,
        full_name:      state.full_name.trim(),
        nickname:       state.nickname.trim(),
        birth_date:     state.birth_date,
      })

      switch (result.status) {
        case 'created':
          router.push(`/admin/people/${result.person.id}`)
          return
        case 'duplicate_phone':
          dispatch({ type: 'SET_DUPLICATE', existing: result.existing })
          return
        case 'validation_error':
          dispatch({ type: 'SET_FIELD_ERRORS', errors: mapServerFieldErrors(result.field_errors) })
          return
        case 'error':
          console.error('[add-person-form] createPerson error:', result.message)
          dispatch({ type: 'SET_SUBMIT_ERROR' })
          return
      }
    })
  }

  // ── Render ────────────────────────────────────────────────────────────────
  const fieldClass = (field: Field) =>
    `${FIELD_CLASSES} ${state.fieldErrors[field] ? FIELD_ERROR : FIELD_NORMAL}`

  const fieldError = (field: Field) => {
    const code = state.fieldErrors[field]
    if (!code) return null
    return <p className="mt-1 text-xs text-[#A85959]">{t(`error.${code}`)}</p>
  }

  return (
    <div>
      <Link href="/admin/people" className="text-sm text-muted hover:text-charcoal transition-colors">
        {t('back')}
      </Link>

      <div className="mt-3 mb-6">
        <h1 className="font-heading text-3xl font-semibold text-charcoal">{t('title')}</h1>
        <p className="text-muted text-sm mt-1">{t('subtitle')}</p>
      </div>

      <form onSubmit={handleSubmit} noValidate className="bg-cream-2 border border-line rounded-[4px] px-5 py-5 space-y-5">
        {state.submitError && (
          <div role="alert" className="text-sm text-[#A85959] bg-[#FDF5F5] border border-[#F5D5D5] rounded-sm px-3 py-2">
            {t('error_generic')}
          </div>
        )}

        {/* Phone first — it is the hard duplicate check. */}
        <div>
          <PhoneInput
            value={state.phone}
            country={state.country}
            onPhoneChange={(phone, country) => dispatch({ type: 'SET_PHONE', phone, country })}
          />
          {fieldError('phone')}
        </div>

        {state.duplicate && (
          <div role="alert" className="text-sm bg-[#FDF5F5] border border-[#F5D5D5] rounded-sm px-3 py-2 space-y-2">
            <p className="text-[#A85959]">
              {state.duplicate.deleted_at
                ? t('duplicate_phone_deleted', { name: state.duplicate.full_name })
                : t('duplicate_phone', { name: state.duplicate.full_name })}
            </p>
            {state.duplicate.id !== '' && (
              <Link
                href={`/admin/people/${state.duplicate.id}`}
                className="inline-block text-charcoal underline underline-offset-2 font-medium hover:text-ink-2"
              >
                {state.duplicate.deleted_at ? t('open_to_restore') : t('open_existing')}
              </Link>
            )}
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="add-full-name" className="block text-xs font-medium text-charcoal mb-1">
              {tf('full_name_label')}
              <span className="text-[#A85959] ml-0.5">*</span>
            </label>
            <input
              id="add-full-name"
              type="text"
              value={state.full_name}
              onChange={(e) => dispatch({ type: 'SET_TEXT_FIELD', field: 'full_name', value: e.target.value })}
              placeholder={tf('full_name_placeholder')}
              autoComplete="off"
              className={fieldClass('full_name')}
              aria-required="true"
              aria-invalid={!!state.fieldErrors.full_name}
            />
            {fieldError('full_name')}
          </div>
          <div>
            <label htmlFor="add-nickname" className="block text-xs font-medium text-charcoal mb-1">
              {tf('nickname_label')}
              <span className="text-[#A85959] ml-0.5">*</span>
            </label>
            <input
              id="add-nickname"
              type="text"
              value={state.nickname}
              onChange={(e) => dispatch({ type: 'SET_TEXT_FIELD', field: 'nickname', value: e.target.value })}
              placeholder={tf('nickname_placeholder')}
              autoComplete="off"
              className={fieldClass('nickname')}
              aria-required="true"
              aria-invalid={!!state.fieldErrors.nickname}
            />
            {fieldError('nickname')}
          </div>
          {/* min-w-0: WebKit's native date control has a larger min-content
              floor than Chromium's (same fix as the check-in form). */}
          <div className="min-w-0">
            <label htmlFor="add-birth-date" className="block text-xs font-medium text-charcoal mb-1">
              {tf('birth_date_label')}
              <span className="text-[#A85959] ml-0.5">*</span>
            </label>
            <input
              id="add-birth-date"
              type="date"
              value={state.birth_date}
              onChange={(e) => dispatch({ type: 'SET_TEXT_FIELD', field: 'birth_date', value: e.target.value })}
              min="1900-01-01"
              max={todayIso()}
              className={`${fieldClass('birth_date')} min-h-[44px]`}
              aria-required="true"
              aria-invalid={!!state.fieldErrors.birth_date}
            />
            {fieldError('birth_date')}
          </div>
        </div>

        {warningOpen && (
          <div
            role="region"
            aria-label={t('similar_title')}
            className="text-sm text-[#8B7635] bg-[#FBF6E8] border border-[#F5EFD9] rounded-sm px-3 py-3 space-y-2"
          >
            <p className="font-medium">{t('similar_title')}</p>
            <ul className="space-y-1">
              {visibleMatches.map(m => (
                <li key={m.id} className="flex items-center justify-between gap-3 text-ink-2">
                  <span className="min-w-0 truncate">
                    {m.full_name}
                    {m.nickname && m.nickname !== m.full_name ? ` (${m.nickname})` : ''}
                    <span className="text-muted"> · {maskPhoneTail(m.phone_e164)}</span>
                  </span>
                  <Link
                    href={`/admin/people/${m.id}`}
                    className="flex-shrink-0 text-charcoal underline underline-offset-2 font-medium hover:text-ink-2"
                  >
                    {t('similar_open')}
                  </Link>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={handleContinueAnyway}
              disabled={isPending}
              className="text-charcoal underline underline-offset-2 font-medium hover:text-ink-2 disabled:opacity-60"
            >
              {t('similar_continue')}
            </button>
          </div>
        )}

        <div className="flex gap-3">
          <Link
            href="/admin/people"
            className="px-4 py-3 border border-line text-sm text-ink-2 rounded-sm hover:bg-cream transition-colors min-h-[44px] inline-flex items-center"
          >
            {t('cancel')}
          </Link>
          <button
            type="submit"
            disabled={isPending || warningOpen}
            className="flex-1 py-3 bg-charcoal text-cream text-sm font-medium rounded-sm hover:bg-ink-2 active:translate-y-px transition-all min-h-[44px] disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {isPending ? t('submit_pending') : t('submit')}
          </button>
        </div>
      </form>
    </div>
  )
}
