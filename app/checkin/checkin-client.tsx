'use client'

import { useState, useEffect, useRef, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { lookupByPhone } from '@/lib/actions/people'
import { createAttendance, listRecentAttendanceForInstance } from '@/lib/actions/attendance'
import { formatJakarta } from '@/lib/events/timezone'
import { DEFAULT_COUNTRY, type SupportedCountry } from '@/lib/utils/phone'
import type { PersonSummary, PhoneNormalizationError } from '@/lib/actions/people.types'
import type { NearestInstanceRow } from '@/lib/actions/events.types'
import type { AttendanceWithPerson } from '@/lib/actions/attendance.types'
import { PhoneInput } from './phone-input'
import { PersonCard } from './person-card'
import { NewPersonTrigger } from './new-person-trigger'
import { NewPersonForm } from './new-person-form'
import { RecentPanel } from './recent-panel'
import { EventSelector } from './_components/EventSelector'

// The server can return one of four terminal states.
// idle / too_short / searching are derived from rawPhone + debouncedPhone + isPending.
type ServerResult =
  | { phase: 'found'; person: PersonSummary }
  | { phase: 'not_found'; normalized_e164: string }
  | { phase: 'invalid_phone'; reason: PhoneNormalizationError }
  | { phase: 'error'; message: string }

type DisplayPhase = 'idle' | 'too_short' | 'searching' | ServerResult['phase']

// Feedback banner for createAttendance results. success auto-clears after 5s;
// warning (already checked in) and error persist until dismissed or next attempt.
type CheckinFeedback = {
  kind: 'success' | 'warning' | 'error'
  message: string
}

const MIN_DIGITS = 6
const SUCCESS_FEEDBACK_MS = 5000

/**
 * Delays propagating a value until the user pauses for `delayMs` ms.
 * Returns [debouncedValue, fireCount]. fireCount increments on every
 * debounce settlement — even when the value is identical to the previous
 * one — so the lookup effect re-fires when the user clears the input and
 * re-types the same phone number after a check-in.
 *
 * Chosen over useDeferredValue because we need a fixed 300ms delay
 * rather than React's render-pressure-based deferral timing.
 */
function useDebounce<T>(value: T, delayMs: number): [T, number] {
  const [state, setState] = useState<{ value: T; fireCount: number }>({ value, fireCount: 0 })
  useEffect(() => {
    const t = setTimeout(() => {
      setState((prev) => ({ value, fireCount: prev.fireCount + 1 }))
    }, delayMs)
    return () => clearTimeout(t)
  }, [value, delayMs])
  return [state.value, state.fireCount]
}

type CheckinClientProps = {
  instances?: NearestInstanceRow[]
  isAdmin?: boolean
}

export function CheckinClient({ instances = [], isAdmin = false }: CheckinClientProps) {
  const t = useTranslations('checkin')
  const [isPending, startTransition] = useTransition()
  // Separate transition for the attendance write so the lookup's 'searching'
  // display state doesn't flicker on during check-in.
  const [checkinPending, startCheckinTransition] = useTransition()
  // Dedicated transition for the recent-panel refetch so it doesn't compete with
  // the check-in or lookup transitions.
  const [attendancesPending, startAttendanceTransition] = useTransition()

  const [rawPhone, setRawPhone] = useState('')
  const [country, setCountry] = useState<SupportedCountry>(DEFAULT_COUNTRY)
  const [serverResult, setServerResult] = useState<ServerResult | null>(null)
  const [attendances, setAttendances] = useState<AttendanceWithPerson[]>([])
  const [showForm, setShowForm] = useState(false)
  const [photoUploadFailed, setPhotoUploadFailed] = useState(false)
  const [feedback, setFeedback] = useState<CheckinFeedback | null>(null)
  // eventInstanceId: the selected event instance attendance is written against.
  const [eventInstanceId, setEventInstanceId] = useState<string | null>(
    instances[0]?.id ?? null,
  )

  const inputRef = useRef<HTMLInputElement>(null)
  // Incremented before each lookup; stale results are discarded when the id no longer matches.
  const requestIdRef = useRef(0)
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [debouncedPhone, debouncedFireCount] = useDebounce(rawPhone, 300)

  // Fetch recent attendances for the current instance. Bound to eventInstanceId changes
  // and called explicitly after a successful check-in. Dedicated transition avoids
  // competing with lookup or check-in transitions (R3 — no refetch storm).
  function refetchAttendances(instanceId: string) {
    startAttendanceTransition(async () => {
      const result = await listRecentAttendanceForInstance({ eventInstanceId: instanceId })
      if (result.status === 'ok') setAttendances(result.attendances)
    })
  }

  // Refetch on mount and on instance switch. Empty dep array omitted because
  // eventInstanceId IS a dep — this fires only when it changes, not on every render.
  useEffect(() => {
    if (!eventInstanceId) return
    const id = eventInstanceId
    startAttendanceTransition(async () => {
      const result = await listRecentAttendanceForInstance({ eventInstanceId: id })
      if (result.status === 'ok') setAttendances(result.attendances)
    })
  }, [eventInstanceId])

  // Effect only fires the async server call — no synchronous setState in the effect body.
  // idle / too_short / searching are all derived from rawPhone + debouncedPhone + isPending
  // at render time, which avoids the cascading-render problem.
  // debouncedFireCount is included as a dep so the effect re-fires when the user clears
  // and re-types the same phone number after a check-in.
  useEffect(() => {
    if (debouncedPhone.replace(/\D/g, '').length < MIN_DIGITS) return

    const myId = ++requestIdRef.current
    startTransition(async () => {
      const result = await lookupByPhone(debouncedPhone, country)
      if (requestIdRef.current !== myId) return

      switch (result.status) {
        case 'found':
          setServerResult({ phase: 'found', person: result.person })
          setShowForm(false)
          break
        case 'not_found':
          setServerResult({ phase: 'not_found', normalized_e164: result.normalized_e164 })
          break
        case 'invalid_phone':
          setServerResult({ phase: 'invalid_phone', reason: result.reason })
          setShowForm(false)
          break
        case 'error':
          console.error('[checkin] lookupByPhone error:', result.message)
          setServerResult({ phase: 'error', message: result.message })
          setShowForm(false)
          break
      }
    })
  }, [debouncedPhone, debouncedFireCount, country])

  function resetToLookup() {
    setRawPhone('')
    setServerResult(null)
    setShowForm(false)
    setPhotoUploadFailed(false)
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  function showFeedback(kind: CheckinFeedback['kind'], message: string) {
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current)
    setFeedback({ kind, message })
    if (kind === 'success') {
      feedbackTimerRef.current = setTimeout(() => setFeedback(null), SUCCESS_FEEDBACK_MS)
    }
  }

  /**
   * Writes attendance via the server action and maps every result discriminant
   * to user-visible feedback.
   *
   * mode 'existing': lookup result card stays visible on non-ok results so the
   * organizer can act on the message (e.g. switch event and retry).
   * mode 'new': the person row was just created (or resolved via "use existing"),
   * so the form must collapse regardless of the attendance outcome — there is no
   * rollback of createPerson when the attendance write fails (intentional).
   */
  function performCheckIn(person: PersonSummary, isNew: boolean, mode: 'existing' | 'new') {
    if (!eventInstanceId) {
      showFeedback('error', t('results.no_event_selected'))
      if (mode === 'new') resetToLookup()
      return
    }
    const currentInstanceId = eventInstanceId
    startCheckinTransition(async () => {
      const result = await createAttendance({
        personId: person.id,
        eventInstanceId: currentInstanceId,
      })

      switch (result.status) {
        case 'ok': {
          const time = formatJakarta(new Date(result.attendance.checked_in_at), 'HH:mm')
          showFeedback('success', t('results.success', { name: person.full_name, time }))
          resetToLookup()
          // Refetch the recent panel — single source of truth, no optimistic append.
          refetchAttendances(currentInstanceId)
          return
        }
        case 'already_checked_in': {
          // Do NOT refetch — the attempt was a duplicate; panel is already accurate.
          const time = formatJakarta(new Date(result.existing.checked_in_at), 'HH:mm')
          showFeedback('warning', t('results.already_checked_in', { name: person.full_name, time }))
          break
        }
        case 'event_cancelled':
          showFeedback('error', t('results.event_cancelled'))
          break
        case 'event_inactive':
          showFeedback('error', t('results.event_inactive'))
          break
        case 'person_soft_deleted':
          showFeedback('error', t('results.person_soft_deleted'))
          break
        case 'forbidden':
          console.error('[checkin] createAttendance forbidden:', result.message)
          showFeedback('error', t('results.forbidden'))
          break
        default:
          // instance_not_found / person_not_found / invalid_input / error —
          // none should occur through normal UI flow; defensive generic message.
          console.error('[checkin] createAttendance failed:', result)
          showFeedback('error', t('results.generic_error'))
          break
      }

      if (mode === 'new') resetToLookup()
    })
  }

  function handleCheckIn(person: PersonSummary) {
    performCheckIn(person, false, 'existing')
  }

  function handleNewPersonSuccess(person: PersonSummary) {
    performCheckIn(person, true, 'new')
  }

  function handleUseExistingPerson(person: PersonSummary) {
    performCheckIn(person, false, 'new')
  }

  function handlePhotoError() {
    setPhotoUploadFailed(true)
  }

  function handlePhoneChange(phone: string, c: SupportedCountry) {
    setRawPhone(phone)
    setCountry(c)
  }

  // ── Derive display state from rawPhone / debouncedPhone / isPending / serverResult ──
  const rawDigits = rawPhone.replace(/\D/g, '')
  const debouncedDigits = debouncedPhone.replace(/\D/g, '')

  const displayPhase: DisplayPhase = (() => {
    if (rawDigits.length === 0) return 'idle'
    if (rawDigits.length < MIN_DIGITS) return 'too_short'
    // Still inside the 300ms debounce window — user hasn't stopped typing yet
    if (rawPhone !== debouncedPhone || debouncedDigits.length < MIN_DIGITS) return 'idle'
    if (isPending) return 'searching'
    if (serverResult) return serverResult.phase
    return 'idle'
  })()

  const feedbackStyles: Record<CheckinFeedback['kind'], string> = {
    success: 'text-[#5C8A6B] bg-[#F0F6F1] border-[#D8E8DC]',
    warning: 'text-[#8B7635] bg-[#FBF6E8] border-[#F5EFD9]',
    error:   'text-[#A85959] bg-[#FDF5F5] border-[#F5D5D5]',
  }

  return (
    <>
    <EventSelector
      instances={instances}
      isAdmin={isAdmin}
      onInstanceChange={setEventInstanceId}
    />
    <div className="flex flex-col md:flex-row gap-6">
      {/* ── Left column: input + result ── */}
      <div className="flex-1 min-w-0">
        {/* Check-in result banner — success auto-clears, warning/error persist */}
        {feedback && (
          <div
            role={feedback.kind === 'success' ? 'status' : 'alert'}
            data-testid="checkin-feedback"
            className={`mb-3 flex items-start justify-between gap-3 text-sm border rounded-sm px-4 py-3 ${feedbackStyles[feedback.kind]}`}
          >
            <span>{feedback.message}</span>
            <button
              type="button"
              onClick={() => setFeedback(null)}
              className="flex-shrink-0 text-muted hover:text-charcoal"
              aria-label={t('results.dismiss')}
            >
              ✕
            </button>
          </div>
        )}

        {/* Photo upload error banner — persists after form collapses */}
        {photoUploadFailed && (
          <div
            role="alert"
            className="mb-3 flex items-start justify-between gap-3 text-sm text-[#8B7635] bg-[#FBF6E8] border border-[#F5EFD9] rounded-sm px-4 py-3"
          >
            <span>{t('form.error_photo_upload')}</span>
            <button
              type="button"
              onClick={() => setPhotoUploadFailed(false)}
              className="flex-shrink-0 text-muted hover:text-charcoal"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        )}

        <div className="bg-white border border-line rounded-[4px] p-6 shadow-[0_4px_6px_-1px_rgba(26,26,26,.06),0_2px_4px_-2px_rgba(26,26,26,.04)]">
          <PhoneInput
            value={rawPhone}
            country={country}
            onPhoneChange={handlePhoneChange}
            inputRef={inputRef}
          />

          {/* Inline status below the input */}
          <div className="mt-3 min-h-[1.25rem]">
            {displayPhase === 'searching' && (
              <p className="text-xs text-muted animate-pulse">{t('lookup_searching')}</p>
            )}
            {displayPhase === 'too_short' && (
              <p className="text-xs text-muted">{t('lookup_too_short')}</p>
            )}
            {displayPhase === 'invalid_phone' && (
              <p className="text-xs text-[#A85959]">
                {serverResult?.phase === 'invalid_phone' && serverResult.reason === 'too_short'
                  ? t('lookup_too_short')
                  : t('lookup_invalid_phone')}
              </p>
            )}
            {displayPhase === 'error' && (
              <p className="text-xs text-[#A85959]">{t('lookup_error')}</p>
            )}
            {displayPhase === 'found' && (
              <p className="text-xs text-[#5C8A6B] font-medium">{t('lookup_found')}</p>
            )}
          </div>
        </div>

        {/* Result cards — only shown once the debounce has settled */}
        {displayPhase === 'found' && serverResult?.phase === 'found' && (
          <PersonCard
            person={serverResult.person}
            onCheckIn={handleCheckIn}
            checkInPending={checkinPending}
            checkInDisabled={!eventInstanceId}
          />
        )}
        {displayPhase === 'not_found' && serverResult?.phase === 'not_found' && (
          showForm ? (
            <NewPersonForm
              normalizedE164={serverResult.normalized_e164}
              country={country}
              onSuccess={handleNewPersonSuccess}
              onUseExisting={handleUseExistingPerson}
              onPhotoError={handlePhotoError}
              onCancel={() => setShowForm(false)}
            />
          ) : (
            <NewPersonTrigger
              normalizedE164={serverResult.normalized_e164}
              onAdd={() => setShowForm(true)}
            />
          )
        )}
      </div>

      {/* ── Right column: recent panel ── */}
      <div className="w-full md:w-80 lg:w-96 flex-shrink-0">
        <RecentPanel attendances={attendances} isLoading={attendancesPending} />
      </div>
    </div>
    </>
  )
}
