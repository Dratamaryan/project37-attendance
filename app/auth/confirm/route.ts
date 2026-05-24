/**
 * Magic link callback for @supabase/ssr.
 *
 * Expected URL format (sent by Supabase when email template is configured correctly):
 *   /auth/confirm?token_hash={{ .TokenHash }}&type=magiclink
 *
 * PREREQUISITE — Supabase Dashboard → Authentication → Email Templates → Magic Link
 * MUST use this exact template body:
 *   <a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=magiclink">Sign in</a>
 *
 * The default {{ .ConfirmationURL }} generates a legacy /auth/v1/verify redirect URL
 * that does NOT work with this route. If you see ?code= in the URL, the email template
 * has drifted to the default — fix it in Supabase Dashboard, not here.
 */

import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import type { EmailOtpType } from '@supabase/supabase-js'

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl
  const tokenHash = searchParams.get('token_hash')
  const type = searchParams.get('type') as EmailOtpType | null

  // Defensive: flag unexpected URL formats that indicate Supabase config drift.
  if (searchParams.get('code') && !tokenHash) {
    console.error(
      '[auth/confirm] Received ?code= parameter. This indicates the Supabase email template ' +
        'is using {{ .ConfirmationURL }} instead of the required {{ .TokenHash }} format. ' +
        'Update the email template in Supabase Dashboard → Auth → Email Templates → Magic Link.'
    )
    return NextResponse.redirect(new URL('/auth/error?reason=config_drift', origin))
  }

  if (!tokenHash || !type) {
    return NextResponse.redirect(new URL('/auth/error?reason=invalid_link', origin))
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash })

  if (error) {
    const reason = error.code ?? 'otp_expired'
    return NextResponse.redirect(new URL(`/auth/error?reason=${encodeURIComponent(reason)}`, origin))
  }

  return NextResponse.redirect(new URL('/dashboard', origin))
}
