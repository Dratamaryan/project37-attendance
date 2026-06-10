import { describe, it, expect } from 'vitest'
import { buildRRule } from '@/app/admin/events/_components/RRuleBuilder'

// These strings MUST match the seed data created in T2/T4.
// Any change to the output values is a breaking change requiring a data migration.
describe('buildRRule', () => {
  it('friday_biweekly → FREQ=WEEKLY;INTERVAL=2;BYDAY=FR', () => {
    expect(buildRRule('friday_biweekly')).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=FR')
  })

  it('sunday_monthly → FREQ=MONTHLY;BYDAY=1SU', () => {
    expect(buildRRule('sunday_monthly')).toBe('FREQ=MONTHLY;BYDAY=1SU')
  })

  it('adhoc → null', () => {
    expect(buildRRule('adhoc')).toBeNull()
  })

  it('other_recurring with user-typed raw RRULE → returns it verbatim', () => {
    expect(buildRRule('other_recurring', 'FREQ=DAILY;COUNT=5')).toBe('FREQ=DAILY;COUNT=5')
  })

  it('other_recurring with empty raw → null', () => {
    expect(buildRRule('other_recurring', '')).toBeNull()
    expect(buildRRule('other_recurring', '  ')).toBeNull()
    expect(buildRRule('other_recurring', undefined)).toBeNull()
  })

  it('unknown type → null', () => {
    expect(buildRRule('unknown_type')).toBeNull()
  })
})
