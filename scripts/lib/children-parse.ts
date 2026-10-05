/**
 * S8-T4 — pure parser for the roster's free-text "Nama & Tanggal Lahir Anak"
 * cell (one cell = one parent's children, 1..N entries).
 *
 * PURE: no I/O, no DB, no imports. Dates are emitted as 'YYYY-MM-DD' strings
 * built directly from the parsed parts and calendar-validated arithmetically
 * -- never via a `Date` object (same discipline as lib/utils/date-display.ts:
 * a date-only value routed through `Date` can shift a day).
 *
 * Locked decisions (S8-T4 plan):
 *   - Day-first throughout. Ambiguous numeric dates (both parts <= 12) are
 *     read day-first. 2-digit years pivot to 20YY (these are children).
 *   - Bare 6-digit runs are unresolvable (DDMMYY vs YYMMDD both plausible):
 *     birth_date null, raw fragment kept in notes. Bare 8 digits = DDMMYYYY.
 *   - No-year dates ('D MON' / 'MON D'): birth_date null, raw fragment in notes.
 *   - A middle field between name and date is stripped ONLY when it is
 *     confidently a place (KNOWN_CITIES, or equal to the caller-supplied
 *     parent birthplace). Otherwise the name is kept UNTRUNCATED and the
 *     entry's raw text goes to notes -- never guess, never truncate a name.
 *   - Entries with no extractable name are omitted (never a placeholder row).
 *   - If entries can't be reliably separated (e.g. a child's name and date on
 *     separate lines), the whole cell is parked: children [], parked set.
 *
 * `shape` is a STRUCTURAL tag only (counts / separator kinds / date kinds) --
 * it never contains cell text, so it is safe to print in a PII-safe report.
 * `parked` DOES contain the raw cell text -- callers must print only the
 * reason (see parkReasonOf), never the whole string.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Month words (lowercase) -> month number. Indonesian + English, full names
 *  and the abbreviations seen in (or adjacent to) the real data. */
export const MONTHS: Readonly<Record<string, number>> = {
  januari: 1, january: 1, jan: 1,
  februari: 2, february: 2, pebruari: 2, feb: 2, peb: 2,
  maret: 3, march: 3, mar: 3, mrt: 3,
  april: 4, apr: 4,
  mei: 5, may: 5,
  juni: 6, june: 6, jun: 6,
  juli: 7, july: 7, jul: 7,
  agustus: 8, august: 8, agust: 8, agst: 8, agt: 8, ags: 8, agu: 8, aug: 8,
  september: 9, sept: 9, sep: 9,
  oktober: 10, october: 10, okt: 10, oct: 10,
  november: 11, nopember: 11, nov: 11, nop: 11,
  desember: 12, december: 12, des: 12, dec: 12,
}

/** Places (lowercase, single-spaced) that are confidently a birthplace when
 *  they appear as a middle field. Deliberately small and conservative --
 *  a miss is safe (entry goes to notes), a false hit would truncate a name. */
export const KNOWN_CITIES: ReadonlySet<string> = new Set([
  // Indonesia
  'jakarta', 'bandung', 'surabaya', 'medan', 'semarang', 'yogyakarta', 'jogja',
  'jogjakarta', 'yogya', 'solo', 'surakarta', 'malang', 'bogor', 'bekasi',
  'tangerang', 'depok', 'denpasar', 'bali', 'makassar', 'palembang', 'pontianak',
  'manado', 'balikpapan', 'samarinda', 'batam', 'pekanbaru', 'padang', 'kupang',
  'ambon', 'jayapura', 'kediri', 'magelang', 'cirebon', 'klaten', 'salatiga',
  'bandar lampung', 'lampung', 'banjarmasin', 'jambi', 'mataram', 'cimahi',
  'sukabumi', 'serang', 'karawang', 'pematang siantar', 'pematangsiantar',
  'maumere', 'ende', 'ruteng', 'larantuka', 'tomohon', 'bitung',
  // Australia / region
  'sydney', 'melbourne', 'perth', 'brisbane', 'adelaide', 'canberra',
  'singapore', 'singapura', 'kuala lumpur',
])

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ParsedChild {
  full_name: string
  birth_date: string | null
  notes: string | null
}

export interface ChildrenParseResult {
  children: ParsedChild[]
  /** '<reason>: <raw cell>' when the whole cell is parked, else null. */
  parked: string | null
  /** Structural tag naming the matched pattern -- never contains cell text. */
  shape: string
  /** Entries found but dropped because no name could be extracted. */
  omittedEntries: number
}

export const PARK_REASONS = {
  EMPTY: 'empty',
  MULTILINE_UNSPLITTABLE: 'multiline-unsplittable',
  NO_DATE_UNSPLITTABLE: 'no-date-unsplittable',
  NO_NAME_EXTRACTABLE: 'no-name-extractable',
} as const
export type ParkReason = (typeof PARK_REASONS)[keyof typeof PARK_REASONS]

/** The reason part of a `parked` string -- the only part safe to print. */
export function parkReasonOf(parked: string): string {
  const idx = parked.indexOf(':')
  return idx < 0 ? parked : parked.slice(0, idx)
}

// ---------------------------------------------------------------------------
// Calendar helpers (no Date)
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
}

function daysInMonth(y: number, m: number): number {
  if (m === 2) return isLeapYear(y) ? 29 : 28
  return [4, 6, 9, 11].includes(m) ? 30 : 31
}

/** Returns 'YYYY-MM-DD' if (y, m, d) is a real calendar date in 1900..2099, else null. */
export function toIsoDate(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null
  if (y < 1900 || y > 2099) return null
  if (m < 1 || m > 12) return null
  if (d < 1 || d > daysInMonth(y, m)) return null
  return `${y}-${pad2(m)}-${pad2(d)}`
}

/** True iff `s` is a well-formed, calendar-valid 'YYYY-MM-DD' string. */
export function isValidIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return false
  return toIsoDate(Number(m[1]), Number(m[2]), Number(m[3])) === s
}

function expandYear(raw: string): number {
  const n = Number(raw)
  return raw.length === 2 ? 2000 + n : n
}

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

function normalizePlace(s: string): string {
  return s.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim()
}

/** Confidently a place: in KNOWN_CITIES, or equal to the parent's birthplace. */
export function isKnownPlace(candidate: string, parentBirthplace?: string | null): boolean {
  const norm = normalizePlace(candidate)
  if (!norm) return false
  if (KNOWN_CITIES.has(norm)) return true
  if (parentBirthplace) {
    const parentNorm = normalizePlace(parentBirthplace)
    if (parentNorm && parentNorm === norm) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Date detection
// ---------------------------------------------------------------------------

type DateKind = 'word-dmy' | 'num-dmy' | 'bare8' | 'bare6' | 'word-noyear'

interface DateHit {
  start: number
  end: number
  kind: DateKind
  /** Resolved date, or null when unresolvable (no year / ambiguous / impossible). */
  iso: string | null
  raw: string
}

// Higher-confidence kinds win an overlap.
const KIND_RANK: Record<DateKind, number> = {
  'word-dmy': 0,
  'num-dmy': 1,
  bare8: 2,
  bare6: 3,
  'word-noyear': 4,
}

const MONTH_ALT = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join('|')

// No '.' between day and month: keeps a list marker like "2. Mei ..." (a child
// named Mei) from reading as a date.
const RE_WORD_DMY = new RegExp(
  `(?<!\\d)(\\d{1,2})[\\s\\-/]*(${MONTH_ALT})\\.?(?![a-z])[\\s\\-/.,]*(?:(\\d{4})(?!\\d)|(\\d{2})(?![\\d.)]))`,
  'gi',
)
const RE_WORD_DM_NOYEAR = new RegExp(`(?<!\\d)(\\d{1,2})[\\s\\-/]*(${MONTH_ALT})\\.?(?![a-z])`, 'gi')
const RE_WORD_MD_NOYEAR = new RegExp(`(?<![a-z])(${MONTH_ALT})\\.?\\s+(\\d{1,2})(?!\\d)`, 'gi')
const RE_NUM_DMY = /(?<![\d/])(\d{1,2})(?:\s*[/-]\s*|\.)(\d{1,2})(?:\s*[/-]\s*|\.)(\d{4}|\d{2})(?!\d)(?![/.-]\d)/g
const RE_BARE8 = /(?<!\d)(\d{8})(?!\d)/g
const RE_BARE6 = /(?<!\d)(\d{6})(?!\d)/g

function collect(re: RegExp, text: string, kind: DateKind, resolve: (m: RegExpExecArray) => string | null): DateHit[] {
  const hits: DateHit[] = []
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    hits.push({ start: m.index, end: m.index + m[0].length, kind, iso: resolve(m), raw: m[0] })
  }
  return hits
}

function monthOf(word: string): number {
  return MONTHS[word.toLowerCase()] ?? 0
}

function findDates(text: string): DateHit[] {
  const all: DateHit[] = [
    ...collect(RE_WORD_DMY, text, 'word-dmy', (m) =>
      toIsoDate(expandYear(m[3] ?? m[4]), monthOf(m[2]), Number(m[1])),
    ),
    ...collect(RE_NUM_DMY, text, 'num-dmy', (m) => toIsoDate(expandYear(m[3]), Number(m[2]), Number(m[1]))),
    ...collect(RE_BARE8, text, 'bare8', (m) =>
      toIsoDate(Number(m[1].slice(4, 8)), Number(m[1].slice(2, 4)), Number(m[1].slice(0, 2))),
    ),
    ...collect(RE_BARE6, text, 'bare6', () => null),
    ...collect(RE_WORD_DM_NOYEAR, text, 'word-noyear', () => null),
    ...collect(RE_WORD_MD_NOYEAR, text, 'word-noyear', () => null),
  ]
  all.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.start - b.start || b.end - a.end)
  const accepted: DateHit[] = []
  for (const hit of all) {
    if (accepted.some((h) => hit.start < h.end && h.start < hit.end)) continue
    accepted.push(hit)
  }
  return accepted.sort((a, b) => a.start - b.start)
}

// ---------------------------------------------------------------------------
// Entry splitting
// ---------------------------------------------------------------------------

// Leading list marker: "1." "2)" "(3)" "-" "•" -- never followed by a digit
// (so a leading date like "12.05.2016" is not mistaken for a marker).
const RE_LEADING_MARKER = /^\s*(?:\(?\d{1,2}[.)](?!\d)|[-•*·])\s*/
// Explicit separator right after a date (optionally after ')' or '.').
const RE_SEPARATOR = /^[\s).\]]*(?:(,)|(;)|(&|\bdan\b|\band\b))\s*/i
const RE_HAS_ALNUM = /[a-z0-9À-ɏ]/i
const RE_HAS_LETTER = /[a-zÀ-ɏ]/i

interface Segment {
  text: string
  hit: DateHit | null // hit offsets are relative to `text`
}

function stripLeadingMarker(s: string, seps: Set<string>): string {
  const stripped = s.replace(RE_LEADING_MARKER, '')
  if (stripped !== s && /\d/.test(s.slice(0, s.length - stripped.length))) seps.add('numbered')
  return stripped
}

function noteSeparator(m: RegExpExecArray, seps: Set<string>): void {
  if (m[1]) seps.add('comma')
  else if (m[2]) seps.add('semicolon')
  else if (m[3]) seps.add('dan')
}

/** Cut a line after every date hit (each entry carries at most one date). */
function splitLine(line: string, seps: Set<string>): Segment[] {
  const hits = findDates(line)
  if (hits.length === 0) return [{ text: line, hit: null }]

  const segments: Segment[] = []
  let segStart = 0
  hits.forEach((hit, i) => {
    const isLast = i === hits.length - 1
    // Absorb trailing ')' / '.' / ']' into this entry.
    let cut = hit.end
    const trail = /^[\s).\]]*/.exec(line.slice(cut))
    if (trail) cut += trail[0].length
    const tail = line.slice(hit.end)
    const sep = RE_SEPARATOR.exec(tail)

    if (isLast && !sep) {
      // Anything after the final date without an explicit separator stays with
      // this entry (as suffix) -- never becomes a child of its own.
      segments.push(segFrom(line, segStart, line.length, hit))
      segStart = line.length
      return
    }
    segments.push(segFrom(line, segStart, cut, hit))
    if (sep) {
      noteSeparator(sep, seps)
      segStart = hit.end + sep[0].length
    } else {
      segStart = cut
    }
  })
  if (segStart < line.length && RE_HAS_ALNUM.test(line.slice(segStart))) {
    segments.push({ text: line.slice(segStart), hit: null })
  }
  return segments
}

function segFrom(line: string, start: number, end: number, hit: DateHit): Segment {
  return { text: line.slice(start, end), hit: { ...hit, start: hit.start - start, end: hit.end - start } }
}

// ---------------------------------------------------------------------------
// Entry parsing
// ---------------------------------------------------------------------------

// Name/middle separators: comma, or a dash with whitespace on at least one side
// (a bare intra-word hyphen stays part of the name).
const RE_FIELD_SEP = /\s*,\s*|\s+[-–]\s*|\s*[-–]\s+/

function cleanName(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .replace(/^[\s.,;:\-–()[\]]+/, '')
    .replace(/[\s,;:\-–([]+$/, '')
    .trim()
}

interface EntryOutcome {
  child: ParsedChild | null
  placeStripped: boolean
  middleAmbiguous: boolean
}

function parseEntry(seg: Segment, parentBirthplace: string | null | undefined, seps: Set<string>): EntryOutcome {
  const raw = seg.text.trim()
  const hit = seg.hit
  const prefixRaw = hit ? seg.text.slice(0, hit.start) : seg.text
  const suffix = hit ? seg.text.slice(hit.end) : ''

  const prefix = cleanName(stripLeadingMarker(prefixRaw, seps))
  const parts = prefix.split(RE_FIELD_SEP).map((p) => p.trim()).filter((p) => p.length > 0)

  let fullName = prefix
  let placeStripped = false
  let middleAmbiguous = false

  if (parts.length === 2 && isKnownPlace(parts[1], parentBirthplace)) {
    fullName = cleanName(parts[0])
    placeStripped = true
  } else if (parts.length >= 2) {
    // A middle field we can't confirm is a place: keep the name untruncated.
    middleAmbiguous = true
  }

  // Unexpected text after the date also means we're not sure what we have.
  if (RE_HAS_ALNUM.test(suffix.replace(/^[\s).\]]*/, ''))) middleAmbiguous = true

  const leadName = parts.length > 0 ? cleanName(parts[0]) : ''
  if (!RE_HAS_LETTER.test(fullName) || !RE_HAS_LETTER.test(leadName)) {
    return { child: null, placeStripped: false, middleAmbiguous: false }
  }

  let notes: string | null = null
  if (middleAmbiguous) notes = raw
  else if (hit && hit.iso === null) notes = hit.raw.trim()

  return {
    child: { full_name: fullName, birth_date: hit ? hit.iso : null, notes },
    placeStripped,
    middleAmbiguous,
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function park(reason: ParkReason, raw: string, extra = ''): ChildrenParseResult {
  return { children: [], parked: `${reason}: ${raw}`, shape: `park:${reason}${extra}`, omittedEntries: 0 }
}

export function parseChildrenCell(raw: string, parentBirthplace?: string | null): ChildrenParseResult {
  const text = (raw ?? '').replace(/\r\n?/g, '\n').trim()
  if (!text) return park(PARK_REASONS.EMPTY, '')

  const seps = new Set<string>()
  const allLines = text.split('\n').map((l) => l.trim())
  // Junk lines with no letters/digits at all (e.g. a row of dots) are dropped.
  const lines = allLines.filter((l) => RE_HAS_ALNUM.test(l))
  const junkLines = allLines.filter((l) => l.length > 0).length - lines.length
  if (lines.length > 1) seps.add('newline')

  const lineSegments = lines.map((l) => splitLine(stripLeadingMarker(l, seps), seps))

  if (lines.length > 1 && lineSegments.some((segs) => segs.every((s) => s.hit === null))) {
    // A line with no date at all inside a multi-line cell: name and date may
    // be on separate lines -- entries can't be reliably separated.
    return park(PARK_REASONS.MULTILINE_UNSPLITTABLE, raw, `;lines=${lines.length}`)
  }
  if (lines.length === 1 && lineSegments[0].every((s) => s.hit === null) && /[,;&]|\bdan\b|\band\b/i.test(lines[0])) {
    return park(PARK_REASONS.NO_DATE_UNSPLITTABLE, raw)
  }

  const segments = lineSegments.flat()
  const children: ParsedChild[] = []
  let omitted = 0
  let stripped = 0
  let ambiguous = 0
  const kinds = new Set<string>()
  for (const seg of segments) {
    const out = parseEntry(seg, parentBirthplace, seps)
    if (!out.child) {
      omitted++
      continue
    }
    children.push(out.child)
    if (out.placeStripped) stripped++
    if (out.middleAmbiguous) ambiguous++
    kinds.add(seg.hit ? (seg.hit.iso === null ? `${seg.hit.kind}(unresolved)` : seg.hit.kind) : 'no-date')
  }

  if (children.length === 0) return park(PARK_REASONS.NO_NAME_EXTRACTABLE, raw)

  const shapeParts = [
    `entries=${children.length}`,
    `sep=${seps.size > 0 ? [...seps].sort().join('+') : 'single'}`,
    `date=${[...kinds].sort().join('+')}`,
  ]
  if (stripped > 0) shapeParts.push(`place-stripped=${stripped}`)
  if (ambiguous > 0) shapeParts.push(`middle-ambiguous=${ambiguous}`)
  if (omitted > 0) shapeParts.push(`omitted=${omitted}`)
  if (junkLines > 0) shapeParts.push(`junk-lines=${junkLines}`)

  return { children, parked: null, shape: shapeParts.join(';'), omittedEntries: omitted }
}
