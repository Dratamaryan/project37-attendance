import { describe, it, expect } from 'vitest'
import { displayInstanceName } from '@/lib/events/display'

const NOW   = new Date('2026-06-13T10:00:00Z')
const PAST   = new Date('2020-01-01T00:00:00Z')  // clearly before NOW
const FUTURE = new Date('2090-01-01T00:00:00Z')  // clearly after NOW

const BASE = {
  snapshot:    'Project Day',
  snapshotId:  'Hari Project',
  liveName:    'Project Day Live',
  liveNameId:  'Hari Project Live',
  now:          NOW,
}

describe('displayInstanceName', () => {
  it('DIN-01: past EN locale → returns snapshot', () => {
    expect(displayInstanceName({ ...BASE, scheduledAt: PAST, locale: 'en' }))
      .toBe('Project Day')
  })

  it('DIN-02: past ID locale, snapshotId present → returns snapshotId', () => {
    expect(displayInstanceName({ ...BASE, scheduledAt: PAST, locale: 'id' }))
      .toBe('Hari Project')
  })

  it('DIN-03: past ID locale, snapshotId null → returns snapshot fallback', () => {
    expect(displayInstanceName({ ...BASE, snapshotId: null, scheduledAt: PAST, locale: 'id' }))
      .toBe('Project Day')
  })

  it('DIN-04: future EN locale → returns liveName', () => {
    expect(displayInstanceName({ ...BASE, scheduledAt: FUTURE, locale: 'en' }))
      .toBe('Project Day Live')
  })

  it('DIN-05: future ID locale, liveNameId present → returns liveNameId', () => {
    expect(displayInstanceName({ ...BASE, scheduledAt: FUTURE, locale: 'id' }))
      .toBe('Hari Project Live')
  })

  it('DIN-06: future ID locale, liveNameId null → returns liveName fallback', () => {
    expect(displayInstanceName({ ...BASE, liveNameId: null, scheduledAt: FUTURE, locale: 'id' }))
      .toBe('Project Day Live')
  })

  it('DIN-07: boundary scheduledAt === now → treated as future (strict < comparison)', () => {
    // scheduledAt === now is NOT < now, so it is future → returns liveName
    expect(displayInstanceName({ ...BASE, scheduledAt: NOW, locale: 'en' }))
      .toBe('Project Day Live')
  })
})
