// UI-only convenience lists, not a DB enum. `tribe`/`kepanitiaan` remain free
// text in `people` (S1-T5 decision: promote to enum only once variants
// stabilize) — these values are the ones documented as the current real data
// in `4 Database Schema.md`. A prod value outside this list is simply not
// selectable as a filter here; it does not affect recipient resolution, which
// always queries the live column value.
export const TRIBE_OPTIONS = [
  'Bethlehem',
  'Cana',
  'Daniel',
  'Deborah',
  'Eden',
  'Jacob',
  'Mary',
  'Nazareth',
  'Tabor',
] as const

export const KEPANITIAAN_OPTIONS = [
  'Member',
  'Servant',
  'Shepherd/Servant',
  'Co Shepherd',
  'Co Shepherd/Servant',
  'Shepherd',
] as const
