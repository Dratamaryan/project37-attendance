import { RRule } from 'rrule';
import { addMonths } from 'date-fns';
import { toJakartaInstant } from './timezone';

export type ExpandResult =
  | { status: 'ok'; occurrences: Date[] }
  | { status: 'invalid_rrule'; message: string }
  | { status: 'invalid_input'; message: string };

export type ExpandInput = {
  /** RFC 5545 RRULE string, or null for adhoc (single occurrence) */
  recurrenceRule: string | null;
  /** 'YYYY-MM-DD', interpreted in Asia/Jakarta */
  startDate: string;
  /** 'HH:mm' (or 'HH:mm:ss'), interpreted as Asia/Jakarta wall-time */
  startTime: string;
  /** Forward window in months, typically from app_settings.materialization_horizon_mo */
  horizonMonths: number;
  /** Injectable for tests; defaults to new Date() */
  now?: Date;
};

/**
 * Expands a recurrence rule into UTC instants within the materialization window.
 *
 * Window: [max(now, startInstant), now + horizonMonths], inclusive both ends.
 *
 * Returns discriminated union — caller branches on status. Never throws on
 * user-input errors (invalid date/time, bad RRULE string). Programmer errors
 * (e.g. non-numeric horizonMonths) remain uncaught and propagate as exceptions.
 */
export function expandRRule(input: ExpandInput): ExpandResult {
  const { recurrenceRule, startDate, startTime, horizonMonths, now: nowOverride } = input;
  const now = nowOverride ?? new Date();

  let startInstant: Date;
  try {
    startInstant = toJakartaInstant(startDate, startTime);
  } catch (e) {
    return {
      status: 'invalid_input',
      message: e instanceof Error ? e.message : String(e),
    };
  }

  const windowStart = startInstant > now ? startInstant : now;
  const windowEnd = addMonths(now, horizonMonths);

  // Adhoc: single occurrence
  if (recurrenceRule === null) {
    const inWindow = startInstant >= windowStart && startInstant <= windowEnd;
    return { status: 'ok', occurrences: inWindow ? [startInstant] : [] };
  }

  // RRULE: parse then expand with dtstart override
  let rule: RRule;
  try {
    const parsed = RRule.fromString(recurrenceRule);
    rule = new RRule({ ...parsed.origOptions, dtstart: startInstant });
  } catch (e) {
    return {
      status: 'invalid_rrule',
      message: e instanceof Error ? e.message : String(e),
    };
  }

  try {
    const occurrences = rule.between(windowStart, windowEnd, true);
    return { status: 'ok', occurrences };
  } catch (e) {
    return {
      status: 'invalid_rrule',
      message: e instanceof Error ? e.message : String(e),
    };
  }
}
