// Integration test for S6-T8 — proves /privacy is reachable WITHOUT
// authentication. A privacy policy gated behind /login is broken, so this is
// the #1 correctness gate for the feature: an unauthenticated GET /privacy
// must pass through proxy.ts untouched (no redirect to /login), while a
// genuinely protected route (e.g. /dashboard) still redirects as before —
// proving this test would actually catch a regression, not just trivially pass.
//
// Exercises the real proxy() function against local Docker Supabase (same
// convention as the rest of tests/integration — see setupTests.ts's
// production-ref guard).

import { NextRequest } from 'next/server'
import { describe, it, expect } from 'vitest'
import { proxy } from '@/proxy'

describe('proxy — public vs protected routes', () => {
  it('does NOT redirect an unauthenticated GET /privacy', async () => {
    const req = new NextRequest('http://localhost/privacy')
    const res = await proxy(req)

    expect(res.headers.get('location')).toBeNull()
    expect([307, 308]).not.toContain(res.status)
  })

  it('DOES redirect an unauthenticated GET /dashboard to /login (control case)', async () => {
    const req = new NextRequest('http://localhost/dashboard')
    const res = await proxy(req)

    expect(res.status).toBe(307)
    const location = res.headers.get('location')
    expect(location).toBeTruthy()
    expect(new URL(location!).pathname).toBe('/login')
  })
})
