// Unit tests for the S9-R4 in-memory RSVP throttle (lib/rsvp/throttle.ts):
// fixed window with a fake clock, key-map cap eviction, the hashed key, and
// the client-IP helper. Live behaviour across Fluid Compute instances is not
// deterministically testable — this file is the verification rung.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'crypto'

vi.mock('server-only', () => ({}))

let mockHeaders: Record<string, string> = {}
vi.mock('next/headers', () => ({
  headers: async () => new Headers(mockHeaders),
}))

import {
  THROTTLE_LIMIT,
  THROTTLE_MAX_KEYS,
  THROTTLE_WINDOW_MS,
  createThrottle,
  getRsvpClientIp,
  rsvpThrottleKey,
} from '../throttle'

beforeEach(() => {
  mockHeaders = {}
})

function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

describe('createThrottle — fixed window', () => {
  it('constants: 20 per 10 minutes, 5000 keys', () => {
    expect(THROTTLE_LIMIT).toBe(20)
    expect(THROTTLE_WINDOW_MS).toBe(10 * 60 * 1000)
    expect(THROTTLE_MAX_KEYS).toBe(5000)
  })

  it('20 allowed, 21st blocked, other keys unaffected', () => {
    const c = clock()
    const th = createThrottle(c.now)
    for (let i = 0; i < THROTTLE_LIMIT; i++) expect(th.checkAndCount('a')).toBe(true)
    expect(th.checkAndCount('a')).toBe(false)
    expect(th.checkAndCount('a')).toBe(false)
    expect(th.checkAndCount('b')).toBe(true)
  })

  it('window resets at exactly 10 minutes, not before', () => {
    const c = clock()
    const th = createThrottle(c.now)
    for (let i = 0; i < THROTTLE_LIMIT; i++) th.checkAndCount('a')
    c.advance(THROTTLE_WINDOW_MS - 1)
    expect(th.checkAndCount('a')).toBe(false)
    c.advance(1)
    for (let i = 0; i < THROTTLE_LIMIT; i++) expect(th.checkAndCount('a')).toBe(true)
    expect(th.checkAndCount('a')).toBe(false)
  })

  it('blocked attempts do not extend the window', () => {
    const c = clock()
    const th = createThrottle(c.now)
    for (let i = 0; i < THROTTLE_LIMIT; i++) th.checkAndCount('a')
    c.advance(THROTTLE_WINDOW_MS / 2)
    expect(th.checkAndCount('a')).toBe(false)
    c.advance(THROTTLE_WINDOW_MS / 2)
    expect(th.checkAndCount('a')).toBe(true)
  })
})

describe('createThrottle — map cap', () => {
  it('at the cap, expired keys are dropped first', () => {
    const c = clock()
    const th = createThrottle(c.now)
    th.checkAndCount('old')
    c.advance(THROTTLE_WINDOW_MS)
    for (let i = 1; i < THROTTLE_MAX_KEYS; i++) th.checkAndCount(`k${i}`)
    expect(th.size()).toBe(THROTTLE_MAX_KEYS)

    th.checkAndCount('new')
    expect(th.size()).toBe(THROTTLE_MAX_KEYS)
    // k1 (the oldest live key) survived: its next call is its 2nd, not a fresh bucket.
    for (let i = 0; i < THROTTLE_LIMIT - 1; i++) th.checkAndCount('k1')
    expect(th.checkAndCount('k1')).toBe(false)
  })

  it('at the cap with nothing expired, the oldest key is evicted', () => {
    const c = clock()
    const th = createThrottle(c.now)
    for (let i = 0; i < THROTTLE_LIMIT; i++) th.checkAndCount('k0')
    expect(th.checkAndCount('k0')).toBe(false)
    for (let i = 1; i < THROTTLE_MAX_KEYS; i++) th.checkAndCount(`k${i}`)

    th.checkAndCount('new')
    expect(th.size()).toBe(THROTTLE_MAX_KEYS)
    // k0 was evicted, so it starts a fresh bucket.
    expect(th.checkAndCount('k0')).toBe(true)
    expect(th.size()).toBe(THROTTLE_MAX_KEYS)
  })
})

describe('rsvpThrottleKey', () => {
  it('sha256(ip) hex + ":" + token; never contains the raw IP', () => {
    const key = rsvpThrottleKey('203.0.113.9', 'tok_ABC')
    expect(key).toBe(`${createHash('sha256').update('203.0.113.9').digest('hex')}:tok_ABC`)
    expect(key).toMatch(/^[0-9a-f]{64}:tok_ABC$/)
    expect(key).not.toContain('203.0.113.9')
    expect(rsvpThrottleKey('203.0.113.9', 'tok_ABC')).toBe(key)
    expect(rsvpThrottleKey('203.0.113.10', 'tok_ABC')).not.toBe(key)
  })
})

describe('getRsvpClientIp', () => {
  it('prefers x-real-ip (trimmed)', async () => {
    mockHeaders = { 'x-real-ip': ' 198.51.100.1 ', 'x-forwarded-for': '203.0.113.7' }
    expect(await getRsvpClientIp()).toBe('198.51.100.1')
  })

  it('falls back to the leftmost x-forwarded-for entry', async () => {
    mockHeaders = { 'x-forwarded-for': ' 203.0.113.7 , 10.0.0.1' }
    expect(await getRsvpClientIp()).toBe('203.0.113.7')
  })

  it.each([[{}], [{ 'x-real-ip': '  ' }], [{ 'x-forwarded-for': ' , 10.0.0.1' }]])('%j -> null', async (h) => {
    mockHeaders = h
    expect(await getRsvpClientIp()).toBeNull()
  })
})
