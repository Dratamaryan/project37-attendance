// Formats a Postgres `date` column ('YYYY-MM-DD', no time/zone component) for
// display. String-sliced, never routed through a `Date` object — a `Date`
// constructed from a date-only string gets parsed as UTC midnight and can
// then shift a day in either direction once re-rendered in the viewer's local
// zone (see lib/events/birthday-digest.ts for the same constraint on the
// birthday-digest read path). Do not use this for timestamptz values.
export function formatDateOnly(isoDate: string | null): string {
  return isoDate === null ? '' : isoDate.slice(0, 10)
}

// Formats a Postgres `date` column as "<day> <month>" (e.g. '14 Mar'). Same
// string-slice discipline as formatDateOnly — no `Date`, no parsing — so it can
// never shift a day. monthNames is supplied by the caller (from i18n), keeping
// this helper locale-agnostic; index 0 is January.
export function formatDayMonth(isoDate: string | null, monthNames: string[]): string {
  if (isoDate === null) return '—'
  const day = Number(isoDate.slice(8, 10))
  const monthIdx = Number(isoDate.slice(5, 7)) - 1
  return `${day} ${monthNames[monthIdx]}`
}
