import { describe, it, expect } from 'vitest'
import { resolveRruleDesc } from '@/app/admin/events/_components/EventDetailHeader'

// Marker translator: returns "[key]" so tests can assert the key was used, not a hardcoded string.
const t = (key: string) => `[${key}]`

describe('resolveRruleDesc', () => {
  it('EH-01: friday_monthly uses rrule.friday_monthly i18n key', () => {
    expect(resolveRruleDesc('friday_monthly', null, t)).toBe('[friday_monthly]')
  })

  it('EH-02: sunday_monthly uses rrule.sunday_monthly i18n key', () => {
    expect(resolveRruleDesc('sunday_monthly', null, t)).toBe('[sunday_monthly]')
  })

  it('EH-03: adhoc uses rrule.adhoc i18n key', () => {
    expect(resolveRruleDesc('adhoc', null, t)).toBe('[adhoc]')
  })

  it('EH-04: other_recurring with a rule → raw RRULE string (not translated)', () => {
    expect(resolveRruleDesc('other_recurring', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=FR', t)).toBe(
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=FR',
    )
  })

  it('EH-05: other_recurring with no rule → rrule.other_recurring i18n key', () => {
    expect(resolveRruleDesc('other_recurring', null, t)).toBe('[other_recurring]')
  })

  it('EH-06: unknown event_type with rule → raw rule (graceful fallback)', () => {
    expect(resolveRruleDesc('unknown_type', 'FREQ=DAILY', t)).toBe('FREQ=DAILY')
  })

  it('EH-07: unknown event_type without rule → other_recurring key', () => {
    expect(resolveRruleDesc('unknown_type', null, t)).toBe('[other_recurring]')
  })
})
