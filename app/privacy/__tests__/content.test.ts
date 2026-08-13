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
  it('loads the Indonesian document for locale=id', async () => {
    const content = await loadPrivacyPolicyContent('id')
    expect(content).toContain('# Kebijakan Privasi')
  })

  it('loads the English document for locale=en — proves the language toggle changes the rendered document', async () => {
    const content = await loadPrivacyPolicyContent('en')
    expect(content).toContain('# Privacy Policy')
    expect(content).not.toContain('# Kebijakan Privasi')
  })

  it('falls back to the Indonesian document for an unsupported locale', async () => {
    const content = await loadPrivacyPolicyContent('fr')
    expect(content).toContain('# Kebijakan Privasi')
  })
})
