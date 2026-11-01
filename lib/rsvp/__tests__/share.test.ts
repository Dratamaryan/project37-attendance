// Unit tests for the S9-R3 WhatsApp share helpers: buildWhatsAppShareUrl
// (wa.me URL whose text is the localized whatsapp_message, encoded as a
// single query value) and formatShareDateLabel (WIB, per language).
import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { buildWhatsAppShareUrl, formatShareDateLabel } from '../share'

const PREFIX = 'https://wa.me/?text='
const URL_ = 'https://app.example.com/rsvp/abc_DEF-123'
// 2026-10-24T11:00Z = Saturday 24 October 2026, 18:00 WIB
const SCHEDULED_AT = new Date('2026-10-24T11:00:00Z')

function decodedText(shareUrl: string): string {
  expect(shareUrl.startsWith(PREFIX)).toBe(true)
  return decodeURIComponent(shareUrl.slice(PREFIX.length))
}

describe('formatShareDateLabel', () => {
  it('id: Indonesian day/month names, 24-hour HH.mm, in WIB', () => {
    expect(formatShareDateLabel(SCHEDULED_AT, 'id')).toBe('Sabtu, 24 Oktober 2026 18.00')
  })

  it('en: English day/month names, 12-hour clock, in WIB', () => {
    expect(formatShareDateLabel(SCHEDULED_AT, 'en')).toBe('Saturday, October 24, 2026 6:00 PM')
  })

  it('uses Asia/Jakarta, not UTC: 2026-10-24T20:00Z is already Sunday in WIB', () => {
    expect(formatShareDateLabel(new Date('2026-10-24T20:00:00Z'), 'id')).toBe('Minggu, 25 Oktober 2026 03.00')
  })
})

describe('buildWhatsAppShareUrl', () => {
  it('ID message with the ID date label', () => {
    const dateLabel = formatShareDateLabel(SCHEDULED_AT, 'id')
    const out = buildWhatsAppShareUrl({ eventName: 'Ibadah Jumat', dateLabel, url: URL_, locale: 'id' })
    expect(decodedText(out))
      .toBe(`Mohon konfirmasi kehadiran untuk Ibadah Jumat (Sabtu, 24 Oktober 2026 18.00): ${URL_}`)
  })

  it('EN message with the EN date label', () => {
    const dateLabel = formatShareDateLabel(SCHEDULED_AT, 'en')
    const out = buildWhatsAppShareUrl({ eventName: 'Friday Service', dateLabel, url: URL_, locale: 'en' })
    expect(decodedText(out))
      .toBe(`Please confirm your attendance for Friday Service (Saturday, October 24, 2026 6:00 PM): ${URL_}`)
  })

  it('the whole message is one encoded value: & ? # = + and spaces cannot break out of text=', () => {
    const out = buildWhatsAppShareUrl({
      eventName: 'Q&A + Praise #1 ?x=y',
      dateLabel: '24/10',
      url: 'https://app.example.com/rsvp/a?b=c&d=e',
      locale: 'en',
    })
    const encoded = out.slice(PREFIX.length)
    expect(encoded).not.toMatch(/[ &?#=+]/)
    expect(new URL(out).searchParams.get('text'))
      .toBe('Please confirm your attendance for Q&A + Praise #1 ?x=y (24/10): https://app.example.com/rsvp/a?b=c&d=e')
    expect([...new URL(out).searchParams.keys()]).toEqual(['text'])
  })

  it('non-ASCII event names round-trip', () => {
    const out = buildWhatsAppShareUrl({ eventName: 'Natal — Café', dateLabel: '25 Des', url: URL_, locale: 'id' })
    expect(decodedText(out)).toContain('Natal — Café (25 Des)')
  })
})

describe('buildWhatsAppShareUrl — schedule note (S9.5-T5.5)', () => {
  const NOTE_ID = '15.00 snack & kopi · 16.00 Project Day dimulai'
  const NOTE_EN = '15:00 snacks & coffee · 16:00 Project Day starts'

  it('ID: note on its own line after the date/time line, URL on the last line', () => {
    const dateLabel = formatShareDateLabel(SCHEDULED_AT, 'id')
    const out = buildWhatsAppShareUrl({ eventName: 'Project Day', dateLabel, url: URL_, locale: 'id', scheduleNote: NOTE_ID })
    expect(decodedText(out)).toBe(
      `Mohon konfirmasi kehadiran untuk Project Day (Sabtu, 24 Oktober 2026 18.00)\n${NOTE_ID}\n${URL_}`,
    )
  })

  it('EN: same shape with the EN note', () => {
    const dateLabel = formatShareDateLabel(SCHEDULED_AT, 'en')
    const out = buildWhatsAppShareUrl({ eventName: 'Project Day', dateLabel, url: URL_, locale: 'en', scheduleNote: NOTE_EN })
    expect(decodedText(out)).toBe(
      `Please confirm your attendance for Project Day (Saturday, October 24, 2026 6:00 PM)\n${NOTE_EN}\n${URL_}`,
    )
  })

  it('null / blank note → the original single-line message', () => {
    const dateLabel = formatShareDateLabel(SCHEDULED_AT, 'id')
    for (const scheduleNote of [null, undefined, '   ']) {
      const out = buildWhatsAppShareUrl({ eventName: 'Project Day', dateLabel, url: URL_, locale: 'id', scheduleNote })
      expect(decodedText(out)).toBe(`Mohon konfirmasi kehadiran untuk Project Day (Sabtu, 24 Oktober 2026 18.00): ${URL_}`)
    }
  })
})

