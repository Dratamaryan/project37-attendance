// Name-search query sanitization — shared by the server action (people.impl.ts)
// and the check-in client, which uses it to decide when to fire the lookup.
// Client-safe: no server-only imports, no DB access.

/** Minimum sanitized length before a name lookup is allowed to run. */
export const NAME_QUERY_MIN_LENGTH = 3

// Whitelist: unicode letters, space, hyphen, apostrophe — everything else is
// dropped. This is what keeps the value safe to interpolate into a PostgREST
// `.or()` filter string, where `,` separates conditions and `.` separates a
// condition's parts, and into an ILIKE pattern, where `%` and `_` are wildcards.
// Deny-listing those characters individually would be fragile; a whitelist is
// closed by construction.
const DISALLOWED = /[^\p{L} \-']/gu

/**
 * Strips every character outside the whitelist, collapses runs of whitespace,
 * and trims. Always returns a string that is safe to embed in a filter — callers
 * must still enforce NAME_QUERY_MIN_LENGTH on the result.
 */
export function sanitizeNameQuery(raw: string): string {
  return (raw ?? '')
    .replace(DISALLOWED, '')
    .replace(/\s+/g, ' ')
    .trim()
}
