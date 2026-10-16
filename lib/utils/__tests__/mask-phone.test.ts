import { describe, it, expect } from 'vitest'
import { maskPhoneLast4 } from '../mask-phone'

describe('maskPhoneLast4', () => {
  it('keeps only the last 4 digits of an E.164 number', () => {
    expect(maskPhoneLast4('+6281234561234')).toBe('•••• 1234')
    expect(maskPhoneLast4('+14155550199')).toBe('•••• 0199')
  })

  it('never contains more than 4 digits of the input', () => {
    const masked = maskPhoneLast4('+6281299887766')
    expect(masked.replace(/\D/g, '')).toBe('7766')
  })

  it('anonymized and malformed values collapse to the bare mask', () => {
    expect(maskPhoneLast4('anon:3f2c9a7e-1b2d-4c5e-8f90-123456781234')).toBe('••••')
    expect(maskPhoneLast4('')).toBe('••••')
    expect(maskPhoneLast4('081234561234')).toBe('••••')
  })
})
