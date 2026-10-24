import 'server-only'

import { createClient } from '@supabase/supabase-js'

/**
 * A bare anon-key client with no cookies and no session — deliberately NOT
 * lib/supabase/server.ts's cookie-backed createClient(). Its only uses are the
 * anon-granted RPCs, which must behave the same for every visitor:
 *   - get_default_language()  (lib/settings/default-language-cache.ts — runs
 *     inside unstable_cache, where next/headers cookies() is not allowed)
 *   - get_rsvp_context() / submit_rsvp()  (lib/rsvp/public.impl.ts — EXECUTE
 *     is granted to anon only, NOT authenticated, so a signed-in admin opening
 *     a public RSVP link must still call them as anon)
 *
 * Server-only: the anon key is public, but keeping the client server-side
 * keeps the RSVP gate secret and the RPC surface off the client bundle.
 */
export function createAnonServerClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!url || !key) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY env vars.')
  }

  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}
