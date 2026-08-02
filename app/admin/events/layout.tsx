import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { type ReactNode } from 'react'
import { requireActiveRole } from '@/lib/auth/require-admin'

// Role gate: both admin and organizer may access /admin/events/*.
// AppTopbar is NOT rendered here — the parent /admin/layout.tsx already renders it.
export default async function AdminEventsLayout({ children }: { children: ReactNode }) {
  const supabase = await createClient()
  const authResult = await requireActiveRole(supabase, ['admin', 'organizer'])

  if (authResult.status === 'unauthenticated') redirect('/login')
  if (authResult.status === 'denied') redirect('/dashboard')

  return <>{children}</>
}
