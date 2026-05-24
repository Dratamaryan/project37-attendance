import Link from 'next/link'
import { getTranslations } from 'next-intl/server'

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
    <main className="min-h-screen flex items-center justify-center bg-[#0F0F0F]">
      <div className="w-full max-w-sm px-6 py-8 rounded-2xl bg-white/5 border border-white/10 text-center">
        <h1 className="text-xl font-semibold text-white mb-3">
          {t(`${errorKey}.title`)}
        </h1>
        <p className="text-sm text-white/60 mb-6 leading-relaxed">
          {t(`${errorKey}.body`)}
        </p>
        <Link
          href="/login"
          className="inline-block rounded-lg bg-[#A8924A] px-6 py-2.5 text-sm font-medium text-[#0F0F0F] hover:bg-[#9a8444] transition-colors"
        >
          {t('backToSignIn')}
        </Link>
      </div>
    </main>
  )
}
