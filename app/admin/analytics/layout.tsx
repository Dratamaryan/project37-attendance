import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { type ReactNode } from 'react'

// Admin-only guard — AppTopbar + bottom-tab nav are inherited from /admin/layout.tsx.
export default async function AdminAnalyticsLayout({ children }: { children: ReactNode }) {
  const supabase = await createClient()
  const { data } = await supabase.auth.getClaims()

  if (!data) redirect('/login')

  const { data: appUser } = await supabase
    .from('app_users')
    .select('role')
    .eq('id', data.claims.sub)
    .single()

  if (appUser?.role !== 'admin') {
    redirect('/dashboard')
  }

  return <>{children}</>
}
