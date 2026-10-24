// Unit tests for the S9-R3 RSVP config helpers in admin.impl.ts:
// isRsvpPublicEnabled (server-only go-live flag) and buildRsvpUrl
// (NEXT_PUBLIC_APP_URL-only absolute URL, never request headers).
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('server-only', () => ({}))

import { buildRsvpUrl, isRsvpPublicEnabled } from '../admin.impl'
import { getRsvpGateSecret, isRsvpPublicEnabled as configIsRsvpPublicEnabled } from '../config'

const ORIGINAL_FLAG = process.env.RSVP_PUBLIC_ENABLED
const ORIGINAL_URL = process.env.NEXT_PUBLIC_APP_URL
const ORIGINAL_GATE = process.env.RSVP_GATE_SECRET

function setEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

afterEach(() => {
  setEnv('RSVP_PUBLIC_ENABLED', ORIGINAL_FLAG)
  setEnv('NEXT_PUBLIC_APP_URL', ORIGINAL_URL)
  setEnv('RSVP_GATE_SECRET', ORIGINAL_GATE)
})

describe('lib/rsvp/config', () => {
  it('admin.impl re-exports the same isRsvpPublicEnabled', () => {
    expect(isRsvpPublicEnabled).toBe(configIsRsvpPublicEnabled)
  })

  it.each([
    ['abc', 'abc'],
    ['  abc  ', 'abc'],
    ['', null],
    ['   ', null],
    [undefined, null],
  ])('RSVP_GATE_SECRET=%j -> %j', (value, expected) => {
    setEnv('RSVP_GATE_SECRET', value)
    expect(getRsvpGateSecret()).toBe(expected)
  })
})

describe('isRsvpPublicEnabled', () => {
  it.each([
    ['true', true],
    ['TRUE', true],
    [' True ', true],
    ['false', false],
    ['FALSE', false],
    ['', false],
    [undefined, false],
    ['yes', false],
  ])('RSVP_PUBLIC_ENABLED=%j -> %s', (value, expected) => {
    setEnv('RSVP_PUBLIC_ENABLED', value)
    expect(isRsvpPublicEnabled()).toBe(expected)
  })
})

describe('buildRsvpUrl', () => {
  it('joins the app origin and /rsvp/<token>', () => {
    setEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.com')
    expect(buildRsvpUrl('abc_DEF-123')).toBe('https://app.example.com/rsvp/abc_DEF-123')
  })

  it('trailing slash / path on the base is reduced to the origin', () => {
    setEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000/')
    expect(buildRsvpUrl('t')).toBe('http://localhost:3000/rsvp/t')
    setEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.com/some/path?q=1')
    expect(buildRsvpUrl('t')).toBe('https://app.example.com/rsvp/t')
  })

  it('token is URL-encoded', () => {
    setEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.com')
    expect(buildRsvpUrl('a/b?c')).toBe('https://app.example.com/rsvp/a%2Fb%3Fc')
  })

  it.each([
    [undefined],
    [''],
    ['not a url'],
    ['app.example.com'],
    ['ftp://app.example.com'],
    ['javascript:alert(1)'],
  ])('NEXT_PUBLIC_APP_URL=%j -> misconfigured', value => {
    setEnv('NEXT_PUBLIC_APP_URL', value)
    expect(buildRsvpUrl('t')).toBe('misconfigured')
  })
})
