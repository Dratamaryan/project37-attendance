// Pure RFC 5545 .ics generator for event instances.
// No Supabase imports, no I/O — fully unit-testable. Callers (T9) resolve
// event_instances + events fields (and per-recipient locale) before calling in.

import { formatJakarta } from './timezone';

export interface IcsEventInput {
  /** event_instances.id — the source of UID identity. Must be stable across calls. */
  eventInstanceId: string;
  /** Resolved display name (caller picks EN/ID snapshot per recipient locale). */
  summary: string;
  /** events.location — nullable; LOCATION line is omitted entirely when absent. */
  location?: string | null;
  /** event_instances.scheduled_at — UTC instant. */
  scheduledAt: Date;
  /** events.duration_min. */
  durationMin: number;
  /** Increments on resend of the same instance — same UID, higher SEQUENCE updates the calendar entry. */
  sequence: number;
  /** When the .ics was generated. Defaults to now(); injectable for deterministic tests. */
  dtstamp?: Date;
  /**
   * Sending account address (T9 starting position — see plan). When provided
   * together with attendeeEmail, emits ORGANIZER/ATTENDEE so clients that
   * require them (Outlook/Exchange) render METHOD:REQUEST as an actual
   * Accept/Decline invitation rather than a passive calendar add. Omit both to
   * keep the T7 shape (no ORGANIZER/ATTENDEE) for callers that don't need it.
   */
  organizerEmail?: string;
  /** Recipient's address — makes the .ics per-recipient, not shared, once set. */
  attendeeEmail?: string;
  /** Recipient's display name for the ATTENDEE CN param. */
  attendeeName?: string;
}

const ICS_UID_DOMAIN = 'project37-attendance.vercel.app';
const PRODID = '-//Project 37//Attendance ICS//EN';
const FOLD_LIMIT_OCTETS = 75;
const JAKARTA_LOCAL_FORMAT = "yyyyMMdd'T'HHmmss";

/**
 * CN is a display hint, not data with semantic import. COMMA/SEMICOLON/COLON/
 * DQUOTE would break unquoted RFC 5545 param-value syntax (§3.2), and quoted-
 * string support for embedded semicolons is inconsistent across real .ics
 * parsers. Strip rather than escape or quote — losing punctuation from a
 * display name is a cosmetic degradation, not a correctness bug.
 */
function sanitizeParamValue(value: string): string {
  return value.replace(/[,;:"]/g, '');
}

/**
 * Escapes COMMA, SEMICOLON, BACKSLASH, and NEWLINE per RFC 5545 §3.3.11.
 * Backslash must be escaped first, or a later-inserted backslash gets re-escaped.
 */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
    .replace(/\r\n|\n|\r/g, '\\n');
}

/**
 * Folds a single content line at 75 octets (not characters) per RFC 5545 §3.1.
 * Continuation lines are CRLF + a single leading space, which itself counts
 * toward that continuation line's 75-octet budget.
 */
function foldLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= FOLD_LIMIT_OCTETS) {
    return line;
  }

  const chars = Array.from(line);
  const segments: string[] = [];
  let current = '';
  let currentBytes = 0;

  for (const char of chars) {
    const charBytes = encoder.encode(char).length;
    const budget = segments.length === 0 ? FOLD_LIMIT_OCTETS : FOLD_LIMIT_OCTETS - 1;
    if (currentBytes + charBytes > budget && current.length > 0) {
      segments.push(current);
      current = char;
      currentBytes = charBytes;
    } else {
      current += char;
      currentBytes += charBytes;
    }
  }
  if (current.length > 0) {
    segments.push(current);
  }

  return segments.join('\r\n ');
}

function formatUtcStamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

/**
 * Generates an RFC 5545 VCALENDAR/VEVENT (METHOD:REQUEST) as a CRLF string.
 *
 * UID = `{eventInstanceId}@project37-attendance.vercel.app` — stable forever for
 * a given instance, so a resent invite (same UID, higher SEQUENCE) updates the
 * recipient's existing calendar entry instead of duplicating it. DTSTART/DTEND
 * use `TZID=Asia/Jakarta` with a static VTIMEZONE block (WIB has no DST, so no
 * transition rules are needed) so recipients see the correct local time.
 */
export function generateIcs(input: IcsEventInput): string {
  const dtstamp = input.dtstamp ?? new Date();
  const startLocal = formatJakarta(input.scheduledAt, JAKARTA_LOCAL_FORMAT);
  const endInstant = new Date(input.scheduledAt.getTime() + input.durationMin * 60_000);
  const endLocal = formatJakarta(endInstant, JAKARTA_LOCAL_FORMAT);

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'METHOD:REQUEST',
    'BEGIN:VTIMEZONE',
    'TZID:Asia/Jakarta',
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    'TZOFFSETFROM:+0700',
    'TZOFFSETTO:+0700',
    'TZNAME:WIB',
    'END:STANDARD',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    `UID:${input.eventInstanceId}@${ICS_UID_DOMAIN}`,
    `DTSTAMP:${formatUtcStamp(dtstamp)}`,
    `DTSTART;TZID=Asia/Jakarta:${startLocal}`,
    `DTEND;TZID=Asia/Jakarta:${endLocal}`,
    `SUMMARY:${escapeText(input.summary)}`,
  ];

  if (input.location) {
    lines.push(`LOCATION:${escapeText(input.location)}`);
  }

  if (input.organizerEmail) {
    lines.push(`ORGANIZER;CN=Project 37:mailto:${input.organizerEmail}`);
  }
  if (input.attendeeEmail) {
    const cn = input.attendeeName ? sanitizeParamValue(input.attendeeName) : input.attendeeEmail;
    lines.push(`ATTENDEE;CN=${cn};RSVP=TRUE:mailto:${input.attendeeEmail}`);
  }

  lines.push(`SEQUENCE:${input.sequence}`, 'END:VEVENT', 'END:VCALENDAR');

  return lines.map(foldLine).join('\r\n') + '\r\n';
}
