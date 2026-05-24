'use server'

import { createClient } from '@/lib/supabase/server'

type State = { message: string | null }

// Minimum response time in ms. Both the Supabase call and this timer run concurrently;
// the action returns when both complete. This eliminates the timing side-channel that
// would otherwise let an attacker distinguish registered from unregistered emails by
// measuring response latency (registered: ~3-4s, unregistered: ~100ms without the floor).
const MIN_RESPONSE_MS = 3000

export async function sendMagicLink(_prevState: State, formData: FormData): Promise<State> {
  const email = (formData.get('email') as string | null)?.trim() ?? ''
  if (!email) return { message: null }

  const supabase = await createClient()

  await Promise.all([
    supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/confirm`,
        shouldCreateUser: false,
      },
    }),
    new Promise<void>(resolve => setTimeout(resolve, MIN_RESPONSE_MS)),
  ])

  // Always return the same message regardless of whether the email exists — no user enumeration.
  // TODO: i18n
  return {
    message:
      'If that email is registered, a sign-in link is on its way. Check your inbox (and spam folder if needed).',
  }
}
