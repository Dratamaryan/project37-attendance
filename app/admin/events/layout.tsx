import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { type ReactNode } from 'react'

// Role gate: both admin and organizer may access /admin/events/*.
// AppTopbar is NOT rendered here — the parent /admin/layout.tsx already renders it.
export default async function AdminEventsLayout({ children }: { children: ReactNode }) {
  const supabase = await createClient()
  const { data } = await supabase.auth.getClaims()

  if (!data) redirect('/login')

  const { data: appUser } = await supabase
    .from('app_users')
    .select('role')
    .eq('id', data.claims.sub)
    .single()

  const role = appUser?.role
  if (role !== 'admin' && role !== 'organizer') {
    redirect('/dashboard')
  }

  return <>{children}</>
}
