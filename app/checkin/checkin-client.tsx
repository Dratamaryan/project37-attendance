'use client'

import { useState, useEffect, useRef, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { lookupByPhone } from '@/lib/actions/people'
import { DEFAULT_COUNTRY, type SupportedCountry } from '@/lib/utils/phone'
import type { PersonSummary, PhoneNormalizationError } from '@/lib/actions/people.types'
import { PhoneInput } from './phone-input'
import { PersonCard } from './person-card'
import { NewPersonTrigger } from './new-person-trigger'
import { RecentPanel } from './recent-panel'

export type RecentItem = {
  person: PersonSummary
  checkedInAt: Date
  isNew: boolean
}

// The server can return one of four terminal states.
// idle / too_short / searching are derived from rawPhone + debouncedPhone + isPending.
type ServerResult =
  | { phase: 'found'; person: PersonSummary }
  | { phase: 'not_found'; normalized_e164: string }
  | { phase: 'invalid_phone'; reason: PhoneNormalizationError }
  | { phase: 'error'; message: string }

type DisplayPhase = 'idle' | 'too_short' | 'searching' | ServerResult['phase']

const MIN_DIGITS = 6

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

export function CheckinClient() {
  const t = useTranslations('checkin')
  const [isPending, startTransition] = useTransition()

  const [rawPhone, setRawPhone] = useState('')
  const [country, setCountry] = useState<SupportedCountry>(DEFAULT_COUNTRY)
  const [serverResult, setServerResult] = useState<ServerResult | null>(null)
  const [recentItems, setRecentItems] = useState<RecentItem[]>([])

  const inputRef = useRef<HTMLInputElement>(null)
  // Incremented before each lookup; stale results are discarded when the id no longer matches.
  const requestIdRef = useRef(0)

  const [debouncedPhone, debouncedFireCount] = useDebounce(rawPhone, 300)

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
          break
        case 'not_found':
          setServerResult({ phase: 'not_found', normalized_e164: result.normalized_e164 })
          break
        case 'invalid_phone':
          setServerResult({ phase: 'invalid_phone', reason: result.reason })
          break
        case 'error':
          console.error('[checkin] lookupByPhone error:', result.message)
          setServerResult({ phase: 'error', message: result.message })
          break
      }
    })
  }, [debouncedPhone, debouncedFireCount, country])

  function handleCheckIn(person: PersonSummary) {
    setRecentItems((prev) => {
      const deduped = prev.filter((item) => item.person.id !== person.id)
      return [{ person, checkedInAt: new Date(), isNew: false }, ...deduped].slice(0, 10)
    })
    setRawPhone('')
    setServerResult(null)
    // Re-focus so the volunteer can type the next number without tapping the screen.
    // setTimeout(0) lets the browser finish its blur/focus cycle first.
    // If iOS Safari swallows focus here, fall back to requestAnimationFrame.
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  function handleRecentItemClick(item: RecentItem) {
    setRawPhone(item.person.phone_e164)
    setCountry(DEFAULT_COUNTRY)
    inputRef.current?.focus()
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

  return (
    <div className="flex flex-col md:flex-row gap-6">
      {/* ── Left column: input + result ── */}
      <div className="flex-1 min-w-0">
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
          <PersonCard person={serverResult.person} onCheckIn={handleCheckIn} />
        )}
        {displayPhase === 'not_found' && serverResult?.phase === 'not_found' && (
          <NewPersonTrigger normalizedE164={serverResult.normalized_e164} />
        )}
      </div>

      {/* ── Right column: recent panel ── */}
      <div className="w-full md:w-80 lg:w-96 flex-shrink-0">
        <RecentPanel items={recentItems} onItemClick={handleRecentItemClick} />
      </div>
    </div>
  )
}
