// en/id locale key parity. Every key path (nested objects flattened with '.')
// must exist in both files, so no UI string is missing in either language.
// Pinned explicitly for the S9-R6 A2 settings.rsvp_health block as well.
import { describe, it, expect } from 'vitest'
import en from '@/messages/en.json'
import id from '@/messages/id.json'

function keyPaths(node: unknown, prefix = ''): string[] {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return [prefix]
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
    keyPaths(v, prefix ? `${prefix}.${k}` : k),
  )
}

describe('locale key parity', () => {
  it('en and id have identical key sets', () => {
    expect(keyPaths(id).sort()).toEqual(keyPaths(en).sort())
  })

  it('settings.rsvp_health: identical keys, all non-empty strings', () => {
    const enKeys = keyPaths(en.settings.rsvp_health).sort()
    expect(keyPaths(id.settings.rsvp_health).sort()).toEqual(enKeys)
    expect(enKeys.length).toBeGreaterThan(0)
    for (const leaves of [en.settings.rsvp_health, id.settings.rsvp_health]) {
      const flat = JSON.stringify(leaves)
      expect(flat).not.toContain('""')
    }
  })
})
