// Formats a Postgres `date` column ('YYYY-MM-DD', no time/zone component) for
// display. String-sliced, never routed through a `Date` object — a `Date`
// constructed from a date-only string gets parsed as UTC midnight and can
// then shift a day in either direction once re-rendered in the viewer's local
// zone (see lib/events/birthday-digest.ts for the same constraint on the
// birthday-digest read path). Do not use this for timestamptz values.
export function formatDateOnly(isoDate: string | null): string {
  return isoDate === null ? '' : isoDate.slice(0, 10)
}
