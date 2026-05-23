import 'server-only'

import { createClient } from '@supabase/supabase-js'

// Runtime guard: belt-and-suspenders alongside the `server-only` import.
if (typeof window !== 'undefined') {
  throw new Error(
    'lib/supabase/admin.ts was imported in a browser context. ' +
      'Only API routes, Server Actions, and scheduled functions may use the admin client.'
  )
}

export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.'
    )
  }

  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}
