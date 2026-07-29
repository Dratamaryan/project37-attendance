import { describe, it, expect } from 'vitest';
import {
  computeIctDayBounds,
  groupAttendanceByInstance,
  formatAttendanceSummary,
  type AttendanceRow,
  type InstanceAttendance,
} from '@/lib/events/attendance-summary';

function row(overrides: Partial<AttendanceRow> & { event_instance_id: string; full_name: string }): AttendanceRow {
  return {
    checked_in_at: '2026-07-29T12:00:00.000Z',
    event_name_snapshot: 'Project Day',
    event_name_snapshot_id: null,
    scheduled_at: '2026-07-29T11:00:00.000Z',
    instance_status: 'scheduled',
    ...overrides,
  };
}

describe('computeIctDayBounds', () => {
  it('T6-01: mid-window now → correct ictDate and both boundaries', () => {
    const now = new Date('2026-07-29T16:30:00.000Z'); // 23:30 ICT
    const bounds = computeIctDayBounds(now);
    expect(bounds.ictDate).toBe('2026-07-29');
    expect(bounds.startUtc.toISOString()).toBe('2026-07-28T17:00:00.000Z');
    expect(bounds.endUtc.toISOString()).toBe('2026-07-29T17:00:00.000Z');
  });

  it('T6-02 (discriminating case): "today" in ICT is a different UTC calendar date at the same instant', () => {
    // 2026-07-29T20:00:00Z is 2026-07-30 03:00 in Asia/Jakarta — ICT date is
    // already the 30th while UTC's calendar date is still the 29th. A window
    // built on `now.toISOString().slice(0,10)` would compute the wrong day.
    const now = new Date('2026-07-29T20:00:00.000Z');
    const bounds = computeIctDayBounds(now);
    expect(bounds.ictDate).toBe('2026-07-30');
    expect(bounds.startUtc.toISOString()).toBe('2026-07-29T17:00:00.000Z');
    expect(bounds.endUtc.toISOString()).toBe('2026-07-30T17:00:00.000Z');

    // A check-in 1ms inside the window (bottom, inclusive) is included; the
    // caller applies `.gte(startUtc).lt(endUtc)`, asserted here directly.
    const justInside = new Date(bounds.startUtc.getTime());
    expect(justInside >= bounds.startUtc && justInside < bounds.endUtc).toBe(true);

    // 1ms before the start boundary — excluded (belongs to the prior ICT day).
    const justBefore = new Date(bounds.startUtc.getTime() - 1);
    expect(justBefore >= bounds.startUtc && justBefore < bounds.endUtc).toBe(false);

    // Exactly at the end boundary — excluded (exclusive top).
    expect(bounds.endUtc >= bounds.startUtc && bounds.endUtc < bounds.endUtc).toBe(false);

    // 1ms before the end boundary — included.
    const justBeforeEnd = new Date(bounds.endUtc.getTime() - 1);
    expect(justBeforeEnd >= bounds.startUtc && justBeforeEnd < bounds.endUtc).toBe(true);
  });
});

describe('groupAttendanceByInstance', () => {
  it('T6-03: groups by instance, orders instances by scheduled_at, preserves attendee input order', () => {
    const rows: AttendanceRow[] = [
      row({ event_instance_id: 'b', full_name: 'Second Instance Person', scheduled_at: '2026-07-29T13:00:00.000Z' }),
      row({ event_instance_id: 'a', full_name: 'First A', scheduled_at: '2026-07-29T10:00:00.000Z' }),
      row({ event_instance_id: 'a', full_name: 'Second A', scheduled_at: '2026-07-29T10:00:00.000Z' }),
    ];
    const result = groupAttendanceByInstance(rows);
    expect(result.map((i) => i.event_instance_id)).toEqual(['a', 'b']);
    expect(result[0].attendees).toEqual(['First A', 'Second A']);
    expect(result[1].attendees).toEqual(['Second Instance Person']);
  });

  it('T6-04: cancelled instance label is annotated, not hidden', () => {
    const rows: AttendanceRow[] = [
      row({
        event_instance_id: 'c',
        full_name: 'Attended Anyway',
        instance_status: 'cancelled',
        event_name_snapshot: 'Project Day',
        scheduled_at: '2026-07-29T13:00:00.000Z',
      }),
    ];
    const result = groupAttendanceByInstance(rows);
    expect(result[0].label).toContain('dibatalkan');
    expect(result[0].attendees).toEqual(['Attended Anyway']);
  });

  it('T6-05: event_name_snapshot_id preferred over event_name_snapshot when present', () => {
    const rows: AttendanceRow[] = [
      row({
        event_instance_id: 'd',
        full_name: 'Someone',
        event_name_snapshot: 'Project Day',
        event_name_snapshot_id: 'Hari Project',
      }),
    ];
    const result = groupAttendanceByInstance(rows);
    expect(result[0].label).toContain('Hari Project');
    expect(result[0].label).not.toContain('Project Day');
  });
});

describe('formatAttendanceSummary', () => {
  it('T6-06: small case renders header total + per-instance headers + attendee lines', () => {
    const instances: InstanceAttendance[] = [
      {
        event_instance_id: 'a',
        label: 'Project Day — 18:00',
        scheduled_at: '2026-07-29T11:00:00.000Z',
        attendees: ['Maria Sitorus', 'Budi Hartono'],
      },
    ];
    const text = formatAttendanceSummary(instances);
    expect(text).toBe(
      [
        '📋 Ringkasan Kehadiran Hari Ini (2)',
        '',
        '🗓 Project Day — 18:00 (2)',
        '  • Maria Sitorus',
        '  • Budi Hartono',
      ].join('\n'),
    );
  });

  it('T6-07: empty instance list still renders a valid header (not used in practice — empty days skip the send)', () => {
    expect(formatAttendanceSummary([])).toBe('📋 Ringkasan Kehadiran Hari Ini (0)');
  });

  it('T4-11: 55-attendee single instance truncates under 4096 chars with an accurate omitted count', () => {
    // Pessimistically long names (full_name has no DB length constraint —
    // see attendance-summary.ts's comment) to force truncation deterministically,
    // proving the mechanism rather than assuming realistic ~16-24 char names.
    const attendees = Array.from(
      { length: 55 },
      (_, i) => `Attendee With A Very Long Full Name For Truncation Testing Purposes Number ${i + 1}`,
    );
    const instances: InstanceAttendance[] = [
      {
        event_instance_id: 'big',
        label: 'Project Day — 18:00',
        scheduled_at: '2026-07-29T11:00:00.000Z',
        attendees,
      },
    ];
    const text = formatAttendanceSummary(instances);

    expect(text.length).toBeLessThan(4096);
    expect(text).toContain('📋 Ringkasan Kehadiran Hari Ini (55)');

    const match = text.match(/…dan (\d+) lainnya$/);
    expect(match).not.toBeNull();
    const omittedCount = Number(match![1]);
    const shownCount = (text.match(/\n  • /g) ?? []).length;
    expect(shownCount + omittedCount).toBe(55);
    expect(omittedCount).toBeGreaterThan(0);
  });

  it('T6-08: multi-instance overflow — first instance fits fully, second is entirely omitted', () => {
    const fittingAttendees = Array.from({ length: 3 }, (_, i) => `Fits ${i + 1}`);
    const overflowAttendees = Array.from({ length: 80 }, (_, i) => `Overflow Attendee With A Longer Name ${i + 1}`);
    const instances: InstanceAttendance[] = [
      {
        event_instance_id: 'a',
        label: 'Small Gathering — 09:00',
        scheduled_at: '2026-07-29T02:00:00.000Z',
        attendees: fittingAttendees,
      },
      {
        event_instance_id: 'b',
        label: 'Project Day — 18:00',
        scheduled_at: '2026-07-29T11:00:00.000Z',
        attendees: overflowAttendees,
      },
    ];
    // Cap sized so instance A (header + 3 short lines) fits, but instance B's
    // own header line doesn't — forcing the whole-instance-omitted branch
    // rather than a mid-instance cutoff (covered separately by T4-11 above).
    const text = formatAttendanceSummary(instances, 150);

    expect(text.length).toBeLessThan(150 + 40);
    expect(text).toContain('Fits 1');
    expect(text).toContain('Fits 2');
    expect(text).toContain('Fits 3');
    expect(text).not.toContain('Overflow Attendee');

    const match = text.match(/…dan (\d+) lainnya$/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(80);
  });
});
