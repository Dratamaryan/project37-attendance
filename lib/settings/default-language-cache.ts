import 'server-only'

import { createClient } from '@supabase/supabase-js'
import { unstable_cache } from 'next/cache'
import { DEFAULT_LANGUAGE_CACHE_TAG } from './constants'

export { DEFAULT_LANGUAGE_CACHE_TAG }

const FALLBACK = 'id'
const REVALIDATE_SECONDS = 300

/**
 * A bare anon-key client, deliberately NOT lib/supabase/server.ts's
 * cookie-backed createClient(): this function is wrapped in unstable_cache
 * and must return the same result regardless of which visitor's request
 * triggered the cache miss. Pulling next/headers cookies() into
 * cached-function scope would be a Next.js dynamic-API-in-cache misuse, and
 * is unnecessary here — get_default_language() is granted to anon and
 * returns a single global value, not anything user-specific.
 */
function createAnonRpcClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!url || !key) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY env vars.')
  }

  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

const readDefaultLanguage = unstable_cache(
  async (): Promise<string> => {
    const client = createAnonRpcClient()
    const { data, error } = await client.rpc('get_default_language')

    if (error || typeof data !== 'string' || !data) {
      console.warn(
        '[default-language-cache] read failed, falling back to', FALLBACK, error?.message,
      )
      return FALLBACK
    }

    return data
  },
  ['app-settings-default-language'],
  { revalidate: REVALIDATE_SECONDS, tags: [DEFAULT_LANGUAGE_CACHE_TAG] },
)

/**
 * Deliberate loud-fail EXCEPTION: on any read error, fall back silently to
 * 'id' rather than throwing. This runs on every cookie-less page render
 * (including public check-in/login) — failing the entire page render because
 * a cosmetic locale-default lookup hiccuped would be disproportionate.
 */
export async function getCachedDefaultLanguage(): Promise<string> {
  try {
    return await readDefaultLanguage()
  } catch (err) {
    console.warn('[default-language-cache] unexpected error, falling back to', FALLBACK, err)
    return FALLBACK
  }
}
