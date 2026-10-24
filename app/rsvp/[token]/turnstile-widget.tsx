'use client'

// S9-R4 Cloudflare Turnstile widget for the public RSVP form — explicit
// rendering, no npm dependency. Rendered only when the page passes a site key
// (RSVP_TURNSTILE_ENABLED on). Invisibility is a property of the site key's
// widget mode in the Cloudflare dashboard, not a render option. The token is
// handed to the parent, which submits it in a controlled hidden input; the
// server verifies it before submit_rsvp. Tokens are single-use (~300s TTL),
// so the parent bumps resetSignal after every non-success result. If api.js
// cannot load, or no token arrives in time, the parent is told via
// onUnavailable so it can explain why submit stays disabled (still fail-closed).

import { useEffect, useLayoutEffect, useRef } from 'react'

export const TURNSTILE_SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
/** No token this long after mount / reset -> report unavailable (likely blocked). */
export const TURNSTILE_UNAVAILABLE_AFTER_MS = 15_000

type TurnstileRenderOptions = {
  sitekey: string
  action: string
  'refresh-expired': 'auto' | 'manual' | 'never'
  'response-field': boolean
  callback: (token: string) => void
  'error-callback': () => void
  'expired-callback': () => void
}

export type TurnstileApi = {
  render: (container: HTMLElement, options: TurnstileRenderOptions) => string | undefined
  reset: (widgetId: string) => void
  remove: (widgetId: string) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

let scriptPromise: Promise<TurnstileApi> | null = null

/** Loads api.js once per page; a failed load is forgotten so a remount retries. */
function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  if (scriptPromise) return scriptPromise
  scriptPromise = new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = TURNSTILE_SCRIPT_SRC
    script.async = true
    script.defer = true
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile missing')))
    script.onerror = () => reject(new Error('turnstile script failed to load'))
    document.head.appendChild(script)
  }).catch((err: unknown) => {
    scriptPromise = null
    throw err
  })
  return scriptPromise
}

type TimerRef = { current: ReturnType<typeof setTimeout> | null }

function clearTimer(timerRef: TimerRef) {
  if (timerRef.current !== null) clearTimeout(timerRef.current)
  timerRef.current = null
}

/** (Re)starts the no-token countdown; fires onUnavailable(true) when it runs out. */
function armTimer(timerRef: TimerRef, onUnavailableRef: { current: ((u: boolean) => void) | undefined }) {
  clearTimer(timerRef)
  timerRef.current = setTimeout(() => {
    timerRef.current = null
    onUnavailableRef.current?.(true)
  }, TURNSTILE_UNAVAILABLE_AFTER_MS)
}

type Props = {
  siteKey: string
  /** Fresh token, or null when it expired / errored / was reset. */
  onToken: (token: string | null) => void
  /** Any change after mount resets the widget (the old token is spent). */
  resetSignal: unknown
  /** true when api.js failed to load or no token arrived in time; false on any token. */
  onUnavailable?: (unavailable: boolean) => void
}

export function TurnstileWidget({ siteKey, onToken, resetSignal, onUnavailable }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const widgetIdRef = useRef<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onTokenRef = useRef(onToken)
  const onUnavailableRef = useRef(onUnavailable)
  useEffect(() => {
    onTokenRef.current = onToken
    onUnavailableRef.current = onUnavailable
  }, [onToken, onUnavailable])

  useEffect(() => {
    let cancelled = false
    armTimer(timerRef, onUnavailableRef)
    loadTurnstile()
      .then((api) => {
        if (cancelled || !containerRef.current) return
        widgetIdRef.current =
          api.render(containerRef.current, {
            sitekey: siteKey,
            action: 'rsvp',
            'refresh-expired': 'auto',
            // The parent submits the token in its own controlled input.
            'response-field': false,
            callback: (token) => {
              clearTimer(timerRef)
              onUnavailableRef.current?.(false)
              onTokenRef.current(token)
            },
            'error-callback': () => onTokenRef.current(null),
            'expired-callback': () => onTokenRef.current(null),
          }) ?? null
      })
      .catch((err: unknown) => {
        console.error('[rsvp] turnstile unavailable:', err instanceof Error ? err.message : err)
        if (cancelled) return
        clearTimer(timerRef)
        onUnavailableRef.current?.(true)
      })
    return () => {
      cancelled = true
      clearTimer(timerRef)
      if (widgetIdRef.current !== null) window.turnstile?.remove(widgetIdRef.current)
      widgetIdRef.current = null
    }
  }, [siteKey])

  // Layout effect: the spent token is cleared before the next paint, so the
  // submit button never flashes enabled with it.
  const lastSignalRef = useRef(resetSignal)
  useLayoutEffect(() => {
    if (lastSignalRef.current === resetSignal) return
    lastSignalRef.current = resetSignal
    onTokenRef.current(null)
    if (widgetIdRef.current !== null) {
      window.turnstile?.reset(widgetIdRef.current)
      armTimer(timerRef, onUnavailableRef)
    }
  }, [resetSignal])

  return <div ref={containerRef} data-testid="rsvp-turnstile" />
}
