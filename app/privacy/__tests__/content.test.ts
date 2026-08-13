import { describe, it, expect } from 'vitest'
import { loadPrivacyPolicyContent, resolvePrivacyLocale } from '../content'

describe('resolvePrivacyLocale', () => {
  it('passes through supported locales', () => {
    expect(resolvePrivacyLocale('id')).toBe('id')
    expect(resolvePrivacyLocale('en')).toBe('en')
  })

  it('falls back to id for unsupported or missing locales', () => {
    expect(resolvePrivacyLocale('fr')).toBe('id')
    expect(resolvePrivacyLocale('')).toBe('id')
  })
})

describe('loadPrivacyPolicyContent', () => {
  it('loads the Indonesian document for locale=id', () => {
    const content = loadPrivacyPolicyContent('id')
    expect(content).toContain('# Kebijakan Privasi')
  })

  it('loads the English document for locale=en — proves the language toggle changes the rendered document', () => {
    const content = loadPrivacyPolicyContent('en')
    expect(content).toContain('# Privacy Policy')
    expect(content).not.toContain('# Kebijakan Privasi')
  })

  it('falls back to the Indonesian document for an unsupported locale', () => {
    const content = loadPrivacyPolicyContent('fr')
    expect(content).toContain('# Kebijakan Privasi')
  })
})
