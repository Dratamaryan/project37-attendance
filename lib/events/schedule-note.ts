// S9.5-T5.5 public schedule note (events.schedule_note / schedule_note_id).
// Pure — no Supabase or i18n imports; shared by the RSVP page view and the
// WhatsApp share text.

export type ScheduleNoteLocale = 'id' | 'en'

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * The note for a locale: ID prefers the ID note, EN the EN note, each falling
 * back to the other; null when neither is set.
 */
export function resolveScheduleNote(
  noteEn: string | null | undefined,
  noteId: string | null | undefined,
  locale: ScheduleNoteLocale,
): string | null {
  const en = nonEmpty(noteEn)
  const id = nonEmpty(noteId)
  return locale === 'id' ? (id ?? en) : (en ?? id)
}
