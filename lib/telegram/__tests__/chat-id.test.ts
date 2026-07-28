import { describe, it, expect } from 'vitest'
import { resolveChatId } from '../chat-id'

describe('resolveChatId', () => {
  describe('valid', () => {
    it('T4-C01: DM — real stored positive-integer chat ID', () => {
      // Pins Ruling 1: a real DM ID must not be misclassified as phone-shaped.
      expect(resolveChatId('8922952648')).toEqual({
        status: 'valid',
        kind: 'dm',
        value: '8922952648',
      })
    })

    it('T4-C02: group — negative integer', () => {
      expect(resolveChatId('-123456789')).toEqual({
        status: 'valid',
        kind: 'group',
        value: '-123456789',
      })
    })

    it('T4-C03: supergroup — large negative, -100 prefix, overflows a 32-bit int', () => {
      expect(resolveChatId('-1001234567890')).toEqual({
        status: 'valid',
        kind: 'supergroup',
        value: '-1001234567890',
      })
    })

    it('T4-C04: channel by username', () => {
      expect(resolveChatId('@project37')).toEqual({
        status: 'valid',
        kind: 'channel_username',
        value: '@project37',
      })
    })
  })

  describe('invalid', () => {
    it('T4-C05: empty string', () => {
      expect(resolveChatId('')).toEqual({ status: 'invalid', reason: 'empty', value: '' })
    })

    it('T4-C06: whitespace-only', () => {
      expect(resolveChatId('   ')).toEqual({ status: 'invalid', reason: 'empty', value: '   ' })
    })

    it('T4-C07: non-numeric, non-@ junk', () => {
      expect(resolveChatId('abc123')).toEqual({
        status: 'invalid',
        reason: 'invalid_format',
        value: 'abc123',
      })
    })

    it('T4-C08: partially-numeric junk', () => {
      expect(resolveChatId('12ab34')).toEqual({
        status: 'invalid',
        reason: 'invalid_format',
        value: '12ab34',
      })
    })

    it('T4-C09: embedded whitespace — the "downstream parseInt truncates" mangle risk', () => {
      expect(resolveChatId('123 456')).toEqual({
        status: 'invalid',
        reason: 'invalid_format',
        value: '123 456',
      })
    })

    it('T4-C10: decimal notation', () => {
      expect(resolveChatId('123.456')).toEqual({
        status: 'invalid',
        reason: 'invalid_format',
        value: '123.456',
      })
    })

    it('T4-C11: scientific notation', () => {
      expect(resolveChatId('1.5e10')).toEqual({
        status: 'invalid',
        reason: 'invalid_format',
        value: '1.5e10',
      })
    })

    it('T4-C12: E.164 phone pasted by mistake', () => {
      expect(resolveChatId('+6281808247576')).toEqual({
        status: 'invalid',
        reason: 'phone_number_shaped',
        value: '+6281808247576',
      })
    })

    it('T4-C13: Indonesian local-format phone (leading 0) pasted by mistake', () => {
      expect(resolveChatId('081808247576')).toEqual({
        status: 'invalid',
        reason: 'phone_number_shaped',
        value: '081808247576',
      })
    })

    it('T4-C14: Indonesian mobile with 62 prefix, no plus, pasted by mistake', () => {
      expect(resolveChatId('6281808247576')).toEqual({
        status: 'invalid',
        reason: 'phone_number_shaped',
        value: '6281808247576',
      })
    })

    it('T4-C15: bare "0" — not a real chat ID, not phone-shaped either', () => {
      expect(resolveChatId('0')).toEqual({
        status: 'invalid',
        reason: 'invalid_format',
        value: '0',
      })
    })

    it('T4-C16: username too short (Telegram minimum is 5 chars after @)', () => {
      expect(resolveChatId('@ab')).toEqual({
        status: 'invalid',
        reason: 'invalid_format',
        value: '@ab',
      })
    })

    it('T4-C17: username starting with a digit (Telegram requires a leading letter)', () => {
      expect(resolveChatId('@123abc')).toEqual({
        status: 'invalid',
        reason: 'invalid_format',
        value: '@123abc',
      })
    })
  })
})
