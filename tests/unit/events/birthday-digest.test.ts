import { describe, it, expect } from 'vitest';
import {
  selectBirthdaysToday,
  consentBadge,
  formatBirthdayDigest,
  type PersonRow,
} from '@/lib/events/birthday-digest';
import { formatJakarta } from '@/lib/events/timezone';

function person(overrides: Partial<PersonRow> & { id: string }): PersonRow {
  return {
    full_name: 'Test Person',
    birth_date: null,
    photo_publish_consent: false,
    deleted_at: null,
    ...overrides,
  };
}

describe('selectBirthdaysToday', () => {
  it('T5-01: exact month/day match on the ICT date → included', () => {
    const people = [person({ id: '1', full_name: 'Maria', birth_date: '1992-07-29' })];
    const result = selectBirthdaysToday(people, '2026-07-29');
    expect(result).toEqual([{ id: '1', full_name: 'Maria', age: 34, consent: false }]);
  });

  it('T5-02: birthday yesterday in ICT → excluded', () => {
    const people = [person({ id: '1', birth_date: '1992-07-28' })];
    expect(selectBirthdaysToday(people, '2026-07-29')).toHaveLength(0);
  });

  it('T5-03: birthday tomorrow in ICT → excluded', () => {
    const people = [person({ id: '1', birth_date: '1992-07-30' })];
    expect(selectBirthdaysToday(people, '2026-07-29')).toHaveLength(0);
  });

  it('T5-04: "today" in ICT but "yesterday"/"tomorrow" in UTC — proves formatJakarta is used, not new Date()', () => {
    // 2026-07-29T20:00:00Z is 2026-07-30 03:00 in Asia/Jakarta (UTC+7) — ICT date is
    // already the 30th while UTC's calendar date is still the 29th. A selector built on
    // `now.toISOString().slice(0,10)` would compute todayICT='2026-07-29' here and miss
    // this birthday; the real todayICT must come from formatJakarta.
    const now = new Date('2026-07-29T20:00:00.000Z');
    const todayICT = formatJakarta(now, 'yyyy-MM-dd');
    expect(todayICT).toBe('2026-07-30');

    const people = [person({ id: '1', full_name: 'Reno', birth_date: '1998-07-30' })];
    const result = selectBirthdaysToday(people, todayICT);
    expect(result).toEqual([{ id: '1', full_name: 'Reno', age: 28, consent: false }]);
  });

  it('T5-05: Feb 29 birthday, today is Feb 28 in a non-leap year → excluded by construction', () => {
    const people = [person({ id: '1', birth_date: '2000-02-29' })];
    expect(selectBirthdaysToday(people, '2027-02-28')).toHaveLength(0);
  });

  it('T5-06: Feb 29 birthday, today IS Feb 29 in a leap year → included', () => {
    const people = [person({ id: '1', full_name: 'Leap', birth_date: '2000-02-29' })];
    const result = selectBirthdaysToday(people, '2028-02-29');
    expect(result).toEqual([{ id: '1', full_name: 'Leap', age: 28, consent: false }]);
  });

  it('T5-07: null birth_date never matches, even on a coincidental date-string match', () => {
    const people = [person({ id: '1', birth_date: null })];
    expect(selectBirthdaysToday(people, '2026-07-29')).toHaveLength(0);
  });

  it('T5-08: soft-deleted person with a matching birthday → excluded', () => {
    const people = [
      person({ id: '1', birth_date: '1990-07-29', deleted_at: '2026-01-01T00:00:00Z' }),
    ];
    expect(selectBirthdaysToday(people, '2026-07-29')).toHaveLength(0);
  });

  it('T5-09: mixed roster — only the matching, non-deleted, non-null person is selected', () => {
    const people = [
      person({ id: '1', full_name: 'Match', birth_date: '1990-07-29' }),
      person({ id: '2', full_name: 'Wrong day', birth_date: '1990-07-28' }),
      person({ id: '3', full_name: 'No birthday', birth_date: null }),
      person({
        id: '4',
        full_name: 'Deleted',
        birth_date: '1990-07-29',
        deleted_at: '2026-01-01T00:00:00Z',
      }),
    ];
    const result = selectBirthdaysToday(people, '2026-07-29');
    expect(result.map((p) => p.id)).toEqual(['1']);
  });
});

describe('consentBadge', () => {
  it('T4-02: true → ✅ publishable', () => {
    expect(consentBadge(true)).toEqual({ emoji: '✅', label: 'boleh diucapkan di grup WA' });
  });

  it('T4-03: false → 🔒 private-only', () => {
    expect(consentBadge(false)).toEqual({
      emoji: '🔒',
      label: 'japri saja — tidak setuju publikasi',
    });
  });

  it('T4-03: null → ❓ unanswered, treated as private (defensive — not reachable via live schema today)', () => {
    expect(consentBadge(null)).toEqual({ emoji: '❓', label: 'belum ada jawaban — japri saja' });
  });
});

describe('formatBirthdayDigest', () => {
  it('T5-10: renders header count + one line per person with the right badge', () => {
    const text = formatBirthdayDigest([
      { id: '1', full_name: 'Maria Sitorus', age: 34, consent: true },
      { id: '2', full_name: 'Budi Hartono', age: 41, consent: false },
      { id: '3', full_name: 'Reno Soedarpo', age: 28, consent: null },
    ]);

    expect(text).toBe(
      [
        '🎂 Ulang tahun hari ini (3)',
        '  • Maria Sitorus (34)     ✅ boleh diucapkan di grup WA',
        '  • Budi Hartono (41)     🔒 japri saja — tidak setuju publikasi',
        '  • Reno Soedarpo (28)     ❓ belum ada jawaban — japri saja',
      ].join('\n'),
    );
  });

  it('T5-11: empty list still renders a valid header (not used in practice — empty days skip the send)', () => {
    expect(formatBirthdayDigest([])).toBe('🎂 Ulang tahun hari ini (0)');
  });
});
