import 'server-only'
// No 'use server' — imported by lib/rsvp/health.ts (the server action) and
// tests. Never import this file in Client Components.
//
// S9-R6 A2 on-demand RSVP health check (D7). Read-only: it proves the deployed
// RSVP_GATE_SECRET matches this project's vault 'rsvp_gate' and that the
// Turnstile secret is accepted by Cloudflare, without ever returning, logging
// or rendering a secret value, length, prefix or hash. Authorization lives in
// the caller (health.ts); this module has no session.

import { createAnonServerClient } from '@/lib/supabase/anon'
import {
  getRsvpGateSecret,
  getRsvpTurnstileKeys,
  isRsvpPublicEnabled,
  isRsvpTurnstileEnabled,
} from './config'
import { classifyTurnstileSecret, type TurnstileSecretClass } from './turnstile'

export type RsvpHealthGate = 'match' | 'mismatch' | 'missing-env' | 'unknown'

export type RsvpHealthResult = {
  environment: string
  publicEnabled: boolean
  gate: RsvpHealthGate
  turnstile: {
    enabled: boolean
    keys: 'both-set' | 'missing'
    secret: TurnstileSecretClass | 'skipped'
  }
  checkedAt: string
}

/** Token for the gate probe. Contains '.', so it can never equal a real link token. */
export const RSVP_HEALTH_PROBE_TOKEN = 'rsvp-health.probe'
/** Upper bound on the whole check (each probe is raced against it). */
export const RSVP_HEALTH_DEADLINE_MS = 6000

type RpcResult = { data: unknown; error: unknown }

export type RsvpHealthDeps = {
  rpc: (fn: 'submit_rsvp', args: Record<string, unknown>) => PromiseLike<RpcResult>
  classifyTurnstileSecret: (secret: string) => Promise<TurnstileSecretClass>
  deadlineMs?: number
}

export const defaultRsvpHealthDeps: RsvpHealthDeps = {
  // The same cookie-less anon client the real public submit uses — submit_rsvp
  // is EXECUTE-granted to anon only.
  rpc: (fn, args) => createAnonServerClient().rpc(fn, args),
  classifyTurnstileSecret: (secret) => classifyTurnstileSecret(secret),
}

function withDeadline<T>(work: PromiseLike<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms)
  })
  return Promise.race([Promise.resolve(work), deadline]).finally(() => clearTimeout(timer))
}

/**
 * Gate probe. Why this call cannot write a row:
 *   1. submit_rsvp checks the gate FIRST — a wrong gate returns 'unavailable'
 *      before anything else runs.
 *   2. With the right gate, the token lookup runs next. RSVP_HEALTH_PROBE_TOKEN
 *      contains '.', which never appears in a generated token (base64 with
 *      '+/' -> '-_', no padding at 24 bytes), so the event_rsvp_links lookup
 *      finds nothing and the function returns 'closed' — before field
 *      validation, the per-instance cap check, the advisory lock or the
 *      event_rsvps insert.
 * So 'closed' means "gate accepted" and 'unavailable' means "gate rejected".
 */
async function probeGate(deps: RsvpHealthDeps): Promise<RsvpHealthGate> {
  const gate = getRsvpGateSecret()
  if (!gate) return 'missing-env'

  try {
    const { data, error } = await deps.rpc('submit_rsvp', {
      p_gate: gate,
      p_token: RSVP_HEALTH_PROBE_TOKEN,
      p_phone_e164: '+620000000000',
      p_name: null,
      p_children_count: 0,
      p_followup_consent: false,
      p_status: 'maybe',
    })
    if (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'unknown'
      console.error('[rsvp-health] submit_rsvp probe failed:', code)
      return 'unknown'
    }

    const result = (typeof data === 'object' && data !== null ? data : {}) as { ok?: unknown; code?: unknown }
    if (result.ok === true) {
      // Must never happen — the probe token cannot match a link. Flag it loudly.
      console.error('[rsvp-health] submit_rsvp probe returned ok:true — investigate event_rsvps immediately')
      return 'unknown'
    }
    if (result.code === 'closed') return 'match'
    if (result.code === 'unavailable') return 'mismatch'
    return 'unknown'
  } catch (err) {
    console.error('[rsvp-health] submit_rsvp probe threw:', err instanceof Error ? err.name : 'unknown')
    return 'unknown'
  }
}

/**
 * Turnstile secret check. Runs whenever both keys are set, EVEN WHEN Turnstile
 * is disabled, so prod keys can be checked before go-live.
 */
async function probeTurnstile(deps: RsvpHealthDeps): Promise<TurnstileSecretClass | 'skipped'> {
  const keys = getRsvpTurnstileKeys()
  if (!keys) return 'skipped'
  try {
    return await deps.classifyTurnstileSecret(keys.secretKey)
  } catch {
    return 'unknown'
  }
}

export async function impl_runRsvpHealthCheck(
  deps: RsvpHealthDeps = defaultRsvpHealthDeps,
): Promise<RsvpHealthResult> {
  const deadlineMs = deps.deadlineMs ?? RSVP_HEALTH_DEADLINE_MS
  const [gate, secret] = await Promise.all([
    withDeadline<RsvpHealthGate>(probeGate(deps), deadlineMs, 'unknown'),
    withDeadline<TurnstileSecretClass | 'skipped'>(probeTurnstile(deps), deadlineMs, 'unknown'),
  ])

  return {
    environment: process.env.VERCEL_ENV ?? 'local',
    publicEnabled: isRsvpPublicEnabled(),
    gate,
    turnstile: {
      enabled: isRsvpTurnstileEnabled(),
      keys: getRsvpTurnstileKeys() ? 'both-set' : 'missing',
      secret,
    },
    checkedAt: new Date().toISOString(),
  }
}
