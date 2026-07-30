'use server'

// T9 exported `maxDuration = 300` here defensively, flagging it as unconfirmed
// (Vercel's Route Segment Config docs only document this export on
// page.tsx/layout.tsx/route.ts, not a 'use server' action module). T10 found
// it's worse than unconfirmed: once a Client Component (InvitePanel) imports
// these actions, Next.js must bundle this module for the client, and its
// "use server" files may only export async functions" rule rejects the
// non-function export outright — `next build` fails. Removed. The governing
// export is on the page that actually invokes sendInvites():
// app/admin/events/[id]/instances/[instanceId]/invite/page.tsx.
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
