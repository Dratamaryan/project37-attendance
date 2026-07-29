import { describe, it, expect } from 'vitest'
import { renderInviteEmail, type InviteEmailInput } from '@/lib/email/template'

const BASE_INPUT: InviteEmailInput = {
  eventNameEn: 'Project Day',
  eventNameId: 'Hari Proyek',
  scheduledAt: new Date('2026-07-10T11:00:00.000Z'), // 18:00 Jakarta
  durationMin: 120,
  location: 'Hotel Neo Puri Indah',
}

describe('renderInviteEmail — T4-06', () => {
  it('renders both languages in html and text', () => {
    const { html, text } = renderInviteEmail(BASE_INPUT)
    expect(html).toContain('Undangan:')
    expect(html).toContain('Invitation:')
    expect(text).toContain('Undangan:')
    expect(text).toContain('Invitation:')
  })

  it('orders Indonesian before English in html and text', () => {
    const { html, text } = renderInviteEmail(BASE_INPUT)
    expect(html.indexOf('Undangan:')).toBeLessThan(html.indexOf('Invitation:'))
    expect(text.indexOf('Undangan:')).toBeLessThan(text.indexOf('Invitation:'))
  })

  it('includes the opt-out line in both languages, in both html and text', () => {
    const { html, text } = renderInviteEmail(BASE_INPUT)
    const optOutId = 'Balas email ini jika tidak ingin menerima undangan.'
    const optOutEn = "Reply to this email if you'd rather not receive invitations."
    expect(html).toContain(optOutId)
    expect(html).toContain(optOutEn)
    expect(text).toContain(optOutId)
    expect(text).toContain(optOutEn)
  })

  it('renders event name, ICT-formatted date/time, and location correctly', () => {
    const { html, text } = renderInviteEmail(BASE_INPUT)
    for (const rendered of [html, text]) {
      expect(rendered).toContain('Hari Proyek')
      expect(rendered).toContain('Project Day')
      expect(rendered).toContain('10 July 2026 · 18:00 WIB')
      expect(rendered).toContain('Hotel Neo Puri Indah')
    }
  })

  it('falls back to the English name when eventNameId is null', () => {
    const { html } = renderInviteEmail({ ...BASE_INPUT, eventNameId: null })
    expect(html).toContain('<h2>Undangan: Project Day</h2>')
    expect(html).toContain('<h2>Invitation: Project Day</h2>')
  })

  it('renders a bilingual fallback line when location is null (real prod shape, T7 finding)', () => {
    const { html, text } = renderInviteEmail({ ...BASE_INPUT, location: null })
    expect(html).toContain('Lokasi akan diinformasikan kemudian')
    expect(html).toContain('Location to be announced')
    expect(text).toContain('Lokasi akan diinformasikan kemudian')
    expect(text).toContain('Location to be announced')
  })

  it('includes a bilingual subject with the event name', () => {
    const { subject } = renderInviteEmail(BASE_INPUT)
    expect(subject).toContain('Hari Proyek')
    expect(subject).toContain('Project Day')
  })
})
