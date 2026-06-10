import { describe, it, expect } from 'vitest';
import { expandRRule } from '@/lib/events/recurrence';

// Fixed now for determinism across all recurrence tests
const NOW = new Date('2026-07-01T00:00:00.000Z');

describe('expandRRule — recurring events', () => {
  it('REC-01 biweekly Friday 12mo: 26 occurrences, all Fridays at T11:00:00.000Z, 14 days apart', () => {
    const result = expandRRule({
      recurrenceRule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=FR',
      startDate: '2026-07-10',
      startTime: '18:00',
      horizonMonths: 12,
      now: NOW,
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    expect(result.occurrences).toHaveLength(26);
    expect(result.occurrences[0].toISOString()).toBe('2026-07-10T11:00:00.000Z');

    // All at 11:00 UTC (= 18:00 Jakarta) on Fridays
    for (const occ of result.occurrences) {
      expect(occ.getUTCDay()).toBe(5); // Friday
      expect(occ.getUTCHours()).toBe(11);
      expect(occ.getUTCMinutes()).toBe(0);
      expect(occ.getUTCSeconds()).toBe(0);
    }

    // All exactly 14 days apart
    for (let i = 1; i < result.occurrences.length; i++) {
      const diffDays =
        (result.occurrences[i].getTime() - result.occurrences[i - 1].getTime()) /
        (1000 * 60 * 60 * 24);
      expect(diffDays).toBe(14);
    }
  });

  it('REC-02 monthly 1st Sunday 12mo: 12 occurrences, all Sundays at T08:00:00.000Z', () => {
    const result = expandRRule({
      recurrenceRule: 'FREQ=MONTHLY;BYDAY=1SU',
      startDate: '2026-07-05',
      startTime: '15:00',
      horizonMonths: 12,
      now: NOW,
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    expect(result.occurrences).toHaveLength(12);
    expect(result.occurrences[0].toISOString()).toBe('2026-07-05T08:00:00.000Z');

    // All Sundays at 08:00 UTC (= 15:00 Jakarta)
    for (const occ of result.occurrences) {
      expect(occ.getUTCDay()).toBe(0); // Sunday
      expect(occ.getUTCHours()).toBe(8);
    }
  });

  it('REC-06 biweekly Friday 6mo: 13 occurrences (T2-09 acceptance)', () => {
    const result = expandRRule({
      recurrenceRule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=FR',
      startDate: '2026-07-10',
      startTime: '18:00',
      horizonMonths: 6,
      now: NOW,
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.occurrences).toHaveLength(13);
  });

  it('REC-07 past startDate with active rule: occurrences start from now, all Fridays, >= 26', () => {
    const result = expandRRule({
      recurrenceRule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=FR',
      startDate: '2025-01-03', // Friday in the past
      startTime: '18:00',
      horizonMonths: 12,
      now: NOW,
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    expect(result.occurrences.length).toBeGreaterThanOrEqual(26);

    // None before now
    for (const occ of result.occurrences) {
      expect(occ.getTime()).toBeGreaterThanOrEqual(NOW.getTime());
    }

    // All Fridays
    for (const occ of result.occurrences) {
      expect(occ.getUTCDay()).toBe(5);
    }
  });
});

describe('expandRRule — adhoc events', () => {
  it('REC-03 adhoc inside window: 1 occurrence', () => {
    const result = expandRRule({
      recurrenceRule: null,
      startDate: '2026-08-15',
      startTime: '19:00',
      horizonMonths: 12,
      now: NOW,
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.occurrences).toHaveLength(1);
    expect(result.occurrences[0].toISOString()).toBe('2026-08-15T12:00:00.000Z');
  });

  it('REC-04 adhoc before window (past start): 0 occurrences', () => {
    const result = expandRRule({
      recurrenceRule: null,
      startDate: '2025-01-01',
      startTime: '10:00',
      horizonMonths: 12,
      now: NOW,
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.occurrences).toHaveLength(0);
  });

  it('REC-05 adhoc after window: 0 occurrences', () => {
    const result = expandRRule({
      recurrenceRule: null,
      startDate: '2028-01-01',
      startTime: '10:00',
      horizonMonths: 12,
      now: NOW,
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.occurrences).toHaveLength(0);
  });
});

describe('expandRRule — error cases', () => {
  it('REC-08 invalid RRULE string: status invalid_rrule with message', () => {
    const result = expandRRule({
      recurrenceRule: 'THIS_IS_GARBAGE',
      startDate: '2026-07-10',
      startTime: '18:00',
      horizonMonths: 12,
      now: NOW,
    });

    expect(result.status).toBe('invalid_rrule');
    if (result.status !== 'invalid_rrule') return;
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('REC-09 invalid startDate: status invalid_input, no throw', () => {
    const result = expandRRule({
      recurrenceRule: null,
      startDate: 'not-a-date',
      startTime: '18:00',
      horizonMonths: 12,
      now: NOW,
    });

    expect(result.status).toBe('invalid_input');
  });

  it('REC-10 invalid startTime (25:00): status invalid_input, no throw', () => {
    const result = expandRRule({
      recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO',
      startDate: '2026-07-10',
      startTime: '25:00',
      horizonMonths: 12,
      now: NOW,
    });

    expect(result.status).toBe('invalid_input');
  });
});

describe('expandRRule — edge cases', () => {
  it('REC-11 horizonMonths=0 with future startDate: window collapses, 0 occurrences', () => {
    // startDate=2026-07-10 > now=2026-07-01, so windowStart=startInstant > windowEnd=now → empty
    const result = expandRRule({
      recurrenceRule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=FR',
      startDate: '2026-07-10',
      startTime: '18:00',
      horizonMonths: 0,
      now: NOW,
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.occurrences).toHaveLength(0);
  });

  it('REC-12 determinism: same inputs produce identical occurrence arrays', () => {
    const input = {
      recurrenceRule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=FR',
      startDate: '2026-07-10',
      startTime: '18:00',
      horizonMonths: 12,
      now: NOW,
    };

    const result1 = expandRRule(input);
    const result2 = expandRRule(input);

    expect(result1.status).toBe('ok');
    expect(result2.status).toBe('ok');
    if (result1.status !== 'ok' || result2.status !== 'ok') return;
    expect(result1.occurrences).toEqual(result2.occurrences);
  });
});
