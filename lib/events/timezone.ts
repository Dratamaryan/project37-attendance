import { fromZonedTime, formatInTimeZone, toZonedTime } from 'date-fns-tz';

export const JAKARTA_TZ = 'Asia/Jakarta';

/**
 * Combines a calendar date and wall-clock time, interpreted as Asia/Jakarta
 * wall-time, and returns the corresponding UTC instant as a Date.
 *
 * When `date` is a string ('YYYY-MM-DD'), it is used directly as the calendar date.
 * When `date` is a Date object, its calendar date is extracted in the Jakarta zone
 * (i.e. year/month/day as seen in UTC+7), not in the system locale.
 *
 * Example: toJakartaInstant('2026-07-10', '18:00')
 *   → Date representing 2026-07-10T11:00:00.000Z
 *
 * Throws TypeError on malformed inputs.
 */
export function toJakartaInstant(date: Date | string, time: string): Date {
  let dateStr: string;
  if (date instanceof Date) {
    // Extract year/month/day in Jakarta zone, not system locale
    const zoned = toZonedTime(date, JAKARTA_TZ);
    const y = zoned.getFullYear();
    const m = String(zoned.getMonth() + 1).padStart(2, '0');
    const d = String(zoned.getDate()).padStart(2, '0');
    dateStr = `${y}-${m}-${d}`;
  } else {
    dateStr = date;
  }

  const result = fromZonedTime(`${dateStr}T${time}`, JAKARTA_TZ);

  if (isNaN(result.getTime())) {
    throw new TypeError(`Invalid date or time: date="${dateStr}", time="${time}"`);
  }

  return result;
}

/**
 * Formats a UTC Date as a string in Asia/Jakarta using date-fns format tokens.
 *
 * Example: formatJakarta(new Date('2026-07-10T11:00:00Z'), 'yyyy-MM-dd HH:mm')
 *   → '2026-07-10 18:00'
 */
export function formatJakarta(instant: Date, formatString: string): string {
  return formatInTimeZone(instant, JAKARTA_TZ, formatString);
}

/**
 * WIB calendar date ('yyyy-MM-dd') on which an instance ends. scheduled_at is
 * a full timestamptz (explicit offset), so parsing it yields an exact instant;
 * the calendar date is only ever derived in Asia/Jakarta via formatJakarta.
 *
 * SQL twin: public.rsvp_instance_open() (20261020120000_sprint9_r0_rsvp.sql) —
 * parity covered by tests/integration/rsvp-rpc.test.ts.
 */
export function instanceEndWibDate(scheduledAt: string, durationMin: number): string {
  const endInstant = new Date(Date.parse(scheduledAt) + durationMin * 60_000);
  return formatJakarta(endInstant, 'yyyy-MM-dd');
}
