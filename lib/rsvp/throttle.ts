import 'server-only'
// S9-R4 per-IP soft throttle for the public RSVP submit. In-memory only: one
// Map per server instance (Fluid Compute may run several, so the effective
// limit is per instance — a soft brake, not a guarantee). The visitor's IP is
// hashed the moment it is read; the raw value is never stored, logged,
// returned or persisted. Nothing here touches the database.

import { createHash } from 'crypto'
import { headers } from 'next/headers'

export const THROTTLE_WINDOW_MS = 10 * 60 * 1000
export const THROTTLE_LIMIT = 20
export const THROTTLE_MAX_KEYS = 5000

type Bucket = { windowStart: number; count: number }

export type Throttle = {
  /** true = allowed (and counted); false = over the limit for this window. */
  checkAndCount: (key: string) => boolean
  size: () => number
}

/**
 * Fixed-window counter: THROTTLE_LIMIT submits per key per THROTTLE_WINDOW_MS.
 * The Map is capped at THROTTLE_MAX_KEYS — on overflow, expired buckets are
 * dropped first, then the oldest (Map insertion order; a key is re-inserted
 * when its window restarts).
 */
export function createThrottle(now: () => number = Date.now): Throttle {
  const buckets = new Map<string, Bucket>()

  function evict(at: number) {
    for (const [key, bucket] of buckets) {
      if (at - bucket.windowStart >= THROTTLE_WINDOW_MS) buckets.delete(key)
    }
    for (const key of buckets.keys()) {
      if (buckets.size < THROTTLE_MAX_KEYS) break
      buckets.delete(key)
    }
  }

  return {
    checkAndCount(key) {
      const at = now()
      const bucket = buckets.get(key)
      if (bucket && at - bucket.windowStart < THROTTLE_WINDOW_MS) {
        if (bucket.count >= THROTTLE_LIMIT) return false
        bucket.count += 1
        return true
      }
      buckets.delete(key)
      if (buckets.size >= THROTTLE_MAX_KEYS) evict(at)
      buckets.set(key, { windowStart: at, count: 1 })
      return true
    },
    size: () => buckets.size,
  }
}

/** The process-wide instance the server action uses. */
export const rsvpThrottle = createThrottle()

/** sha256(ip) hex + ':' + token — the only form in which an IP is kept. */
export function rsvpThrottleKey(ip: string, token: string): string {
  return `${createHash('sha256').update(ip).digest('hex')}:${token}`
}

/**
 * Best-effort client IP for the throttle key: x-real-ip, else the leftmost
 * x-forwarded-for entry, trimmed. Advisory (headers can be spoofed off-Vercel);
 * null when absent, and the caller then skips the throttle.
 */
export async function getRsvpClientIp(): Promise<string | null> {
  const h = await headers()
  const realIp = h.get('x-real-ip')?.trim()
  if (realIp) return realIp
  const forwarded = h.get('x-forwarded-for')?.split(',')[0]?.trim()
  return forwarded ? forwarded : null
}
