import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { DashboardLanding } from './dashboard-landing'

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data } = await supabase.auth.getClaims()

  if (!data) redirect('/login')

  const { data: appUser } = await supabase
    .from('app_users')
    .select('role, full_name')
    .eq('id', data.claims.sub)
    .single()

  const role = (appUser?.role as 'admin' | 'organizer') ?? 'organizer'
  const fullName = appUser?.full_name ?? null
  const email = data.claims.email ?? ''

  return <DashboardLanding role={role} fullName={fullName} email={email} />
}
