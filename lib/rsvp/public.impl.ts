import 'server-only'
// No 'use server' — imported by lib/rsvp/public.ts (the server action), the
// public /rsvp/[token] page, and tests. Never import this file in Client
// Components.
//
// S9-R1 public RSVP page. ANON client by contract: get_rsvp_context /
// submit_rsvp are EXECUTE-granted to anon only (R0), so callers pass
// createAnonServerClient() — never the cookie-backed server client and never
// the service role. Nothing returned from here may reveal whether a phone
// belongs to the roster: page data comes only from get_rsvp_context, and the
// form state echoes back only what the visitor typed.

import { cache } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatInTimeZone } from 'date-fns-tz'
import { enUS, id as idLocale } from 'date-fns/locale'
import { createAnonServerClient } from '@/lib/supabase/anon'
import { JAKARTA_TZ } from '@/lib/events/timezone'
import { normalizePhone } from '@/lib/utils/phone'
import {
  getRsvpGateSecret,
  getRsvpTurnstileKeys,
  isRsvpPublicEnabled,
  isRsvpTurnstileEnabled,
} from './config'
import { getRsvpClientIp, rsvpThrottle, rsvpThrottleKey } from './throttle'
import { verifyTurnstile, type TurnstileVerdict } from './turnstile'
import {
  RSVP_CHILDREN_MAX,
  RSVP_CHILDREN_MIN,
  RSVP_NAME_MAX,
  RSVP_NAME_MIN,
  type RsvpEventView,
  type RsvpFieldErrors,
  type RsvpFormState,
  type RsvpLocale,
  type RsvpPageData,
  type RsvpPublicStatus,
} from './public.types'

// Generated tokens are 32 URL-safe base64 chars; the RPCs reject > 64.
const TOKEN_RE = /^[A-Za-z0-9_-]{1,64}$/
// normalizePhone parses anything; cap the raw input before it gets there.
const PHONE_RAW_MAX = 32

// ── locale / token ───────────────────────────────────────────────────────────

/**
 * /rsvp locale rule: the visitor's 'locale' cookie when it is id|en, else
 * 'id' — never app_settings.default_language (the share link is aimed at
 * Indonesian-speaking recipients regardless of the admin UI default).
 */
export function resolveRsvpLocale(raw: string | null | undefined): RsvpLocale {
  return raw === 'en' || raw === 'id' ? raw : 'id'
}

export function isWellFormedRsvpToken(token: unknown): token is string {
  return typeof token === 'string' && TOKEN_RE.test(token)
}

// ── event header formatting ──────────────────────────────────────────────────

type RsvpContextOpen = {
  event_name: string
  event_name_id: string | null
  scheduled_at: string
  duration_min: number | null
  location: string | null
  image_url: string | null
}

const DATE_FORMAT: Record<RsvpLocale, string> = {
  id: 'EEEE, d MMMM yyyy',   // Sabtu, 24 Oktober 2026
  en: 'EEEE, MMMM d, yyyy',  // Saturday, October 24, 2026
}
const TIME_FORMAT: Record<RsvpLocale, string> = {
  id: 'HH.mm',               // 18.00
  en: 'h:mm a',              // 6:00 PM
}
const DATE_FNS_LOCALE = { id: idLocale, en: enUS } as const

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * The poster is rendered with a plain <img> (S9-P0: legacy pasted URLs may be
 * on any host). Only http(s) URLs are passed through — anything else
 * (javascript:, data:, garbage) renders as no image.
 */
export function safeImageUrl(raw: unknown): string | null {
  const value = nonEmpty(raw)
  if (!value) return null
  try {
    const { protocol } = new URL(value)
    return protocol === 'https:' || protocol === 'http:' ? value : null
  } catch {
    return null
  }
}

/** Validates the open get_rsvp_context payload; anything malformed -> null. */
function parseOpenContext(data: unknown): RsvpContextOpen | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (d.open !== true) return null
  const eventName = nonEmpty(d.event_name)
  const scheduledAt = nonEmpty(d.scheduled_at)
  if (!eventName || !scheduledAt || Number.isNaN(Date.parse(scheduledAt))) return null
  return {
    event_name: eventName,
    event_name_id: nonEmpty(d.event_name_id),
    scheduled_at: scheduledAt,
    duration_min: typeof d.duration_min === 'number' ? d.duration_min : null,
    location: nonEmpty(d.location),
    image_url: nonEmpty(d.image_url),
  }
}

/**
 * Event header as the page shows it — everything in WIB, per locale. The
 * date label is the WIB calendar date of the start (an evening-UTC start can
 * land on the next WIB day). Time is "start–end WIB" from duration_min, or
 * just "start WIB" when there is no positive duration.
 */
export function formatRsvpEventView(ctx: RsvpContextOpen, locale: RsvpLocale): RsvpEventView {
  const start = new Date(ctx.scheduled_at)
  const fmt = (instant: Date, pattern: string) =>
    formatInTimeZone(instant, JAKARTA_TZ, pattern, { locale: DATE_FNS_LOCALE[locale] })

  const startTime = fmt(start, TIME_FORMAT[locale])
  const timeLabel =
    ctx.duration_min && ctx.duration_min > 0
      ? `${startTime}–${fmt(new Date(start.getTime() + ctx.duration_min * 60_000), TIME_FORMAT[locale])} WIB`
      : `${startTime} WIB`

  return {
    name: locale === 'id' ? (ctx.event_name_id ?? ctx.event_name) : ctx.event_name,
    dateLabel: fmt(start, DATE_FORMAT[locale]),
    timeLabel,
    location: ctx.location,
    imageUrl: safeImageUrl(ctx.image_url),
  }
}

// ── page data ────────────────────────────────────────────────────────────────

export async function impl_getRsvpPageData(
  token: string,
  locale: RsvpLocale,
  client: SupabaseClient,
): Promise<RsvpPageData> {
  if (!isRsvpPublicEnabled()) return { kind: 'disabled' }
  if (!isWellFormedRsvpToken(token)) return { kind: 'closed' }

  const { data, error } = await client.rpc('get_rsvp_context', { p_token: token })
  if (error) {
    // One generic view for every failure — log for us, nothing for the visitor.
    console.error('[rsvp] get_rsvp_context failed:', error.code, error.message)
    return { kind: 'closed' }
  }

  const ctx = parseOpenContext(data)
  if (!ctx) return { kind: 'closed' }
  return { kind: 'open', event: formatRsvpEventView(ctx, locale) }
}

/**
 * Request-memoized: generateMetadata and the page both call this with the
 * same (token, locale), and React cache() collapses that to one RPC.
 */
export const getRsvpPageData = cache(
  (token: string, locale: RsvpLocale): Promise<RsvpPageData> =>
    impl_getRsvpPageData(token, locale, createAnonServerClient()),
)

// ── form parsing ─────────────────────────────────────────────────────────────

export type ParsedRsvpInput = {
  status: RsvpPublicStatus
  phoneE164: string
  name: string
  children: number
  followupConsent: boolean
}

function field(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value : ''
}

/**
 * FormData -> validated submit_rsvp input, or per-field error codes. Mirrors
 * the RPC's own checks (which stay authoritative) so the visitor gets a
 * specific inline message instead of a generic 'invalid'.
 *
 * S9.5-T5: submitting means coming. The form sends no `status`; only a page
 * loaded before T5 does. From such a page 'coming' is accepted, but any other
 * answer is rejected as formOutdated — never converted to 'coming' — and so
 * is a missing/short name, because that page's own error text can't describe
 * the new rule. Either way the visitor is asked to reload.
 */
export function parseRsvpFormData(
  formData: FormData,
):
  | { ok: true; input: ParsedRsvpInput }
  | { ok: false; formOutdated: true }
  | { ok: false; fieldErrors: RsvpFieldErrors } {
  const errors: RsvpFieldErrors = {}

  const fromStalePage = formData.has('status')
  if (fromStalePage && field(formData, 'status') !== 'coming') return { ok: false, formOutdated: true }

  const rawPhone = field(formData, 'phone')
  let phoneE164: string | null = null
  if (rawPhone.length > PHONE_RAW_MAX) {
    errors.phone = 'too_long'
  } else {
    // Region ID: the link is shared in Indonesian WhatsApp groups. A leading
    // '+' still overrides the hint for non-Indonesian numbers.
    const normalized = normalizePhone(rawPhone, 'ID')
    if (normalized.ok) phoneE164 = normalized.e164
    else errors.phone = normalized.reason
  }

  const name = field(formData, 'name').trim()
  // Code points, matching Postgres char_length() in the RPC's 100-char check.
  const nameLength = [...name].length
  if (nameLength === 0) errors.name = 'required'
  else if (nameLength < RSVP_NAME_MIN) errors.name = 'too_short'
  else if (nameLength > RSVP_NAME_MAX) errors.name = 'too_long'

  if (fromStalePage && errors.name) return { ok: false, formOutdated: true }

  let children = 0
  if (field(formData, 'bringing_children') === 'yes') {
    const rawCount = field(formData, 'children_count').trim()
    if (rawCount === '') {
      errors.children = 'required'
    } else if (!/^\d{1,2}$/.test(rawCount)) {
      errors.children = 'out_of_range'
    } else {
      const count = Number(rawCount)
      if (count < RSVP_CHILDREN_MIN || count > RSVP_CHILDREN_MAX) errors.children = 'out_of_range'
      else children = count
    }
  }

  const followupConsent = field(formData, 'followup_consent') === 'on'

  if (Object.keys(errors).length > 0 || !phoneE164) {
    return { ok: false, fieldErrors: errors }
  }
  return { ok: true, input: { status: 'coming', phoneE164, name, children, followupConsent } }
}

// ── submit ───────────────────────────────────────────────────────────────────

/** S9-R4 honeypot field: hidden off-screen in the form; humans leave it empty. */
export const RSVP_HONEYPOT_FIELD = 'website'
/** Turnstile token field (the form's controlled hidden input, Cloudflare's conventional name). */
export const RSVP_TURNSTILE_FIELD = 'cf-turnstile-response'
/** Real tokens are well under this; anything longer is rejected unverified. */
export const RSVP_TURNSTILE_TOKEN_MAX = 2048

/** Injectable abuse-control seams — tests pass fakes; the server action passes defaultSubmitDeps. */
export type RsvpSubmitDeps = {
  verifyTurnstile: (token: string, secret: string) => Promise<TurnstileVerdict>
  /** true = allowed. Called only when a client IP is known. */
  throttle: (key: string) => boolean
  getClientIp: () => Promise<string | null>
}

export const defaultSubmitDeps: RsvpSubmitDeps = {
  verifyTurnstile: (token, secret) => verifyTurnstile(token, secret),
  throttle: (key) => rsvpThrottle.checkAndCount(key),
  getClientIp: getRsvpClientIp,
}

/**
 * Order: flag -> token -> parse -> honeypot -> throttle -> Turnstile -> gate
 * -> RPC. Every abuse check sits before the gate read, so a blocked submit
 * never reaches the database; blocks read as the generic 'unavailable'
 * (honeypot: a fake 'success') so a bot learns nothing.
 */
export async function impl_submitRsvp(
  token: unknown,
  formData: FormData,
  client: SupabaseClient,
  deps: RsvpSubmitDeps = defaultSubmitDeps,
): Promise<RsvpFormState> {
  // Flag off reads as closed: the page itself 404s, so a stale tab gets the
  // same "not available" view as any other dead link.
  if (!isRsvpPublicEnabled()) return { kind: 'closed' }
  if (!isWellFormedRsvpToken(token)) return { kind: 'closed' }

  const parsed = parseRsvpFormData(formData)
  if (!parsed.ok) {
    return 'formOutdated' in parsed
      ? { kind: 'error', reason: 'form_outdated' }
      : { kind: 'invalid', fieldErrors: parsed.fieldErrors }
  }
  const { input } = parsed

  // Honeypot: indistinguishable from a real success, but nothing is written
  // and nothing downstream (throttle, siteverify, RPC) runs.
  if (field(formData, RSVP_HONEYPOT_FIELD).trim() !== '') {
    console.warn('[rsvp] honeypot')
    return { kind: 'success', status: input.status, children: input.children }
  }

  // Soft per-IP throttle. The IP is hashed into the key immediately; no IP ->
  // no throttle (fail open — it is a brake, not a gate).
  const ip = await deps.getClientIp()
  if (ip !== null && !deps.throttle(rsvpThrottleKey(ip, token))) {
    console.warn('[rsvp] throttled')
    return { kind: 'unavailable' }
  }

  if (isRsvpTurnstileEnabled()) {
    const keys = getRsvpTurnstileKeys()
    if (!keys) {
      console.error('[rsvp] RSVP_TURNSTILE_ENABLED is on but a Turnstile key is not set — public RSVP submissions are failing closed')
      return { kind: 'unavailable' }
    }
    const turnstileToken = field(formData, RSVP_TURNSTILE_FIELD)
    if (turnstileToken === '' || turnstileToken.length > RSVP_TURNSTILE_TOKEN_MAX) {
      console.warn('[rsvp] turnstile token missing or oversized')
      return { kind: 'unavailable' }
    }
    if ((await deps.verifyTurnstile(turnstileToken, keys.secretKey)) !== 'ok') {
      return { kind: 'unavailable' }
    }
  }

  const gate = getRsvpGateSecret()
  if (!gate) {
    // Loud for us (misconfigured deployment), generic for the visitor.
    console.error('[rsvp] RSVP_GATE_SECRET is not set — public RSVP submissions are failing closed')
    return { kind: 'unavailable' }
  }

  const { data, error } = await client.rpc('submit_rsvp', {
    p_gate: gate,
    p_token: token,
    p_phone_e164: input.phoneE164,
    p_name: input.name,
    p_children_count: input.children,
    p_followup_consent: input.followupConsent,
    p_status: input.status,
  })

  if (error) {
    console.error('[rsvp] submit_rsvp failed:', error.code, error.message)
    return { kind: 'unavailable' }
  }

  const result = (typeof data === 'object' && data !== null ? data : {}) as { ok?: unknown; code?: unknown }
  if (result.ok === true) {
    // The visitor's OWN answers only — identical for member and newcomer.
    return { kind: 'success', status: input.status, children: input.children }
  }

  switch (result.code) {
    case 'closed':
      return { kind: 'closed' }
    case 'limit':
      return { kind: 'limit' }
    case 'unavailable':
      // Gate mismatch: RSVP_GATE_SECRET differs from this project's vault value.
      console.error('[rsvp] submit_rsvp gate rejected — RSVP_GATE_SECRET does not match the vault rsvp_gate secret')
      return { kind: 'unavailable' }
    default:
      // 'invalid' (client checks above should make this unreachable) or an
      // unexpected payload.
      return { kind: 'error' }
  }
}
