import { describe, it, expect } from 'vitest';
import { toJakartaInstant, formatJakarta } from '@/lib/events/timezone';

describe('toJakartaInstant', () => {
  it('TZ-01 converts date+time string to UTC (18:00 Jakarta = 11:00 UTC)', () => {
    expect(toJakartaInstant('2026-07-10', '18:00').toISOString()).toBe('2026-07-10T11:00:00.000Z');
  });

  it('TZ-02 converts another date+time string to UTC (15:00 Jakarta = 08:00 UTC)', () => {
    expect(toJakartaInstant('2026-07-05', '15:00').toISOString()).toBe('2026-07-05T08:00:00.000Z');
  });

  it('TZ-03 midnight Jakarta crosses UTC day boundary (00:00 Jakarta = previous day 17:00 UTC)', () => {
    expect(toJakartaInstant('2026-01-01', '00:00').toISOString()).toBe('2025-12-31T17:00:00.000Z');
  });

  it('TZ-04 accepts HH:mm:ss time format with seconds', () => {
    expect(toJakartaInstant('2026-07-10', '18:00:30').toISOString()).toBe('2026-07-10T11:00:30.000Z');
  });

  it('TZ-05 accepts a Date object and extracts its Jakarta-zone calendar date', () => {
    // 2026-07-10T11:00:00Z is 2026-07-10 18:00 in Jakarta — well within the same calendar day.
    // Combining that Jakarta calendar date (2026-07-10) with time '09:00' should yield
    // 2026-07-10T02:00:00.000Z (09:00 Jakarta = 02:00 UTC).
    const utcDate = new Date('2026-07-10T11:00:00.000Z');
    expect(toJakartaInstant(utcDate, '09:00').toISOString()).toBe('2026-07-10T02:00:00.000Z');
  });

  it('TZ-06 N/A (covered by formatJakarta tests)', () => {
    // placeholder — test numbering kept in sync with spec
    expect(true).toBe(true);
  });
});

describe('formatJakarta', () => {
  it('TZ-06 formats UTC instant as Jakarta wall-time string', () => {
    expect(formatJakarta(new Date('2026-07-10T11:00:00.000Z'), 'yyyy-MM-dd HH:mm')).toBe('2026-07-10 18:00');
  });

  it('TZ-07 handles year/day rollover at midnight (UTC 17:00 = Jakarta 00:00 next day)', () => {
    expect(formatJakarta(new Date('2025-12-31T17:00:00.000Z'), 'yyyy-MM-dd HH:mm')).toBe('2026-01-01 00:00');
  });

  it('TZ-08 round-trip: toJakartaInstant then formatJakarta returns original wall-time', () => {
    const result = formatJakarta(toJakartaInstant('2026-07-10', '18:00'), "yyyy-MM-dd'T'HH:mm");
    expect(result).toBe('2026-07-10T18:00');
  });
});

describe('toJakartaInstant error handling', () => {
  it('TZ-09 throws on malformed date string', () => {
    expect(() => toJakartaInstant('not-a-date', '18:00')).toThrow();
  });

  it('TZ-10 throws on invalid time (hour > 23)', () => {
    expect(() => toJakartaInstant('2026-07-10', '25:99')).toThrow();
  });
});
