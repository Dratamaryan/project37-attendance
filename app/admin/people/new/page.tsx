import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { NotAuthorized } from '@/app/admin/_components/not-authorized'
import { requireActiveAdmin } from '@/lib/auth/require-admin'
import { AddPersonForm } from './add-person-form'

export default async function AdminAddPersonPage() {
  const supabase = await createClient()
  const authResult = await requireActiveAdmin(supabase)

  if (authResult.status === 'unauthenticated') redirect('/login')
  if (authResult.status === 'denied') return <NotAuthorized />

  return (
    <main className="px-4 md:px-6 py-8">
      <div className="max-w-2xl mx-auto">
        <AddPersonForm />
      </div>
    </main>
  )
}
