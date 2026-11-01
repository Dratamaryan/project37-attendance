import 'server-only'
// Helpers for the S9-R3 "Share via WhatsApp" link. Server-only: they bundle
// both locale files, so the admin instance page builds the share URLs and
// passes them down — Client Components never import this.

import { formatInTimeZone } from 'date-fns-tz'
import { enUS, id as idLocale } from 'date-fns/locale'
import { createTranslator } from 'next-intl'
import en from '@/messages/en.json'
import id from '@/messages/id.json'
import { JAKARTA_TZ } from '@/lib/events/timezone'

export type ShareLocale = 'id' | 'en'

const MESSAGES = { en, id } as const

const DATE_LABEL: Record<ShareLocale, { format: string; locale: typeof enUS }> = {
  id: { format: 'EEEE, d MMMM yyyy HH.mm', locale: idLocale },     // Sabtu, 24 Oktober 2026 18.00
  en: { format: 'EEEE, MMMM d, yyyy h:mm a', locale: enUS },       // Saturday, October 24, 2026 6:00 PM
}

/** The instance's start time as the share message shows it — WIB, per language. */
export function formatShareDateLabel(scheduledAt: Date, locale: ShareLocale): string {
  const { format, locale: dfLocale } = DATE_LABEL[locale]
  return formatInTimeZone(scheduledAt, JAKARTA_TZ, format, { locale: dfLocale })
}

/**
 * wa.me share URL whose prefilled text invites the reader to RSVP. The text
 * comes from admin.events.instance.rsvp.whatsapp_message in the given locale;
 * everything after `?text=` is a single encodeURIComponent'd string.
 * S9.5-T5.5: with a schedule note (already resolved for `locale`), the text is
 * whatsapp_message_with_note instead — the note on its own line after the
 * line carrying the date/time, then the URL on its own line.
 */
export function buildWhatsAppShareUrl(
  { eventName, dateLabel, url, locale, scheduleNote = null }:
  { eventName: string; dateLabel: string; url: string; locale: ShareLocale; scheduleNote?: string | null },
): string {
  const t = createTranslator({
    locale,
    messages: MESSAGES[locale],
    namespace: 'admin.events.instance.rsvp',
  })
  const note = scheduleNote?.trim()
  const message = note
    ? t('whatsapp_message_with_note', { event: eventName, date: dateLabel, note, url })
    : t('whatsapp_message', { event: eventName, date: dateLabel, url })
  return `https://wa.me/?text=${encodeURIComponent(message)}`
}
