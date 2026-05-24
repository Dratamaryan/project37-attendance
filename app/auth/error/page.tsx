import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { PublicShell } from '@/components/PublicShell'
import { Card } from '@/components/ui/Card'

type Props = {
  searchParams: Promise<{ reason?: string }>
}

export default async function AuthErrorPage({ searchParams }: Props) {
  const { reason } = await searchParams

  // Supabase returns 'otp_expired' for both TTL-exceeded and already-consumed tokens —
  // the API doesn't distinguish the two, so we surface both possibilities.
  const isOtpError = !reason || reason === 'otp_expired'
  const isInvalidLink = reason === 'invalid_link'
  const isConfigDrift = reason === 'config_drift'

  const t = await getTranslations('auth.error')

  const errorKey = isConfigDrift
    ? 'configDrift'
    : isInvalidLink
      ? 'invalidLink'
      : isOtpError
        ? 'otpExpired'
        : 'generic'

  return (
    <PublicShell>
      <main className="flex-1 flex items-center justify-center p-6">
        <Card className="w-full max-w-sm text-center">
          <h1 className="font-heading text-2xl font-semibold text-charcoal mb-3">
            {t(`${errorKey}.title`)}
          </h1>
          <p className="text-sm text-muted mb-6 leading-relaxed">
            {t(`${errorKey}.body`)}
          </p>
          <Link
            href="/login"
            className="inline-block rounded-lg bg-gold px-6 py-2.5 text-sm font-medium text-charcoal hover:bg-gold-dark transition-colors"
          >
            {t('backToSignIn')}
          </Link>
        </Card>
      </main>
    </PublicShell>
  )
}
