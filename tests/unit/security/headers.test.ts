// next.config.ts headers() (S9-R6 D5): exactly three security headers on every
// path — X-Frame-Options DENY, CSP frame-ancestors 'none' (and no other CSP
// directive), X-Content-Type-Options nosniff. No Referrer-Policy.
import { describe, it, expect } from 'vitest'
import nextConfig from '@/next.config'

describe('next.config security headers', () => {
  it("emits exactly the three headers for source '/:path*'", async () => {
    expect(nextConfig.headers).toBeTypeOf('function')
    const rules = await nextConfig.headers!()
    expect(rules).toEqual([
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
        ],
      },
    ])
  })
})
