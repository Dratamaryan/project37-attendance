import Link from 'next/link'

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

  return (
    <main className="min-h-screen flex items-center justify-center bg-[#0F0F0F]">
      <div className="w-full max-w-sm px-6 py-8 rounded-2xl bg-white/5 border border-white/10 text-center">
        <h1 className="text-xl font-semibold text-white mb-3">
          {/* TODO: i18n */}
          {isConfigDrift
            ? 'Sign-in link format is incorrect'
            : isInvalidLink
              ? 'Invalid sign-in link'
              : 'Sign-in link no longer valid'}
        </h1>
        <p className="text-sm text-white/60 mb-6 leading-relaxed">
          {/* TODO: i18n */}
          {isConfigDrift
            ? 'Please contact the administrator — the Supabase email template needs to be updated.'
            : isInvalidLink
              ? 'The link is missing required parameters. Try clicking it directly from your email, or request a new one.'
              : isOtpError
                ? 'This link has either expired (valid for 1 hour) or already been used — each link works only once. Please request a new one.'
                : 'Something went wrong with your sign-in link. Please request a new one.'}
        </p>
        <Link
          href="/login"
          className="inline-block rounded-lg bg-[#A8924A] px-6 py-2.5 text-sm font-medium text-[#0F0F0F] hover:bg-[#9a8444] transition-colors"
        >
          {/* TODO: i18n */}
          Back to sign in
        </Link>
      </div>
    </main>
  )
}
