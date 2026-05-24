import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

// Protected routes — unauthenticated users are redirected to /login.
// Keep this list up to date as new top-level sections are added.
//   /dashboard  — main app shell
//   /admin      — admin-only management pages
//   /checkin    — volunteer check-in flow
const PROTECTED_PREFIXES = ['/dashboard', '/admin', '/checkin']
// Auth-only routes — authenticated users are redirected to /dashboard.
const AUTH_ONLY_PREFIXES = ['/login']

// Next.js 16 renamed middleware.ts → proxy.ts and the export → proxy().
// This proxy runs on every non-static request to refresh Supabase auth tokens
// and enforce route-level authentication.
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
  const { data } = await supabase.auth.getClaims()
  const isAuthenticated = !!data?.claims

  const { pathname } = request.nextUrl
  const isProtected = PROTECTED_PREFIXES.some(p => pathname.startsWith(p))
  const isAuthOnly = AUTH_ONLY_PREFIXES.some(p => pathname.startsWith(p))

  // Propagate any refreshed session cookies to redirect responses so the
  // browser/server token state stays in sync.
  function withCookies(response: NextResponse): NextResponse {
    for (const { name, value, ...options } of supabaseResponse.cookies.getAll()) {
      response.cookies.set(name, value, options)
    }
    return response
  }

  if (isProtected && !isAuthenticated) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return withCookies(NextResponse.redirect(url))
  }

  if (isAuthOnly && isAuthenticated) {
    const url = request.nextUrl.clone()
    url.pathname = '/dashboard'
    return withCookies(NextResponse.redirect(url))
  }

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
