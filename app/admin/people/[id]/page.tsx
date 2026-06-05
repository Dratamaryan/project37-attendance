import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { NotAuthorized } from '@/app/admin/_components/not-authorized'
import { PersonNotFound } from '@/app/admin/people/_components/person-not-found'
import { getPersonById } from '@/lib/actions/people'
import { getPhotoSignedUrl } from '@/lib/storage/photos'
import { EditPersonForm } from './edit-person-form'

type Props = {
  params: Promise<{ id: string }>
}

export default async function AdminPersonEditPage({ params }: Props) {
  const { id } = await params

  const supabase = await createClient()
  const { data } = await supabase.auth.getClaims()

  if (!data) redirect('/login')

  const { data: appUser } = await supabase
    .from('app_users')
    .select('role')
    .eq('id', data.claims.sub)
    .single()

  if (appUser?.role !== 'admin') {
    return <NotAuthorized />
  }

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

  return (
    <main className="px-4 md:px-6 py-8">
      <div className="max-w-2xl mx-auto">
        <EditPersonForm person={person} signedPhotoUrl={signedPhotoUrl} />
      </div>
    </main>
  )
}
