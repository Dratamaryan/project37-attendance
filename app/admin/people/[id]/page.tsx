import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { NotAuthorized } from '@/app/admin/_components/not-authorized'
import { PersonNotFound } from '@/app/admin/people/_components/person-not-found'
import { getPersonById } from '@/lib/actions/people'
import { listChildrenByParentForAdmin } from '@/lib/actions/children'
import { getPhotoSignedUrl } from '@/lib/storage/photos'
import { requireActiveAdmin } from '@/lib/auth/require-admin'
import { EditPersonForm } from './edit-person-form'
import { PersonChildrenSection } from '../person-children-section'

type Props = {
  params: Promise<{ id: string }>
}

export default async function AdminPersonEditPage({ params }: Props) {
  const { id } = await params

  const supabase = await createClient()
  const authResult = await requireActiveAdmin(supabase)

  if (authResult.status === 'unauthenticated') redirect('/login')
  if (authResult.status === 'denied') return <NotAuthorized />

  const result = await getPersonById(id)

  if (result.status === 'not_found' || result.status === 'not_authorized') {
    return <PersonNotFound />
  }

  if (result.status === 'error') {
    return <PersonNotFound />
  }

  const { person } = result

  // Resolve signed URL once server-side — avoids client-side N+1 on load.
  const urlResult = await getPhotoSignedUrl(person.photo_url)
  const signedPhotoUrl =
    urlResult.status === 'signed' || urlResult.status === 'legacy_url'
      ? urlResult.url
      : null

  // S8-T4b: initial children fetched server-side (non-deleted only, with notes —
  // admin path); the section re-fetches client-side after each mutation.
  const childrenResult = await listChildrenByParentForAdmin(person.id)
  const initialChildren = childrenResult.status === 'children' ? childrenResult.children : []
  const childrenLoadFailed =
    childrenResult.status === 'error' || childrenResult.status === 'invalid_input'

  return (
    <main className="px-4 md:px-6 py-8">
      <div className="max-w-2xl mx-auto">
        <EditPersonForm person={person} signedPhotoUrl={signedPhotoUrl} />
        <PersonChildrenSection
          parent={{ id: person.id, full_name: person.full_name, deleted_at: person.deleted_at }}
          initialChildren={initialChildren}
          initialLoadFailed={childrenLoadFailed}
        />
      </div>
    </main>
  )
}
