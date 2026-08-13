import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { PublicShell } from '@/components/PublicShell'
import { LoginForm } from './LoginForm'

export default async function LoginPage() {
  const t = await getTranslations('footer')

  return (
    <PublicShell>
      <main className="flex-1 flex items-center justify-center p-6">
        <LoginForm />
      </main>
      <footer className="py-6 text-center">
        <Link href="/privacy" className="text-xs text-muted hover:text-gold transition-colors">
          {t('privacyLink')}
        </Link>
      </footer>
    </PublicShell>
  )
}
