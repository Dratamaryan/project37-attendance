import { describe, it, expect, vi, afterEach } from 'vitest'
import { sendTelegramMessage } from '../client'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sendTelegramMessage', () => {
  it('T4-S01: success — returns the ok variant with messageId', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { ok: true, result: { message_id: 42 } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await sendTelegramMessage({
      token: 'fake-token',
      chatId: '8922952648',
      text: 'hello',
    })

    expect(result).toEqual({ ok: true, messageId: 42 })
  })

  it('T4-S02: sends the correct URL and JSON payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { ok: true, result: { message_id: 1 } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await sendTelegramMessage({ token: 'fake-token', chatId: '-1001234567890', text: 'hi' })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.telegram.org/botfake-token/sendMessage',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ chat_id: '-1001234567890', text: 'hi' }),
      }),
    )
  })

  it('T4-S03: Telegram 400 error — returns the http_error variant, not throw', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await sendTelegramMessage({
      token: 'fake-token',
      chatId: '123',
      text: 'hello',
    })

    expect(result).toEqual({
      ok: false,
      reason: 'http_error',
      status: 400,
      description: 'Bad Request: chat not found',
    })
  })

  it('T4-S04: network failure — returns the network_error variant, not throw', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    vi.stubGlobal('fetch', fetchMock)

    const result = await sendTelegramMessage({
      token: 'fake-token',
      chatId: '123',
      text: 'hello',
    })

    expect(result).toEqual({ ok: false, reason: 'network_error', message: 'fetch failed' })
  })
})
