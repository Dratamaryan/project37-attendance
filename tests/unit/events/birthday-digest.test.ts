import { describe, it, expect } from 'vitest';
import {
  cohortDateFor,
  isLeapYear,
  selectBirthdaysOn,
  formatIndonesianDate,
  consentBadge,
  formatBirthdayDigest,
  type PersonRow,
} from '@/lib/events/birthday-digest';

function person(overrides: Partial<PersonRow> & { id: string }): PersonRow {
  return {
    full_name: 'Test Person',
    birth_date: null,
    photo_publish_consent: false,
    photo_consent_state: 'unknown',
    deleted_at: null,
    ...overrides,
  };
}

describe('cohortDateFor (S8-T6 H-1: tomorrow in WIB)', () => {
  it('H1-01: the 00:00 UTC cron (07:00 WIB) → cohort is tomorrow in WIB', () => {
    expect(cohortDateFor(new Date('2026-07-29T00:00:00.000Z'))).toBe('2026-07-30');
  });

  it('H1-02: WIB boundary — 23:30 UTC is 06:30 WIB the NEXT day, so the cohort is two UTC days ahead', () => {
    // 2026-07-29T23:30Z = 2026-07-30 06:30 WIB → tomorrow in WIB is 07-31. A naive
    // UTC-date + 1 would compute 07-30 and greet today's birthdays instead.
    expect(cohortDateFor(new Date('2026-07-29T23:30:00.000Z'))).toBe('2026-07-31');
  });

  it('H1-03: last instant of a WIB day (16:59:59Z) → cohort is the next WIB day', () => {
    expect(cohortDateFor(new Date('2026-07-29T16:59:59.000Z'))).toBe('2026-07-30');
    expect(cohortDateFor(new Date('2026-07-29T17:00:00.000Z'))).toBe('2026-07-31');
  });

  it('H1-04: Dec 31 send → Jan 1 cohort of the next year', () => {
    expect(cohortDateFor(new Date('2026-12-31T00:00:00.000Z'))).toBe('2027-01-01');
  });

  it('H1-05: Feb 27 send → Feb 28 (non-leap); Feb 28 send → Feb 29 (leap) / Mar 1 (non-leap)', () => {
    expect(cohortDateFor(new Date('2027-02-27T00:00:00.000Z'))).toBe('2027-02-28');
    expect(cohortDateFor(new Date('2028-02-28T00:00:00.000Z'))).toBe('2028-02-29');
    expect(cohortDateFor(new Date('2027-02-28T00:00:00.000Z'))).toBe('2027-03-01');
  });
});

describe('isLeapYear', () => {
  it('H1-06: Gregorian rule (÷4, not ÷100 unless ÷400)', () => {
    expect(isLeapYear(2028)).toBe(true);
    expect(isLeapYear(2027)).toBe(false);
    expect(isLeapYear(2100)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
  });
});

describe('selectBirthdaysOn', () => {
  it('T5-01: exact month/day match on the cohort date → included, age as of the cohort', () => {
    const people = [person({ id: '1', full_name: 'Maria', birth_date: '1992-07-30' })];
    expect(selectBirthdaysOn(people, '2026-07-30')).toEqual([
      { id: '1', full_name: 'Maria', age: 34, publish: false, consentState: 'unknown' },
    ]);
  });

  it('T5-02/T5-03: the day before and the day after the cohort → excluded', () => {
    const people = [
      person({ id: '1', birth_date: '1992-07-29' }),
      person({ id: '2', birth_date: '1992-07-31' }),
    ];
    expect(selectBirthdaysOn(people, '2026-07-30')).toHaveLength(0);
  });

  it('H1-07: Dec 31 send → Jan 1 cohort, age counted in the cohort year', () => {
    const cohort = cohortDateFor(new Date('2026-12-31T00:00:00.000Z'));
    const people = [
      person({ id: '1', full_name: 'New Year', birth_date: '2000-01-01' }),
      person({ id: '2', full_name: 'Today', birth_date: '2000-12-31' }),
    ];
    expect(selectBirthdaysOn(people, cohort)).toEqual([
      { id: '1', full_name: 'New Year', age: 27, publish: false, consentState: 'unknown' },
    ]);
  });

  it('H1-08: non-leap Feb 27 send → Feb 28 cohort includes Feb-29 people', () => {
    const cohort = cohortDateFor(new Date('2027-02-27T00:00:00.000Z'));
    const people = [
      person({ id: '1', full_name: 'Feb 28', birth_date: '1990-02-28' }),
      person({ id: '2', full_name: 'Leapling', birth_date: '2000-02-29' }),
      person({ id: '3', full_name: 'Mar 1', birth_date: '1990-03-01' }),
    ];
    const result = selectBirthdaysOn(people, cohort);
    expect(result.map((p) => p.id)).toEqual(['1', '2']);
    expect(result[1].age).toBe(27);
  });

  it('H1-09: leap-year Feb 28 send → Feb 29 cohort is Feb-29 people only', () => {
    const cohort = cohortDateFor(new Date('2028-02-28T00:00:00.000Z'));
    const people = [
      person({ id: '1', birth_date: '1990-02-28' }),
      person({ id: '2', full_name: 'Leapling', birth_date: '2000-02-29' }),
      person({ id: '3', birth_date: '1990-03-01' }),
    ];
    expect(selectBirthdaysOn(people, cohort)).toEqual([
      { id: '2', full_name: 'Leapling', age: 28, publish: false, consentState: 'unknown' },
    ]);
  });

  it('H1-10: leap-year Feb 28 cohort excludes Feb-29 people (they get their own day)', () => {
    const people = [
      person({ id: '1', birth_date: '1990-02-28' }),
      person({ id: '2', birth_date: '2000-02-29' }),
    ];
    expect(selectBirthdaysOn(people, '2028-02-28').map((p) => p.id)).toEqual(['1']);
  });

  it('H1-11: non-leap Mar 1 cohort never picks up Feb-29 people', () => {
    const people = [person({ id: '1', birth_date: '2000-02-29' })];
    expect(selectBirthdaysOn(people, '2027-03-01')).toHaveLength(0);
  });

  it('T5-07: null birth_date never matches', () => {
    expect(selectBirthdaysOn([person({ id: '1', birth_date: null })], '2026-07-30')).toHaveLength(0);
  });

  it('T5-08: soft-deleted person with a matching birthday → excluded', () => {
    const people = [
      person({ id: '1', birth_date: '1990-07-30', deleted_at: '2026-01-01T00:00:00Z' }),
    ];
    expect(selectBirthdaysOn(people, '2026-07-30')).toHaveLength(0);
  });

  it('T5-09: mixed roster — only the matching, non-deleted, non-null person is selected', () => {
    const people = [
      person({ id: '1', full_name: 'Match', birth_date: '1990-07-30' }),
      person({ id: '2', full_name: 'Wrong day', birth_date: '1990-07-29' }),
      person({ id: '3', full_name: 'No birthday', birth_date: null }),
      person({ id: '4', full_name: 'Deleted', birth_date: '1990-07-30', deleted_at: '2026-01-01T00:00:00Z' }),
    ];
    expect(selectBirthdaysOn(people, '2026-07-30').map((p) => p.id)).toEqual(['1']);
  });

  it('carries both consent columns through unchanged', () => {
    const people = [
      person({ id: '1', birth_date: '1990-07-30', photo_publish_consent: true, photo_consent_state: 'refused' }),
    ];
    expect(selectBirthdaysOn(people, '2026-07-30')[0]).toMatchObject({
      publish: true,
      consentState: 'refused',
    });
  });
});

describe('formatIndonesianDate', () => {
  it('H1-12: d MMMM yyyy in Indonesian, no leading zero on the day', () => {
    expect(formatIndonesianDate('2027-01-01')).toBe('1 Januari 2027');
    expect(formatIndonesianDate('2026-12-25')).toBe('25 Desember 2026');
    expect(formatIndonesianDate('2028-02-29')).toBe('29 Februari 2028');
    expect(formatIndonesianDate('2026-05-09')).toBe('9 Mei 2026');
  });

  it('H1-13: malformed input throws', () => {
    expect(() => formatIndonesianDate('2026-13-01')).toThrow(TypeError);
    expect(() => formatIndonesianDate('2026-00-10')).toThrow(TypeError);
    expect(() => formatIndonesianDate('2026-7-1')).toThrow(TypeError);
    expect(() => formatIndonesianDate('')).toThrow(TypeError);
  });
});

describe('consentBadge (boolean is the gate; state only adds ❓)', () => {
  const OK = { emoji: '✅', label: 'boleh diucapkan di grup WA' };
  const PRIVATE = { emoji: '🔒', label: 'japri saja — tidak setuju publikasi' };
  const UNKNOWN = { emoji: '❓', label: 'belum ada jawaban — japri saja' };

  it('T4-02: publish=true → ✅ whatever the state (incl. a later grant on an "unknown" import)', () => {
    expect(consentBadge(true, 'granted')).toEqual(OK);
    expect(consentBadge(true, 'unknown')).toEqual(OK);
    expect(consentBadge(true, 'refused')).toEqual(OK);
  });

  it('T4-03: publish=false + refused → 🔒', () => {
    expect(consentBadge(false, 'refused')).toEqual(PRIVATE);
  });

  it('H1-14: publish=false + granted (admin revoked; state drifted) → 🔒, never ✅', () => {
    expect(consentBadge(false, 'granted')).toEqual(PRIVATE);
  });

  it('H1-15: publish=false + unknown → ❓ (no longer collapsed into "refused")', () => {
    expect(consentBadge(false, 'unknown')).toEqual(UNKNOWN);
  });
});

describe('formatBirthdayDigest', () => {
  it('T5-10: "besok" header with the Indonesian cohort date + one line per person with the right badge', () => {
    const text = formatBirthdayDigest(
      [
        { id: '1', full_name: 'Maria Sitorus', age: 34, publish: true, consentState: 'granted' },
        { id: '2', full_name: 'Budi Hartono', age: 41, publish: false, consentState: 'refused' },
        { id: '3', full_name: 'Ani Rahayu', age: 28, publish: false, consentState: 'unknown' },
      ],
      '2026-11-20',
    );

    expect(text).toBe(
      [
        '🎂 Ulang tahun besok — 20 November 2026 (3)',
        '  • Maria Sitorus (34)     ✅ boleh diucapkan di grup WA',
        '  • Budi Hartono (41)     🔒 japri saja — tidak setuju publikasi',
        '  • Ani Rahayu (28)     ❓ belum ada jawaban — japri saja',
      ].join('\n'),
    );
  });

  it('T5-11: empty list still renders a valid header (not used in practice — empty days skip the send)', () => {
    expect(formatBirthdayDigest([], '2027-01-01')).toBe('🎂 Ulang tahun besok — 1 Januari 2027 (0)');
  });
});
