// Pure bilingual invite-email renderer (F/3). No Supabase imports, no I/O —
// fully unit-testable. Callers (T9) resolve event_instances + events fields
// before calling in, and attach the .ics separately as a message-level
// attachment (see lib/email/transport.ts EmailMessage.attachments) — it is
// not part of this render.

import { formatJakarta } from '@/lib/events/timezone'

export interface InviteEmailInput {
  /** events.name — always present. */
  eventNameEn: string
  /** event_instances.event_name_snapshot_id — nullable; falls back to EN when absent. */
  eventNameId: string | null
  /** event_instances.scheduled_at — UTC instant. */
  scheduledAt: Date
  /** events.duration_min. */
  durationMin: number
  /** events.location — nullable; real prod rows have this null today (T7 finding). */
  location: string | null
}

export interface RenderedEmail {
  subject: string
  html: string
  text: string
}

const DATE_FORMAT = "d MMMM yyyy '·' HH:mm 'WIB'"

const OPT_OUT_ID =
  'Balas email ini jika tidak ingin menerima undangan.'
const OPT_OUT_EN =
  "Reply to this email if you'd rather not receive invitations."

const LOCATION_FALLBACK_ID = 'Lokasi akan diinformasikan kemudian'
const LOCATION_FALLBACK_EN = 'Location to be announced'

/**
 * Renders the single bilingual invite email: Indonesian block first, English
 * block below, one-line opt-out in both (F/3 — there is no per-recipient
 * language signal, so every email always carries both).
 */
export function renderInviteEmail(input: InviteEmailInput): RenderedEmail {
  const nameId = input.eventNameId ?? input.eventNameEn
  const nameEn = input.eventNameEn
  const when = formatJakarta(input.scheduledAt, DATE_FORMAT)
  const locationId = input.location ?? LOCATION_FALLBACK_ID
  const locationEn = input.location ?? LOCATION_FALLBACK_EN

  const subject = `Undangan: ${nameId} / Invitation: ${nameEn} — Project 37`

  const html = [
    `<div>`,
    `<h2>Undangan: ${nameId}</h2>`,
    `<p>Tanggal: ${when}</p>`,
    `<p>Lokasi: ${locationId}</p>`,
    `<p>${OPT_OUT_ID}</p>`,
    `<hr/>`,
    `<h2>Invitation: ${nameEn}</h2>`,
    `<p>Date: ${when}</p>`,
    `<p>Location: ${locationEn}</p>`,
    `<p>${OPT_OUT_EN}</p>`,
    `</div>`,
  ].join('\n')

  const text = [
    `Undangan: ${nameId}`,
    `Tanggal: ${when}`,
    `Lokasi: ${locationId}`,
    OPT_OUT_ID,
    '---',
    `Invitation: ${nameEn}`,
    `Date: ${when}`,
    `Location: ${locationEn}`,
    OPT_OUT_EN,
  ].join('\n')

  return { subject, html, text }
}
