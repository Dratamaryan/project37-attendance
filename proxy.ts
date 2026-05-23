import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

// Next.js 16 renamed middleware.ts → proxy.ts and the export → proxy().
// This proxy runs on every non-static request to refresh Supabase auth tokens.
export async function proxy(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  // Always create a new client per request — never reuse across requests.
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet, headers) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
          // Forward cache-control headers Supabase sets to prevent CDN caching sessions.
          Object.entries(headers).forEach(([key, value]) =>
            supabaseResponse.headers.set(key, value)
          )
        },
      },
    }
  )

  // Validates and refreshes the access token. Must run before any page logic.
  // Do not put code between createServerClient and getClaims().
  await supabase.auth.getClaims()

  // IMPORTANT: return supabaseResponse as-is, or copy cookies if creating a
  // new response. Failing to do so will desync browser/server sessions.
  return supabaseResponse
}

export const config = {
  matcher: [
    // Skip Next.js internals, static files, and common asset extensions.
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
