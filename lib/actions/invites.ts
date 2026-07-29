'use server'

// Route segment config is officially documented on page.tsx/layout.tsx/
// route.ts files (Vercel Route Segment Config docs) — a Server Action module
// on its own isn't a documented target for `maxDuration`. Exporting it here is
// defensive (harmless if Next.js ignores it), but is NOT a substitute for the
// real requirement: T10's page at
// app/admin/events/[id]/instances/[instanceId]/invite/page.tsx — the page that
// actually calls sendInvites() — MUST also export `maxDuration = 300`. Flagged
// explicitly rather than assumed; confirm in T10's own build/deploy check.
export const maxDuration = 300

import { createClient } from '../supabase/server'
import { getDefaultEmailTransport } from '@/lib/email/transport'
import { impl_resolveRecipients, impl_sendInvites, impl_resendInvite } from './invites.impl'
import type {
  RecipientFilter,
  ResolveRecipientsResult,
  SendInvitesResult,
  ResendInviteResult,
} from './invites.types'

// Deferred import — same server-only-under-Vitest pattern as
// getDefaultEmailTransport (T4/T5/T8): invites.ts is never loaded by Vitest
// (tests import invites.impl.ts directly), but matching the established
// pattern keeps the throw deferred to call time rather than module-load time.
async function getEmailIdentity() {
  const { getNotifySmtpConfig } = await import('@/lib/email/config')
  const config = getNotifySmtpConfig()
  return { organizerEmail: config.user, fromName: config.fromName, replyTo: config.replyTo }
}

export async function resolveRecipients(filter: RecipientFilter): Promise<ResolveRecipientsResult> {
  const supabase = await createClient()
  return impl_resolveRecipients({ supabase, filter })
}

export async function sendInvites(
  eventInstanceId: string,
  filter: RecipientFilter,
): Promise<SendInvitesResult> {
  const supabase = await createClient()
  const [transport, emailIdentity] = await Promise.all([getDefaultEmailTransport(), getEmailIdentity()])
  return impl_sendInvites({ supabase, transport, eventInstanceId, filter, emailIdentity })
}

export async function resendInvite(
  eventInstanceId: string,
  personId: string,
): Promise<ResendInviteResult> {
  const supabase = await createClient()
  const [transport, emailIdentity] = await Promise.all([getDefaultEmailTransport(), getEmailIdentity()])
  return impl_resendInvite({ supabase, transport, eventInstanceId, personId, emailIdentity })
}
