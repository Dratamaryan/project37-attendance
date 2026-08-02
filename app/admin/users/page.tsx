import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { NotAuthorized } from '@/app/admin/_components/not-authorized'
import { requireActiveAdmin } from '@/lib/auth/require-admin'
import { listAppUsers } from '@/lib/actions/admin-users'
import { UsersClient } from './users-client'

// Admin-only (T5-02 pattern) — no data is fetched until the guard passes, so
// an organizer never sees so much as a loading state for this list.
export default async function AdminUsersPage() {
  const supabase = await createClient()
  const authResult = await requireActiveAdmin(supabase)

  if (authResult.status === 'unauthenticated') redirect('/login')
  if (authResult.status === 'denied') return <NotAuthorized />

  const t = await getTranslations('admin.users')
  const result = await listAppUsers()
  const users = result.status === 'ok' ? result.users : []

  return (
    <main className="px-4 md:px-6 py-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <div>
          <h1 className="font-heading text-3xl font-semibold text-charcoal">
            {t('title')}
          </h1>
          <p className="text-sm text-muted mt-1">{t('subtitle')}</p>
        </div>
        <UsersClient
          initialUsers={users}
          currentUserId={authResult.actorId}
          loadError={result.status === 'error'}
        />
      </div>
    </main>
  )
}
