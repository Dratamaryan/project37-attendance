// app/actions/locale.ts setLocale (S9-R6 D6): redirectTo is honoured only as a
// same-origin path; anything else — protocol-relative, backslash, absolute,
// empty, missing — falls back to '/'.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const setCookie = vi.fn()
vi.mock('next/headers', () => ({
  cookies: async () => ({ set: setCookie }),
}))

const redirect = vi.fn()
vi.mock('next/navigation', () => ({
  redirect: (to: string) => redirect(to),
}))

import { setLocale } from '@/app/actions/locale'

function form(redirectTo?: string): FormData {
  const fd = new FormData()
  fd.set('locale', 'en')
  if (redirectTo !== undefined) fd.set('redirectTo', redirectTo)
  return fd
}

beforeEach(() => {
  setCookie.mockClear()
  redirect.mockClear()
})

describe('setLocale redirectTo', () => {
  it("'/rsvp/x' is accepted", async () => {
    await setLocale(form('/rsvp/x'))
    expect(redirect).toHaveBeenCalledWith('/rsvp/x')
    expect(setCookie).toHaveBeenCalledWith('locale', 'en', expect.objectContaining({ path: '/' }))
  })

  for (const [label, value] of [
    ["'//evil.com'", '//evil.com'],
    ["'/\\evil.com'", '/\\evil.com'],
    ["'https://evil.com'", 'https://evil.com'],
    ["''", ''],
    ['undefined', undefined],
  ] as const) {
    it(`${label} falls back to '/'`, async () => {
      await setLocale(form(value))
      expect(redirect).toHaveBeenCalledWith('/')
    })
  }

  it('unsupported locale: no cookie, no redirect (unchanged)', async () => {
    const fd = form('/rsvp/x')
    fd.set('locale', 'fr')
    await setLocale(fd)
    expect(setCookie).not.toHaveBeenCalled()
    expect(redirect).not.toHaveBeenCalled()
  })
})
