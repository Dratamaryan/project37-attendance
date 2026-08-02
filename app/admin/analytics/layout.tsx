import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { type ReactNode } from 'react'
import { requireActiveAdmin } from '@/lib/auth/require-admin'

// Admin-only guard — AppTopbar + bottom-tab nav are inherited from /admin/layout.tsx.
export default async function AdminAnalyticsLayout({ children }: { children: ReactNode }) {
  const supabase = await createClient()
  const authResult = await requireActiveAdmin(supabase)

  if (authResult.status === 'unauthenticated') redirect('/login')
  if (authResult.status === 'denied') redirect('/dashboard')

  return <>{children}</>
}
