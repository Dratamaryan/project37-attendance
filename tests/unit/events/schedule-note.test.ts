// S9.5-T5.5 — resolveScheduleNote: ID prefers the ID note, EN the EN note,
// each falling back to the other; blank → null.
import { describe, it, expect } from 'vitest'
import { resolveScheduleNote } from '@/lib/events/schedule-note'

describe('resolveScheduleNote', () => {
  it.each([
    ['en', 'id', 'id', 'id'],
    ['en', 'id', 'en', 'en'],
    [null, 'id', 'en', 'id'],
    ['en', null, 'id', 'en'],
    [null, null, 'id', null],
    ['  ', '', 'en', null],
    [' en ', undefined, 'id', 'en'],
  ] as const)('(%s, %s, %s) → %s', (noteEn, noteId, locale, expected) => {
    expect(resolveScheduleNote(noteEn, noteId, locale)).toBe(expected)
  })
})
