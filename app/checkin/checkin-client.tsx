'use client'

import { useState, useEffect, useRef, useTransition } from 'react'
import { useTranslations, useLocale } from 'next-intl'
import { lookupByPhone, lookupByName } from '@/lib/actions/people'
import { createAttendance, listRecentAttendanceForInstance } from '@/lib/actions/attendance'
import { createChildAttendance } from '@/lib/actions/child-attendance'
import { listChildrenByParent, lookupChildByName } from '@/lib/actions/children'
import { formatJakarta } from '@/lib/events/timezone'
import { DEFAULT_COUNTRY, type SupportedCountry } from '@/lib/utils/phone'
import { sanitizeNameQuery, NAME_QUERY_MIN_LENGTH } from '@/lib/utils/name-query'
import type { PersonSummary, PhoneNormalizationError } from '@/lib/actions/people.types'
import type { NearestInstanceRow } from '@/lib/actions/events.types'
import type { AttendanceWithPerson } from '@/lib/actions/attendance.types'
import type { ChildSummary, ChildWithParentSummary } from '@/lib/actions/children.types'
import { PhoneInput } from './phone-input'
import { PersonCard } from './person-card'
import { NameMatchList } from './name-match-list'
import { ChildMatchList } from './child-match-list'
import { ChildCard } from './child-card'
import { NewChildForm } from './new-child-form'
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

// Which lookup surface is active. 'phone' and 'name' resolve to a PersonSummary
// and hand it to the same performCheckIn — the mode only changes how the person
// is found. 'child' (S8-T2) resolves to a child and writes through the separate
// performChildCheckIn; it never reaches performCheckIn.
type LookupMode = 'phone' | 'name' | 'child'

// How a child is found inside child mode. Parent-first (D1): the parent is
// found with the SAME phone/name lookup state and effects the adult modes use,
// then their children are listed. 'child_name' is the secondary search (D2).
type ChildFindMode = 'parent_phone' | 'parent_name' | 'child_name'

// Children-of-parent terminal states. Raw ChildSummary rows are stored and
// paired with the parent's name at render time.
type ChildrenServerResult =
  | { phase: 'children'; children: ChildSummary[] }
  | { phase: 'none' }
  | { phase: 'children_error' }

type ChildrenDisplayPhase = 'idle' | 'loading' | ChildrenServerResult['phase']

// Child-name lookup terminal states, tagged with their query like NameServerResult.
type ChildNameServerResult =
  | { phase: 'matches'; children: ChildWithParentSummary[]; hasMore: boolean }
  | { phase: 'none' }
  | { phase: 'child_name_error' }

type ChildNameDisplayPhase = 'idle' | 'name_too_short' | 'searching' | ChildNameServerResult['phase']

// Name-lookup terminal states. Stored alongside the query they belong to so
// 'searching' can be derived at render time (same no-setState-in-effect
// discipline as the phone lookup) rather than tracked as its own state.
type NameServerResult =
  | { phase: 'matches'; people: PersonSummary[]; hasMore: boolean }
  | { phase: 'none' }
  | { phase: 'name_error' }

type NameDisplayPhase = 'idle' | 'name_too_short' | 'searching' | NameServerResult['phase']

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
  const locale = useLocale()
  const [isPending, startTransition] = useTransition()
  // Separate transition for the attendance write so the lookup's 'searching'
  // display state doesn't flicker on during check-in.
  const [checkinPending, startCheckinTransition] = useTransition()

  const [mode, setMode] = useState<LookupMode>('phone')
  const [rawPhone, setRawPhone] = useState('')
  const [rawName, setRawName] = useState('')
  const [country, setCountry] = useState<SupportedCountry>(DEFAULT_COUNTRY)
  const [serverResult, setServerResult] = useState<ServerResult | null>(null)
  // Tagged with the query it answers so a result is never shown for a newer input.
  const [nameResult, setNameResult] = useState<
    { forQuery: string; result: NameServerResult } | null
  >(null)
  // The match the organizer tapped, pending explicit confirm — mirrors the phone
  // flow's serverResult.phase === 'found', which also stops short of writing until
  // PersonCard's "Check in" button is pressed. Tapping a row only sets this; it
  // never calls performCheckIn itself.
  const [selectedNamePerson, setSelectedNamePerson] = useState<PersonSummary | null>(null)
  const [attendances, setAttendances] = useState<AttendanceWithPerson[]>([])
  const [showForm, setShowForm] = useState(false)
  const [photoUploadFailed, setPhotoUploadFailed] = useState(false)
  const [feedback, setFeedback] = useState<CheckinFeedback | null>(null)
  // eventInstanceId: the selected event instance attendance is written against.
  const [eventInstanceId, setEventInstanceId] = useState<string | null>(
    instances[0]?.id ?? null,
  )
  // ── Child mode (S8-T2) ──
  const [childFind, setChildFind] = useState<ChildFindMode>('parent_phone')
  // Tagged with the parent it answers so a list is never shown for another parent.
  const [childrenResult, setChildrenResult] = useState<
    { forParentId: string; result: ChildrenServerResult } | null
  >(null)
  const [rawChildName, setRawChildName] = useState('')
  const [childNameResult, setChildNameResult] = useState<
    { forQuery: string; result: ChildNameServerResult } | null
  >(null)
  // The child the organizer tapped, pending explicit confirm on ChildCard.
  // Selecting never writes — same select ≠ commit rule as selectedNamePerson.
  const [selectedChild, setSelectedChild] = useState<ChildWithParentSummary | null>(null)
  // S8-T4b add-child form: keyed to the parent it was opened for, so it only
  // renders while that same parent is still resolved (a new lookup hides it).
  const [addChildForParentId, setAddChildForParentId] = useState<string | null>(null)
  // Advisory duplicate notice for a just-created child (create was NOT blocked).
  const [childDuplicateNotice, setChildDuplicateNotice] = useState<
    { childId: string; name: string } | null
  >(null)

  const inputRef = useRef<HTMLInputElement>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const childNameInputRef = useRef<HTMLInputElement>(null)
  // Incremented before each lookup; stale results are discarded when the id no longer matches.
  const requestIdRef = useRef(0)
  // Same cancellation-ref guard for the name lookup. Deliberately NOT
  // startTransition(async) inside useEffect — React 19 may silently drop an
  // async transition that wasn't initiated from an event handler (see the
  // doFetchAttendances note below, same failure mode).
  const nameRequestIdRef = useRef(0)
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Attendance fetch race-condition guard — prevents stale responses from overwriting newer ones.
  // Uses a counter rather than AbortController because server actions don't expose a fetch signal.
  const attendanceFetchIdRef = useRef(0)
  // Same stale-response guard for the two child lookups.
  const childrenRequestIdRef = useRef(0)
  const childNameRequestIdRef = useRef(0)

  const [debouncedPhone, debouncedFireCount] = useDebounce(rawPhone, 300)
  const [debouncedName, debouncedNameFireCount] = useDebounce(rawName, 300)
  const [debouncedChildName, debouncedChildNameFireCount] = useDebounce(rawChildName, 300)

  // Which input surface is live. Child mode's parent lookups reuse the adult
  // phone/name state, so these — not `mode` alone — gate the lookup effects.
  const phoneActive = mode === 'phone' || (mode === 'child' && childFind === 'parent_phone')
  const nameActive = mode === 'name' || (mode === 'child' && childFind === 'parent_name')
  const childNameActive = mode === 'child' && childFind === 'child_name'

  // Localized month names for formatDayMonth (child birth date, no year).
  const months = t.raw('child.months') as string[]

  // Derive the event name for the current instance (locale-aware).
  const currentInstance = instances.find((i) => i.id === eventInstanceId) ?? null
  const eventName = currentInstance
    ? (locale === 'id' && currentInstance.event_name_snapshot_id
        ? currentInstance.event_name_snapshot_id
        : currentInstance.event_name_snapshot)
    : null

  // Fetch attendances using a direct promise approach. startTransition(async) called from inside
  // useEffect is unreliable in React 19 — async transitions may be silently dropped when not
  // initiated from an event handler. Direct .then() with a cancellation ref is robust in all contexts.
  function doFetchAttendances(instanceId: string) {
    const myFetch = ++attendanceFetchIdRef.current
    listRecentAttendanceForInstance({ eventInstanceId: instanceId }).then((result) => {
      if (attendanceFetchIdRef.current !== myFetch) return
      if (result.status === 'ok') setAttendances(result.attendances)
    })
  }

  // Refetch on mount and on instance switch.
  useEffect(() => {
    if (!eventInstanceId) return
    doFetchAttendances(eventInstanceId)
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

  // Name lookup — direct promise + cancellation ref, no setState in the effect
  // body. The sanitized-length gate mirrors the server's, which is the real
  // enforcement point; this one only avoids a round-trip that would return
  // query_too_short anyway.
  useEffect(() => {
    if (!nameActive) return
    if (sanitizeNameQuery(debouncedName).length < NAME_QUERY_MIN_LENGTH) return

    const myId = ++nameRequestIdRef.current
    const forQuery = debouncedName

    lookupByName(forQuery).then((result) => {
      if (nameRequestIdRef.current !== myId) return

      switch (result.status) {
        case 'matches':
          setNameResult({
            forQuery,
            result: { phase: 'matches', people: result.people, hasMore: result.hasMore },
          })
          break
        case 'none':
          setNameResult({ forQuery, result: { phase: 'none' } })
          break
        case 'query_too_short':
          // Client gate should have caught this; treat as idle rather than an error.
          setNameResult(null)
          break
        case 'error':
          console.error('[checkin] lookupByName error:', result.message)
          setNameResult({ forQuery, result: { phase: 'name_error' } })
          break
      }
    })
  }, [debouncedName, debouncedNameFireCount, nameActive])

  // Child-name lookup (D2) — same direct-promise + cancellation-ref discipline.
  useEffect(() => {
    if (!childNameActive) return
    if (sanitizeNameQuery(debouncedChildName).length < NAME_QUERY_MIN_LENGTH) return

    const myId = ++childNameRequestIdRef.current
    const forQuery = debouncedChildName

    lookupChildByName(forQuery).then((result) => {
      if (childNameRequestIdRef.current !== myId) return

      switch (result.status) {
        case 'matches':
          setChildNameResult({
            forQuery,
            result: { phase: 'matches', children: result.children, hasMore: result.hasMore },
          })
          break
        case 'none':
          setChildNameResult({ forQuery, result: { phase: 'none' } })
          break
        case 'query_too_short':
          setChildNameResult(null)
          break
        case 'error':
          console.error('[checkin] lookupChildByName error:', result.message)
          setChildNameResult({ forQuery, result: { phase: 'child_name_error' } })
          break
      }
    })
  }, [debouncedChildName, debouncedChildNameFireCount, childNameActive])

  function resetToLookup() {
    setRawPhone('')
    setRawName('')
    setServerResult(null)
    setNameResult(null)
    setSelectedNamePerson(null)
    setShowForm(false)
    setPhotoUploadFailed(false)
    // Return focus to whichever surface the organizer is actually using.
    setTimeout(() => {
      if (mode === 'name') nameInputRef.current?.focus()
      else inputRef.current?.focus()
    }, 0)
  }

  /**
   * Switching surfaces clears the other one's input and result so a stale card
   * or match list can never outlive the mode that produced it. Invalidates any
   * in-flight lookup of the mode being left.
   */
  function handleModeChange(next: LookupMode) {
    if (next === mode) return
    requestIdRef.current++
    nameRequestIdRef.current++
    setMode(next)
    setRawPhone('')
    setRawName('')
    setServerResult(null)
    setNameResult(null)
    setSelectedNamePerson(null)
    setShowForm(false)
    // Child state is cleared on every mode switch too, so a child card or list
    // can never outlive child mode. Child mode always re-enters parent-first.
    clearChildState()
    setChildFind('parent_phone')
    setTimeout(() => {
      if (next === 'name') nameInputRef.current?.focus()
      else inputRef.current?.focus()
    }, 0)
  }

  /**
   * Clears every child-mode result and selection and invalidates in-flight
   * child lookups. The parent-for-child is derived from the adult phone/name
   * state, so callers that also clear that state clear the parent with it.
   */
  function clearChildState() {
    childrenRequestIdRef.current++
    childNameRequestIdRef.current++
    setChildrenResult(null)
    setRawChildName('')
    setChildNameResult(null)
    setSelectedChild(null)
    setAddChildForParentId(null)
    setChildDuplicateNotice(null)
  }

  function focusChildFind(find: ChildFindMode) {
    setTimeout(() => {
      if (find === 'parent_phone') inputRef.current?.focus()
      else if (find === 'parent_name') nameInputRef.current?.focus()
      else childNameInputRef.current?.focus()
    }, 0)
  }

  /**
   * Switching how a child is found inside child mode clears the parent lookup
   * (shared phone/name state) and all child state — same rule as handleModeChange.
   */
  function handleChildFindChange(next: ChildFindMode) {
    if (next === childFind) return
    requestIdRef.current++
    nameRequestIdRef.current++
    setChildFind(next)
    setRawPhone('')
    setRawName('')
    setServerResult(null)
    setNameResult(null)
    setSelectedNamePerson(null)
    clearChildState()
    focusChildFind(next)
  }

  /**
   * S8-T4b: a child was created (status 'created' OR 'duplicate_warning' — the
   * row exists either way). Creating is not checking in: go straight to the
   * ChildCard confirm step, whose button stays the only child_attendance write.
   * The new child is merged into the cached children list locally so "Back to
   * results" shows it without a refetch.
   */
  function handleChildCreated(
    parent: PersonSummary,
    child: ChildSummary,
    existing: ChildSummary[],
  ) {
    setAddChildForParentId(null)
    setChildrenResult((prev) => {
      const prior =
        prev?.forParentId === parent.id && prev.result.phase === 'children' ? prev.result.children : []
      const merged = [...prior, child].sort((a, b) => a.full_name.localeCompare(b.full_name))
      return { forParentId: parent.id, result: { phase: 'children', children: merged } }
    })
    setChildDuplicateNotice(existing.length > 0 ? { childId: child.id, name: child.full_name } : null)
    setSelectedChild({ ...child, parent_full_name: parent.full_name })
  }

  /** After a successful child check-in: back to an empty child-mode lookup. */
  function resetChildLookup() {
    requestIdRef.current++
    nameRequestIdRef.current++
    setRawPhone('')
    setRawName('')
    setServerResult(null)
    setNameResult(null)
    setSelectedNamePerson(null)
    clearChildState()
    focusChildFind(childFind)
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
          doFetchAttendances(currentInstanceId)
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

  /**
   * Writes a child_attendance row via createChildAttendance. Deliberately
   * separate from performCheckIn — child check-ins never touch the adult write
   * path, and (D3) never refetch or appear in the adult Recent panel.
   *
   * Only ChildCard's "Check in" button calls this. Non-ok results leave the
   * card visible so the organizer can act on the message.
   */
  function performChildCheckIn(child: ChildWithParentSummary) {
    if (!eventInstanceId) {
      showFeedback('error', t('results.no_event_selected'))
      return
    }
    const currentInstanceId = eventInstanceId
    startCheckinTransition(async () => {
      const result = await createChildAttendance({
        childId: child.id,
        eventInstanceId: currentInstanceId,
      })

      switch (result.status) {
        case 'ok': {
          const time = formatJakarta(new Date(result.attendance.checked_in_at), 'HH:mm')
          showFeedback('success', t('child.results.success', { name: child.full_name, time }))
          resetChildLookup()
          return
        }
        case 'already_checked_in': {
          const time = formatJakarta(new Date(result.existing.checked_in_at), 'HH:mm')
          showFeedback('warning', t('child.results.already_checked_in', { name: child.full_name, time }))
          break
        }
        case 'event_cancelled':
          showFeedback('error', t('child.results.event_cancelled'))
          break
        case 'event_inactive':
          showFeedback('error', t('child.results.event_inactive'))
          break
        case 'child_not_found':
          showFeedback('error', t('child.results.child_not_found'))
          break
        case 'child_soft_deleted':
          showFeedback('error', t('child.results.child_soft_deleted'))
          break
        case 'forbidden':
          console.error('[checkin] createChildAttendance forbidden:', result.message)
          showFeedback('error', t('child.results.forbidden'))
          break
        default:
          // instance_not_found / invalid_input / error — none should occur
          // through normal UI flow; defensive generic message.
          console.error('[checkin] createChildAttendance failed:', result)
          showFeedback('error', t('child.results.generic_error'))
          break
      }
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

  /**
   * Tapping a name-search match only selects it for review — it never writes.
   * The PersonCard rendered from selectedNamePerson has the only "Check in"
   * button on this path, same as the phone flow's found-person card.
   */
  function handleNameMatchSelect(person: PersonSummary) {
    setSelectedNamePerson(person)
  }

  /**
   * Returns to the match list without touching rawName or nameResult — the
   * typed query and its already-tagged result are still valid, so no lookup
   * re-runs.
   */
  function handleBackToResults() {
    setSelectedNamePerson(null)
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

  // Same derivation discipline as displayPhase: everything is computed from the
  // raw input, the debounced input, and the tagged result — no separate
  // 'searching' state to fall out of sync.
  const nameDisplayPhase: NameDisplayPhase = (() => {
    if (!nameActive) return 'idle'
    const safeRaw = sanitizeNameQuery(rawName)
    if (safeRaw.length === 0) return 'idle'
    if (safeRaw.length < NAME_QUERY_MIN_LENGTH) return 'name_too_short'
    // Still inside the debounce window — the user hasn't stopped typing yet
    if (rawName !== debouncedName) return 'searching'
    if (nameResult && nameResult.forQuery === debouncedName) return nameResult.result.phase
    return 'searching'
  })()

  const nameMatches =
    nameResult?.result.phase === 'matches' ? nameResult.result : null

  // ── Child mode derivations ──
  // The parent whose children are listed. Derived, not stored: phone resolves
  // to a unique person, so a settled 'found' IS the parent; name needs an
  // explicit tap on the parent match (selectedNamePerson). Selecting a parent
  // is not a write — only ChildCard's button writes.
  const parentForChild: PersonSummary | null = (() => {
    if (mode !== 'child') return null
    if (childFind === 'parent_phone') {
      return displayPhase === 'found' && serverResult?.phase === 'found' ? serverResult.person : null
    }
    if (childFind === 'parent_name') return selectedNamePerson
    return null
  })()
  const parentForChildId = parentForChild?.id ?? null
  const addChildOpen = addChildForParentId !== null && addChildForParentId === parentForChildId

  // Fetch the parent's children whenever the derived parent changes.
  // Direct promise + cancellation ref; setState only in the async callback.
  useEffect(() => {
    if (!parentForChildId) return
    const myId = ++childrenRequestIdRef.current
    const forParentId = parentForChildId

    listChildrenByParent(forParentId).then((result) => {
      if (childrenRequestIdRef.current !== myId) return

      switch (result.status) {
        case 'children':
          setChildrenResult({ forParentId, result: { phase: 'children', children: result.children } })
          break
        case 'none':
          setChildrenResult({ forParentId, result: { phase: 'none' } })
          break
        case 'invalid_input':
        case 'error':
          console.error('[checkin] listChildrenByParent failed:', result)
          setChildrenResult({ forParentId, result: { phase: 'children_error' } })
          break
      }
    })
  }, [parentForChildId])

  const childrenDisplayPhase: ChildrenDisplayPhase = (() => {
    if (!parentForChildId) return 'idle'
    if (childrenResult && childrenResult.forParentId === parentForChildId) {
      return childrenResult.result.phase
    }
    return 'loading'
  })()

  // Parent-first rows carry the parent's name so both paths render the same
  // ChildWithParentSummary shape (D2 disambiguator).
  const parentChildren: ChildWithParentSummary[] =
    parentForChild && childrenResult?.forParentId === parentForChild.id &&
    childrenResult.result.phase === 'children'
      ? childrenResult.result.children.map((c) => ({ ...c, parent_full_name: parentForChild.full_name }))
      : []

  const childNameDisplayPhase: ChildNameDisplayPhase = (() => {
    if (!childNameActive) return 'idle'
    const safeRaw = sanitizeNameQuery(rawChildName)
    if (safeRaw.length === 0) return 'idle'
    if (safeRaw.length < NAME_QUERY_MIN_LENGTH) return 'name_too_short'
    if (rawChildName !== debouncedChildName) return 'searching'
    if (childNameResult && childNameResult.forQuery === debouncedChildName) {
      return childNameResult.result.phase
    }
    return 'searching'
  })()

  const childNameMatches =
    childNameResult?.result.phase === 'matches' ? childNameResult.result : null

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
          {/* Lookup-surface toggle. min-w-0 on each flex child so the labels
              shrink together instead of overflowing a 360px row (T4). Three
              tabs at 360px leave ~64px of text width each, so the labels are
              single short words (S8-T2) and may wrap rather than overflow. */}
          <div
            role="tablist"
            aria-label={t('name_search.mode_label')}
            data-testid="lookup-mode-toggle"
            className="flex gap-2 mb-5"
          >
            {(['phone', 'name', 'child'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                onClick={() => handleModeChange(m)}
                className={`flex-1 min-w-0 px-2 py-2 min-h-[44px] text-sm font-medium leading-tight break-words rounded-sm border transition-colors ${
                  mode === m
                    ? 'bg-charcoal text-cream border-charcoal'
                    : 'bg-cream text-ink-2 border-line hover:border-gold'
                }`}
              >
                {m === 'phone'
                  ? t('name_search.mode_phone')
                  : m === 'name'
                    ? t('name_search.mode_name')
                    : t('child.mode_child')}
              </button>
            ))}
          </div>

          {/* Child mode: how the child is found. Parent-first (D1) by default;
              child-name search is secondary (D2). Same 360px treatment. */}
          {mode === 'child' && (
            <div
              role="group"
              aria-label={t('child.find_label')}
              data-testid="child-find-toggle"
              className="flex gap-2 mb-5"
            >
              {(['parent_phone', 'parent_name', 'child_name'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  aria-pressed={childFind === f}
                  onClick={() => handleChildFindChange(f)}
                  className={`flex-1 min-w-0 px-2 py-1.5 min-h-[44px] text-xs font-medium leading-tight break-words rounded-sm border transition-colors ${
                    childFind === f
                      ? 'bg-gold-dark text-cream border-gold-dark'
                      : 'bg-white text-ink-2 border-line hover:border-gold'
                  }`}
                >
                  {t(`child.find_${f}`)}
                </button>
              ))}
            </div>
          )}

          {mode === 'child' && childFind === 'child_name' ? (
            <div className="min-w-0">
              <label
                htmlFor="checkin-child-name-input"
                className="block text-xs uppercase tracking-widest text-muted font-semibold mb-2"
              >
                {t('child.child_name_label')}
              </label>
              <input
                id="checkin-child-name-input"
                ref={childNameInputRef}
                type="text"
                autoComplete="off"
                aria-label={t('child.child_name_label')}
                value={rawChildName}
                onChange={(e) => setRawChildName(e.target.value)}
                placeholder={t('child.child_name_placeholder')}
                className="w-full min-w-0 px-5 py-4 bg-cream border border-line rounded-sm font-heading text-2xl tracking-wide transition-all focus:outline-none focus:border-gold focus:bg-white focus:shadow-[0_0_0_3px_#F5EFD9] placeholder:text-[#9A9183]"
              />
            </div>
          ) : phoneActive ? (
            <PhoneInput
              value={rawPhone}
              country={country}
              onPhoneChange={handlePhoneChange}
              inputRef={inputRef}
            />
          ) : (
            // min-w-0 on the wrapper, not just the input — a bare block wrapper
            // inside a flex/grid parent otherwise floors at min-content (T4).
            <div className="min-w-0">
              <label
                htmlFor="checkin-name-input"
                className="block text-xs uppercase tracking-widest text-muted font-semibold mb-2"
              >
                {t('name_search.name_label')}
              </label>
              <input
                id="checkin-name-input"
                ref={nameInputRef}
                type="text"
                autoComplete="off"
                aria-label={t('name_search.name_label')}
                value={rawName}
                onChange={(e) => setRawName(e.target.value)}
                placeholder={t('name_search.name_placeholder')}
                className="w-full min-w-0 px-5 py-4 bg-cream border border-line rounded-sm font-heading text-2xl tracking-wide transition-all focus:outline-none focus:border-gold focus:bg-white focus:shadow-[0_0_0_3px_#F5EFD9] placeholder:text-[#9A9183]"
              />
            </div>
          )}

          {/* Inline status below the input */}
          <div className="mt-3 min-h-[1.25rem]">
            {childNameActive ? (
              <>
                {childNameDisplayPhase === 'searching' && (
                  <p className="text-xs text-muted animate-pulse">{t('lookup_searching')}</p>
                )}
                {childNameDisplayPhase === 'name_too_short' && (
                  <p className="text-xs text-muted">{t('name_search.too_short')}</p>
                )}
                {childNameDisplayPhase === 'child_name_error' && (
                  <p className="text-xs text-[#A85959]">{t('lookup_error')}</p>
                )}
              </>
            ) : phoneActive ? (
              <>
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
              </>
            ) : (
              <>
                {nameDisplayPhase === 'searching' && (
                  <p className="text-xs text-muted animate-pulse">{t('lookup_searching')}</p>
                )}
                {nameDisplayPhase === 'name_too_short' && (
                  <p className="text-xs text-muted">{t('name_search.too_short')}</p>
                )}
                {nameDisplayPhase === 'name_error' && (
                  <p className="text-xs text-[#A85959]">{t('lookup_error')}</p>
                )}
              </>
            )}
          </div>
        </div>

        {/* ── Child mode results (S8-T2). Every child path ends at ChildCard,
            whose "Check in" button is the only child write. Rows only select. ── */}
        {mode === 'child' && selectedChild && childDuplicateNotice?.childId === selectedChild.id && (
          <div
            role="status"
            data-testid="child-duplicate-notice"
            className="mt-4 text-sm text-[#8B7635] bg-[#FBF6E8] border border-[#F5EFD9] rounded-sm px-3 py-2"
          >
            {t('child.add.duplicate_warning', { name: childDuplicateNotice.name })}
          </div>
        )}
        {mode === 'child' && selectedChild && (
          <ChildCard
            child={selectedChild}
            onCheckIn={performChildCheckIn}
            onBack={() => setSelectedChild(null)}
            months={months}
            checkInPending={checkinPending}
            checkInDisabled={!eventInstanceId}
          />
        )}
        {mode === 'child' && !selectedChild && (
          <>
            {/* Parent by phone: not found → no add-person here (registration is
                adult-only and phone-anchored). */}
            {childFind === 'parent_phone' && displayPhase === 'not_found' && (
              <div
                data-testid="child-parent-not-found"
                className="mt-4 p-5 bg-white border border-line rounded-[4px]"
              >
                <p className="text-sm text-charcoal">{t('child.parent_not_found')}</p>
              </div>
            )}

            {/* Parent by name: pick the parent from the SAME NameMatchList the
                adult name mode uses; tapping only selects the parent. */}
            {childFind === 'parent_name' && selectedNamePerson && (
              <div className="mt-4 flex items-center gap-3 text-sm">
                <button
                  type="button"
                  onClick={handleBackToResults}
                  className="text-muted hover:text-charcoal transition-colors underline underline-offset-2 min-h-[44px]"
                >
                  {t('name_search.back_to_results')}
                </button>
              </div>
            )}
            {childFind === 'parent_name' && !selectedNamePerson && nameDisplayPhase === 'matches' && nameMatches && (
              <NameMatchList
                people={nameMatches.people}
                hasMore={nameMatches.hasMore}
                onSelect={handleNameMatchSelect}
              />
            )}
            {childFind === 'parent_name' && !selectedNamePerson && nameDisplayPhase === 'none' && (
              <div
                data-testid="child-parent-name-no-match"
                className="mt-4 p-5 bg-white border border-line rounded-[4px]"
              >
                <p className="text-sm text-charcoal">{t('name_search.none')}</p>
                <button
                  type="button"
                  onClick={() => handleChildFindChange('parent_phone')}
                  className="mt-3 text-sm text-gold-dark font-medium underline underline-offset-2 min-h-[44px]"
                >
                  {t('name_search.none_hint')}
                </button>
              </div>
            )}

            {/* The resolved parent's children (both parent paths). */}
            {childrenDisplayPhase === 'loading' && (
              <p className="mt-4 text-xs text-muted animate-pulse">{t('lookup_searching')}</p>
            )}
            {childrenDisplayPhase === 'children' && (
              <>
                <ChildMatchList
                  childMatches={parentChildren}
                  hasMore={false}
                  onSelect={setSelectedChild}
                  months={months}
                />
                {!addChildOpen && parentForChild && (
                  <button
                    type="button"
                    data-testid="add-child-another"
                    onClick={() => setAddChildForParentId(parentForChild.id)}
                    className="mt-3 text-sm text-gold-dark font-medium underline underline-offset-2 min-h-[44px]"
                  >
                    {t('child.add.add_another_button')}
                  </button>
                )}
              </>
            )}
            {childrenDisplayPhase === 'none' && !addChildOpen && (
              <div
                data-testid="child-none-for-parent"
                className="mt-4 p-5 bg-white border border-line rounded-[4px]"
              >
                <p className="text-sm text-charcoal">{t('child.none_for_parent')}</p>
                {parentForChild && (
                  <button
                    type="button"
                    data-testid="add-child-first"
                    onClick={() => setAddChildForParentId(parentForChild.id)}
                    className="mt-3 px-4 py-2 bg-charcoal text-cream text-sm font-medium rounded-sm hover:bg-ink-2 transition-colors min-h-[44px]"
                  >
                    {t('child.add.add_button')}
                  </button>
                )}
              </div>
            )}
            {addChildOpen && parentForChild && (
              <NewChildForm
                parent={parentForChild}
                onCreated={(child, existing) => handleChildCreated(parentForChild, child, existing)}
                onCancel={() => setAddChildForParentId(null)}
              />
            )}
            {childrenDisplayPhase === 'children_error' && (
              <p className="mt-4 text-xs text-[#A85959]">{t('lookup_error')}</p>
            )}

            {/* Child by name (secondary). Rows already carry parent_full_name. */}
            {childNameDisplayPhase === 'matches' && childNameMatches && (
              <ChildMatchList
                childMatches={childNameMatches.children}
                hasMore={childNameMatches.hasMore}
                onSelect={setSelectedChild}
                months={months}
              />
            )}
            {childNameDisplayPhase === 'none' && (
              <div
                data-testid="child-name-no-match"
                className="mt-4 p-5 bg-white border border-line rounded-[4px]"
              >
                <p className="text-sm text-charcoal">{t('child.none_by_name')}</p>
                {/* No parent is known here, so no create — a child is only ever
                    added under a resolved parent (S8-T4b). */}
                <button
                  type="button"
                  onClick={() => handleChildFindChange('parent_phone')}
                  className="mt-3 text-sm text-gold-dark font-medium underline underline-offset-2 min-h-[44px]"
                >
                  {t('child.add.find_parent_hint')}
                </button>
              </div>
            )}
          </>
        )}

        {/* Result cards — only shown once the debounce has settled */}
        {mode === 'phone' && displayPhase === 'found' && serverResult?.phase === 'found' && (
          <PersonCard
            person={serverResult.person}
            onCheckIn={handleCheckIn}
            checkInPending={checkinPending}
            checkInDisabled={!eventInstanceId}
          />
        )}
        {mode === 'phone' && displayPhase === 'not_found' && serverResult?.phase === 'not_found' && (
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

        {/* Name-search confirm step: a tapped match only selects a person for
            review. The PersonCard below is the SAME component the phone flow
            renders, and its "Check in" button is the only thing that writes —
            identical to onCheckIn on the phone path. */}
        {mode === 'name' && selectedNamePerson && (
          <>
            <div className="mt-4 flex items-center gap-3 text-sm">
              <button
                type="button"
                onClick={handleBackToResults}
                className="text-muted hover:text-charcoal transition-colors underline underline-offset-2 min-h-[44px]"
              >
                {t('name_search.back_to_results')}
              </button>
            </div>
            <PersonCard
              person={selectedNamePerson}
              onCheckIn={handleCheckIn}
              checkInPending={checkinPending}
              checkInDisabled={!eventInstanceId}
            />
          </>
        )}
        {mode === 'name' && !selectedNamePerson && nameDisplayPhase === 'matches' && nameMatches && (
          <NameMatchList
            people={nameMatches.people}
            hasMore={nameMatches.hasMore}
            onSelect={handleNameMatchSelect}
          />
        )}
        {mode === 'name' && !selectedNamePerson && nameDisplayPhase === 'none' && (
          // No "add new person" here on purpose: registration is phone-anchored
          // (phone is the unique key), so a name miss routes back to phone search.
          <div
            data-testid="name-no-match"
            className="mt-4 p-5 bg-white border border-line rounded-[4px]"
          >
            <p className="text-sm text-charcoal">{t('name_search.none')}</p>
            <button
              type="button"
              onClick={() => handleModeChange('phone')}
              className="mt-3 text-sm text-gold-dark font-medium underline underline-offset-2 min-h-[44px]"
            >
              {t('name_search.none_hint')}
            </button>
          </div>
        )}
      </div>

      {/* ── Right column: recent panel ── */}
      <div className="w-full md:w-80 lg:w-96 flex-shrink-0">
        <RecentPanel attendances={attendances} eventName={eventName} />
      </div>
    </div>
    </>
  )
}
