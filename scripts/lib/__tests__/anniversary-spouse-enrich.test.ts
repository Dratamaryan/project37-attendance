import { describe, it, expect } from 'vitest'
import {
  QUARANTINE_REASONS,
  anniversarySource,
  assertPayloadGuard,
  decideField,
  normalizeSpouse,
  parseAnniversaryCell,
  planRow,
  spouseSource,
  type RowPlan,
  type SnapshotRow,
} from '../anniversary-spouse-enrich'

// ALL fixtures are invented. Never copy a name, date or phone from the real
// roster file into this suite.

const TODAY = '2026-10-07'
const utc = (y: number, m: number, d: number, h = 0, mi = 0, s = 0, ms = 0) => new Date(Date.UTC(y, m - 1, d, h, mi, s, ms))

describe('parseAnniversaryCell', () => {
  it('midnight-UTC Date -> YYYY-MM-DD from UTC parts', () => {
    expect(parseAnniversaryCell(utc(2015, 6, 20), TODAY)).toEqual({ kind: 'ok', iso: '2015-06-20' })
  })

  it('pads single-digit month/day', () => {
    expect(parseAnniversaryCell(utc(2001, 1, 2), TODAY)).toEqual({ kind: 'ok', iso: '2001-01-02' })
  })

  it('leap day accepted', () => {
    expect(parseAnniversaryCell(utc(2016, 2, 29), TODAY)).toEqual({ kind: 'ok', iso: '2016-02-29' })
  })

  it('today accepted; boundary year 1950 accepted', () => {
    expect(parseAnniversaryCell(utc(2026, 10, 7), TODAY)).toEqual({ kind: 'ok', iso: '2026-10-07' })
    expect(parseAnniversaryCell(utc(1950, 1, 1), TODAY)).toEqual({ kind: 'ok', iso: '1950-01-01' })
  })

  it('any non-zero UTC time component -> abort (+1-day trap)', () => {
    expect(parseAnniversaryCell(utc(2015, 6, 20, 0, 0, 0, 1), TODAY)).toEqual({ kind: 'abort-nonzero-utc-time' })
    expect(parseAnniversaryCell(utc(2015, 6, 19, 17), TODAY)).toEqual({ kind: 'abort-nonzero-utc-time' })
    expect(parseAnniversaryCell(utc(2015, 6, 20, 0, 0, 1), TODAY)).toEqual({ kind: 'abort-nonzero-utc-time' })
    expect(parseAnniversaryCell(utc(2015, 6, 20, 0, 1), TODAY)).toEqual({ kind: 'abort-nonzero-utc-time' })
  })

  it('NaN Date -> invalid-date', () => {
    expect(parseAnniversaryCell(new Date(NaN), TODAY)).toEqual({ kind: 'quarantine', reason: QUARANTINE_REASONS.INVALID_DATE })
  })

  it('non-blank string -> string-cell, never parsed', () => {
    expect(parseAnniversaryCell('06/20/2015', TODAY)).toEqual({ kind: 'quarantine', reason: QUARANTINE_REASONS.STRING_CELL })
    expect(parseAnniversaryCell('20/06/2015', TODAY)).toEqual({ kind: 'quarantine', reason: QUARANTINE_REASONS.STRING_CELL })
  })

  it('number / serial -> number-cell, never parsed', () => {
    expect(parseAnniversaryCell(42175, TODAY)).toEqual({ kind: 'quarantine', reason: QUARANTINE_REASONS.NUMBER_CELL })
  })

  it('other cell types -> other-cell', () => {
    expect(parseAnniversaryCell(true, TODAY)).toEqual({ kind: 'quarantine', reason: QUARANTINE_REASONS.OTHER_CELL })
  })

  it('year before 1950 or after current year -> year-out-of-range', () => {
    expect(parseAnniversaryCell(utc(1949, 12, 31), TODAY)).toEqual({ kind: 'quarantine', reason: QUARANTINE_REASONS.YEAR_OUT_OF_RANGE })
    expect(parseAnniversaryCell(utc(2027, 1, 1), TODAY)).toEqual({ kind: 'quarantine', reason: QUARANTINE_REASONS.YEAR_OUT_OF_RANGE })
  })

  it('later this year -> future-date', () => {
    expect(parseAnniversaryCell(utc(2026, 10, 8), TODAY)).toEqual({ kind: 'quarantine', reason: QUARANTINE_REASONS.FUTURE_DATE })
  })

  it('null / undefined / blank string -> empty', () => {
    expect(parseAnniversaryCell(null, TODAY)).toEqual({ kind: 'empty' })
    expect(parseAnniversaryCell(undefined, TODAY)).toEqual({ kind: 'empty' })
    expect(parseAnniversaryCell('   ', TODAY)).toEqual({ kind: 'empty' })
  })
})

describe('normalizeSpouse', () => {
  it('trims and collapses internal whitespace, keeps case', () => {
    expect(normalizeSpouse('  Pasangan   Satu\tContoh ')).toBe('Pasangan Satu Contoh')
    expect(normalizeSpouse('pASANGAN dua')).toBe('pASANGAN dua')
  })

  it('empty / whitespace-only / nullish -> null', () => {
    expect(normalizeSpouse('')).toBeNull()
    expect(normalizeSpouse('  \n ')).toBeNull()
    expect(normalizeSpouse(null)).toBeNull()
    expect(normalizeSpouse(undefined)).toBeNull()
  })
})

describe('decideField', () => {
  const v = (value: string) => ({ kind: 'value' as const, value })

  it('snapshot NULL + source value -> would_fill', () => {
    expect(decideField(null, v('2015-06-20'))).toBe('would_fill')
  })

  it('snapshot equal -> already_equal', () => {
    expect(decideField('Pasangan Satu', v('Pasangan Satu'))).toBe('already_equal')
  })

  it('snapshot set and different -> conflict (case-sensitive)', () => {
    expect(decideField('Pasangan Satu', v('pasangan satu'))).toBe('conflict')
  })

  it('quarantined source -> quarantined regardless of snapshot', () => {
    const q = { kind: 'quarantine' as const, reason: QUARANTINE_REASONS.STRING_CELL }
    expect(decideField(null, q)).toBe('quarantined')
    expect(decideField('2015-06-20', q)).toBe('quarantined')
  })

  it('empty source -> source_empty regardless of snapshot', () => {
    expect(decideField(null, { kind: 'empty' })).toBe('source_empty')
    expect(decideField('x', { kind: 'empty' })).toBe('source_empty')
  })
})

describe('planRow', () => {
  const snap = (over: Partial<SnapshotRow> = {}): SnapshotRow => ({ id: 'p1', wedding_anniversary: null, spouse_name: null, ...over })

  it('payload only carries NULL-snapshot fields with a value', () => {
    const plan = planRow(snap({ spouse_name: 'Pasangan Satu' }), 10, {
      wedding_anniversary: anniversarySource({ kind: 'ok', iso: '2015-06-20' }),
      spouse_name: spouseSource('Pasangan Lain'),
    })
    expect(plan.outcomes).toEqual({ wedding_anniversary: 'would_fill', spouse_name: 'conflict' })
    expect(plan.payload).toEqual({ wedding_anniversary: '2015-06-20' })
  })

  it('nothing to write -> payload null', () => {
    const plan = planRow(snap({ wedding_anniversary: '2015-06-20' }), 11, {
      wedding_anniversary: anniversarySource({ kind: 'ok', iso: '2015-06-20' }),
      spouse_name: spouseSource(null),
    })
    expect(plan.outcomes).toEqual({ wedding_anniversary: 'already_equal', spouse_name: 'source_empty' })
    expect(plan.payload).toBeNull()
  })

  it('quarantined anniversary never enters the payload', () => {
    const plan = planRow(snap(), 4, {
      wedding_anniversary: anniversarySource({ kind: 'quarantine', reason: QUARANTINE_REASONS.STRING_CELL }),
      spouse_name: spouseSource('Pasangan Satu'),
    })
    expect(plan.outcomes.wedding_anniversary).toBe('quarantined')
    expect(plan.payload).toEqual({ spouse_name: 'Pasangan Satu' })
  })
})

describe('assertPayloadGuard', () => {
  const snapshot: SnapshotRow = { id: 'p1', wedding_anniversary: null, spouse_name: null }
  const byId = new Map([[snapshot.id, snapshot]])
  const base: RowPlan = {
    personId: 'p1',
    rowIndex: 1,
    outcomes: { wedding_anniversary: 'would_fill', spouse_name: 'would_fill' },
    payload: { wedding_anniversary: '2015-06-20', spouse_name: 'Pasangan Satu' },
  }

  it('clean plan -> no violations', () => {
    expect(assertPayloadGuard([base], byId)).toEqual([])
  })

  it('rejects anniversary_consent_state / any non-enrich key', () => {
    const bad = { ...base, payload: { ...base.payload, anniversary_consent_state: 'granted' } as unknown as RowPlan['payload'] }
    expect(assertPayloadGuard([bad], byId).join('\n')).toContain('anniversary_consent_state')
    const bad2 = { ...base, payload: { updated_at: 'x' } as unknown as RowPlan['payload'] }
    expect(assertPayloadGuard([bad2], byId).join('\n')).toContain('updated_at')
  })

  it('rejects a key whose snapshot is not NULL', () => {
    const snapSet = new Map([['p1', { ...snapshot, spouse_name: 'Existing' }]])
    expect(assertPayloadGuard([base], snapSet).join('\n')).toContain('snapshot not NULL')
  })

  it('rejects a key whose outcome is not would_fill (e.g. quarantined)', () => {
    const bad: RowPlan = { ...base, outcomes: { ...base.outcomes, wedding_anniversary: 'quarantined' } }
    expect(assertPayloadGuard([bad], byId).join('\n')).toContain('outcome=quarantined')
  })

  it('rejects malformed anniversary and un-normalized spouse', () => {
    const bad: RowPlan = { ...base, payload: { wedding_anniversary: '20/06/2015', spouse_name: ' Pasangan  Satu' } }
    const v = assertPayloadGuard([bad], byId).join('\n')
    expect(v).toContain('not YYYY-MM-DD')
    expect(v).toContain('not normalized')
  })

  it('rejects a plan with no snapshot row', () => {
    expect(assertPayloadGuard([{ ...base, personId: 'ghost' }], byId).join('\n')).toContain('no snapshot row')
  })
})
