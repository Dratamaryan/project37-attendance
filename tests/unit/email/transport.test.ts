import { describe, it, expect, vi } from 'vitest'
import { createNodemailerTransport, type EmailMessage, type RawSender } from '@/lib/email/transport'
import type { NotifySmtpConfig } from '@/lib/email/config'

const CONFIG: NotifySmtpConfig = {
  host: 'smtp.gmail.com',
  port: 587,
  user: 'project37.events@gmail.com',
  pass: 'fake-app-password',
  fromName: 'Project 37',
  replyTo: 'ryan@example.com',
}

const BASE_MESSAGE: EmailMessage = {
  to: 'recipient@example.com',
  subject: 'Undangan: Test / Invitation: Test — Project 37',
  html: '<p>hi</p>',
  text: 'hi',
  fromName: 'Project 37',
  replyTo: 'ryan@example.com',
}

describe('createNodemailerTransport — result shape (E/1: this is verified: vitest, never delivery)', () => {
  it('returns the success variant on a fake 250-equivalent response', async () => {
    const sendRaw: RawSender = vi.fn().mockResolvedValue({
      messageId: '<abc123@smtp.gmail.com>',
      response: '250 2.0.0 OK',
    })
    const transport = createNodemailerTransport(CONFIG, sendRaw)

    const result = await transport.send(BASE_MESSAGE)

    expect(result).toEqual({
      ok: true,
      messageId: '<abc123@smtp.gmail.com>',
      response: '250 2.0.0 OK',
    })
  })

  it('returns the typed failure variant on a thrown SMTP error, and never throws', async () => {
    const sendRaw: RawSender = vi.fn().mockRejectedValue(new Error('550 5.4.5 Daily sending quota exceeded'))
    const transport = createNodemailerTransport(CONFIG, sendRaw)

    let thrown = false
    let result
    try {
      result = await transport.send(BASE_MESSAGE)
    } catch {
      thrown = true
    }

    expect(thrown).toBe(false)
    expect(result).toEqual({
      ok: false,
      reason: 'smtp_error',
      message: '550 5.4.5 Daily sending quota exceeded',
    })
  })

  it('passes fromName/config.user/replyTo/subject/html/text through to the sender', async () => {
    const sendRaw: RawSender = vi.fn().mockResolvedValue({ messageId: 'x', response: '250 OK' })
    const transport = createNodemailerTransport(CONFIG, sendRaw)

    await transport.send(BASE_MESSAGE)

    expect(sendRaw).toHaveBeenCalledWith(
      expect.objectContaining({
        from: '"Project 37" <project37.events@gmail.com>',
        to: 'recipient@example.com',
        replyTo: 'ryan@example.com',
        subject: BASE_MESSAGE.subject,
        html: BASE_MESSAGE.html,
        text: BASE_MESSAGE.text,
      })
    )
  })

  it('carries an attachment through to the sender intact (transport attachment capability — T9 rides this with the .ics)', async () => {
    const sendRaw: RawSender = vi.fn().mockResolvedValue({ messageId: 'x', response: '250 OK' })
    const transport = createNodemailerTransport(CONFIG, sendRaw)

    const attachment = {
      filename: 'invite.ics',
      content: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR',
      contentType: 'text/calendar',
    }

    await transport.send({ ...BASE_MESSAGE, attachments: [attachment] })

    expect(sendRaw).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [attachment],
      })
    )
  })
})
