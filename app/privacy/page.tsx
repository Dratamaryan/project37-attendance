import { getLocale } from 'next-intl/server'
import { PublicShell } from '@/components/PublicShell'
import { PolicyMarkdown } from '@/components/legal/PolicyMarkdown'
import { loadPrivacyPolicyContent } from './content'

export default async function PrivacyPage() {
  const locale = await getLocale()
  const content = await loadPrivacyPolicyContent(locale)

  return (
    <PublicShell>
      <main className="flex-1 w-full max-w-3xl mx-auto px-6 py-12">
        <PolicyMarkdown content={content} />
      </main>
    </PublicShell>
  )
}
