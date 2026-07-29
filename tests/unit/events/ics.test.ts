import { describe, it, expect } from 'vitest';
import * as ical from 'node-ical';
import { generateIcs } from '@/lib/events/ics';

const BASE_INPUT = {
  eventInstanceId: '89d145c5-b9d5-4190-9ca5-e7d50d649e07',
  summary: 'Project Day',
  location: 'Hotel Neo Puri Indah',
  scheduledAt: new Date('2026-07-10T11:00:00.000Z'), // 18:00 Jakarta
  durationMin: 120,
  sequence: 0,
  dtstamp: new Date('2026-07-01T00:00:00.000Z'),
};

function parseVEvent(icsString: string) {
  const parsed = ical.sync.parseICS(icsString);
  const event = Object.values(parsed).find((c) => c?.type === 'VEVENT');
  if (!event || event.type !== 'VEVENT') {
    throw new Error('No VEVENT found in parsed .ics');
  }
  return event;
}

describe('generateIcs — golden file', () => {
  it('ICS-01 contains all required RFC 5545 properties with CRLF line endings', () => {
    const output = generateIcs(BASE_INPUT);

    expect(output).toContain('\r\n');
    expect(output.includes('\n') && !output.includes('\r\n')).toBe(false); // no bare LF
    for (const required of [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:',
      'METHOD:REQUEST',
      'BEGIN:VEVENT',
      'UID:',
      'DTSTAMP:',
      'DTSTART;TZID=Asia/Jakarta:',
      'DTEND;TZID=Asia/Jakarta:',
      'SUMMARY:',
      'SEQUENCE:0',
      'END:VEVENT',
      'END:VCALENDAR',
    ]) {
      expect(output).toContain(required);
    }
  });

  it('ICS-02 UID matches the {eventInstanceId}@project37-attendance.vercel.app scheme', () => {
    const output = generateIcs(BASE_INPUT);
    expect(output).toContain(`UID:${BASE_INPUT.eventInstanceId}@project37-attendance.vercel.app`);
  });

  it('ICS-03 includes a static Asia/Jakarta VTIMEZONE block (no DST rules)', () => {
    const output = generateIcs(BASE_INPUT);
    expect(output).toContain('BEGIN:VTIMEZONE');
    expect(output).toContain('TZID:Asia/Jakarta');
    expect(output).toContain('TZOFFSETFROM:+0700');
    expect(output).toContain('TZOFFSETTO:+0700');
    expect(output).toContain('END:VTIMEZONE');
  });

  it('ICS-04 DTSTAMP is distinct from DTSTART/DTEND (generation time, not event time)', () => {
    const output = generateIcs(BASE_INPUT);
    expect(output).toContain('DTSTAMP:20260701T000000Z');
    expect(output).toContain('DTSTART;TZID=Asia/Jakarta:20260710T180000');
    expect(output).toContain('DTEND;TZID=Asia/Jakarta:20260710T200000');
  });

  it('ICS-05 omits LOCATION entirely when location is null (real prod seed data has no location)', () => {
    const output = generateIcs({ ...BASE_INPUT, location: null });
    expect(output).not.toContain('LOCATION:');
  });
});

describe('generateIcs — round-trip parse (node-ical)', () => {
  it('ICS-06 parses back with the correct UID, summary, location, and sequence', () => {
    const output = generateIcs(BASE_INPUT);
    const event = parseVEvent(output);

    expect(event.uid).toBe(`${BASE_INPUT.eventInstanceId}@project37-attendance.vercel.app`);
    expect(event.summary).toBe('Project Day');
    expect(event.location).toBe('Hotel Neo Puri Indah');
    expect(event.sequence).toBe(0);
  });

  it('ICS-07 parses to the correct ABSOLUTE UTC instant for start and end, not a floating wall-clock number', () => {
    const output = generateIcs(BASE_INPUT);
    const event = parseVEvent(output);

    // 18:00 Jakarta on 2026-07-10 = 11:00:00.000Z. If the parser (or the generator)
    // treated DTSTART as floating/UTC instead of applying the VTIMEZONE +7 offset,
    // this would resolve to a different absolute instant even though it "looks" fine.
    expect(event.start.getTime()).toBe(new Date('2026-07-10T11:00:00.000Z').getTime());
    expect(event.end?.getTime()).toBe(new Date('2026-07-10T13:00:00.000Z').getTime());
  });
});

describe('generateIcs — escaping', () => {
  const dirty = {
    ...BASE_INPUT,
    summary: 'Project Day, Session 2; Special\\Edition',
    location: 'Hall A, Building B; Wing\\C',
  };

  it('ICS-08 escapes comma, semicolon, and backslash in SUMMARY/LOCATION in the raw output', () => {
    const output = generateIcs(dirty);
    expect(output).toContain('SUMMARY:Project Day\\, Session 2\\; Special\\\\Edition');
    expect(output).toContain('LOCATION:Hall A\\, Building B\\; Wing\\\\C');
  });

  it('ICS-09 round-trip parse recovers the original unescaped summary and location', () => {
    const output = generateIcs(dirty);
    const event = parseVEvent(output);

    expect(event.summary).toBe(dirty.summary);
    expect(event.location).toBe(dirty.location);
  });
});

describe('generateIcs — 75-octet line folding', () => {
  const longLocation =
    'Hotel Neo Puri Indah, Jl. Puri Indah Raya, Blok Z1, Kembangan, Jakarta Barat, DKI Jakarta 11610, Indonesia';
  const withLongLocation = { ...BASE_INPUT, location: longLocation };

  it('ICS-10 raw output folds the long LOCATION line with CRLF + a leading space', () => {
    const output = generateIcs(withLongLocation);
    const lines = output.split('\r\n');
    const locationLineIndex = lines.findIndex((line) => line.startsWith('LOCATION:'));
    expect(locationLineIndex).toBeGreaterThanOrEqual(0);

    // the line immediately after LOCATION: must be a fold continuation (leading space)
    const continuation = lines[locationLineIndex + 1];
    expect(continuation.startsWith(' ')).toBe(true);

    // every physical line must be <=75 octets
    const encoder = new TextEncoder();
    for (const line of lines) {
      expect(encoder.encode(line).length).toBeLessThanOrEqual(75);
    }
  });

  it('ICS-11 round-trip parse reconstructs the original unfolded LOCATION value', () => {
    const output = generateIcs(withLongLocation);
    const event = parseVEvent(output);
    expect(event.location).toBe(longLocation);
  });
});

describe('generateIcs — UID stability', () => {
  it('ICS-12 the same event instance produces the same UID across two separate calls', () => {
    const first = generateIcs(BASE_INPUT);
    const second = generateIcs({ ...BASE_INPUT, dtstamp: new Date('2026-08-01T00:00:00.000Z') });

    const firstUid = first.match(/UID:([^\r\n]+)/)?.[1];
    const secondUid = second.match(/UID:([^\r\n]+)/)?.[1];

    expect(firstUid).toBeDefined();
    expect(firstUid).toBe(secondUid);
  });
});

describe('generateIcs — SEQUENCE (resend-updates-not-duplicates)', () => {
  it('ICS-13 same instance, sequence 0 vs 1: same UID, different SEQUENCE', () => {
    const first = generateIcs({ ...BASE_INPUT, sequence: 0 });
    const second = generateIcs({ ...BASE_INPUT, sequence: 1 });

    const firstEvent = parseVEvent(first);
    const secondEvent = parseVEvent(second);

    expect(firstEvent.uid).toBe(secondEvent.uid);
    expect(firstEvent.sequence).toBe(0);
    expect(secondEvent.sequence).toBe(1);
  });
});

describe('generateIcs — ORGANIZER/ATTENDEE (T9, additive/backward-compatible)', () => {
  it('ICS-14 omits ORGANIZER/ATTENDEE entirely when neither is provided (T7 shape unchanged)', () => {
    const output = generateIcs(BASE_INPUT);
    expect(output).not.toContain('ORGANIZER');
    expect(output).not.toContain('ATTENDEE');
  });

  it('ICS-15 emits ORGANIZER and ATTENDEE with CN + mailto when both are provided', () => {
    const output = generateIcs({
      ...BASE_INPUT,
      organizerEmail: 'project37.events@gmail.com',
      attendeeEmail: 'jane@example.com',
      attendeeName: 'Jane Doe',
    });
    expect(output).toContain('ORGANIZER;CN=Project 37:mailto:project37.events@gmail.com');
    expect(output).toContain('ATTENDEE;CN=Jane Doe;RSVP=TRUE:mailto:jane@example.com');
  });

  it('ICS-16 round-trip parse recovers ORGANIZER and ATTENDEE with correct params', () => {
    const output = generateIcs({
      ...BASE_INPUT,
      organizerEmail: 'project37.events@gmail.com',
      attendeeEmail: 'jane@example.com',
      attendeeName: 'Jane Doe',
    });
    const event = parseVEvent(output);

    // node-ical types organizer/attendee loosely (string | object) — narrow at the test boundary.
    const organizer = event.organizer as unknown as { val: string; params: { CN: string } };
    const attendee = event.attendee as unknown as { val: string; params: { CN: string; RSVP: boolean } };

    expect(organizer.val).toBe('mailto:project37.events@gmail.com');
    expect(organizer.params.CN).toBe('Project 37');
    expect(attendee.val).toBe('mailto:jane@example.com');
    expect(attendee.params.CN).toBe('Jane Doe');
    expect(attendee.params.RSVP).toBe(true);
  });

  it('ICS-17 falls back to the raw attendeeEmail as CN when attendeeName is omitted', () => {
    const output = generateIcs({
      ...BASE_INPUT,
      organizerEmail: 'project37.events@gmail.com',
      attendeeEmail: 'jane@example.com',
    });
    expect(output).toContain('ATTENDEE;CN=jane@example.com;RSVP=TRUE:mailto:jane@example.com');
  });

  it('ICS-18 strips comma/semicolon from attendeeName within the CN param (display-only, not escaped/quoted)', () => {
    const output = generateIcs({
      ...BASE_INPUT,
      organizerEmail: 'project37.events@gmail.com',
      attendeeEmail: 'jane@example.com',
      attendeeName: 'Doe, Jane; Jr.',
    });
    // Backslash-escaping (TEXT value syntax) and unescaped raw punctuation both
    // produce invalid/ambiguous param-value syntax here (RFC 5545 §3.2) — and
    // quoted-string support for embedded semicolons is inconsistent across
    // real .ics parsers (confirmed against node-ical directly). Stripping is
    // the simple, unambiguous choice for what is only ever a display hint.
    expect(output).toContain('ATTENDEE;CN=Doe Jane Jr.;RSVP=TRUE:mailto:jane@example.com');
  });
});
