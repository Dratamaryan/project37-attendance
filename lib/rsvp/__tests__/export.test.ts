// Unit tests for the S9-R3b/R5 RSVP export row mapper (lib/rsvp/export.ts).
import { describe, it, expect } from 'vitest'
import { mapRsvpToExportRow } from '../export'
import type { RsvpExportRow } from '../admin.types'

function row(over: Partial<RsvpExportRow>): RsvpExportRow {
  return {
    rsvp_id: 'r1', display_kind: 'newcomer', display_name: '[SYNTH] Newcomer', status: 'coming',
    children_count: 1, followup_consent: true, phone: '+6299900000001',
    created_at: '2026-07-01T03:00:00Z', updated_at: '2026-07-01T03:00:00Z',
    attended: false, anonymized: false, ...over,
  }
}

describe('mapRsvpToExportRow — scrubbed rows (S9-R5)', () => {
  // A scrubbed row always arrives with phone '' (impl maps a NULL phone to '').
  it.each([
    ['member matched at submit', { display_kind: 'member', display_name: '[SYNTH] Member' }, '[SYNTH] Member', 'Member'],
    ['member via frozen link', { display_kind: 'member', display_name: '[SYNTH] Door Newcomer' }, '[SYNTH] Door Newcomer', 'Member'],
    ['removed member', { display_kind: 'removed_member', display_name: null }, 'Removed member', 'Removed member'],
    ['unresolved newcomer', { display_kind: 'newcomer', display_name: null }, 'Anonymized', 'Newcomer'],
  ] as const)('%s -> Name "%s", Type unchanged, Phone empty', (_label, over, name, type) => {
    const out = mapRsvpToExportRow(row({ ...over, phone: '', anonymized: true }))
    expect(out).toMatchObject({ Name: name, Type: type, Phone: '' })
  })

  it('not scrubbed, blank name -> "(no name)"', () => {
    expect(mapRsvpToExportRow(row({ display_name: null })).Name).toBe('(no name)')
  })

  it('not scrubbed: name and phone pass through', () => {
    const out = mapRsvpToExportRow(row({}))
    expect(out).toMatchObject({ Name: '[SYNTH] Newcomer', Type: 'Newcomer', Phone: '+6299900000001' })
  })
})
