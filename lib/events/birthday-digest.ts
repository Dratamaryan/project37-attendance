// Pure birthday-selection and formatting logic — no I/O. See lib/events/birthday-digest.impl.ts
// for the DB/Telegram orchestration that calls this.

export type PersonRow = {
  id: string
  full_name: string
  birth_date: string | null // Postgres `date`, comes back as 'YYYY-MM-DD' — no zone, no Date parsing needed
  photo_publish_consent: boolean | null
  deleted_at: string | null
}

export type BirthdayPerson = {
  id: string
  full_name: string
  age: number
  consent: boolean | null
}

/**
 * `todayICT` must come from `formatJakarta(now, 'yyyy-MM-dd')` (lib/events/timezone.ts) —
 * never from `now.toISOString()`. Matching is a string slice on `birth_date`, not a
 * Date comparison, so a Postgres `date` (no zone) can never be re-interpreted across
 * a UTC/ICT boundary.
 *
 * Feb 29 people are excluded in non-leap years by construction: '02-29' never equals
 * '02-28' or '03-01'. This is a values choice (some might prefer a Feb-28 greeting),
 * not just mechanics — revisit if Sprint 5's settings pass wants that configurable.
 */
export function selectBirthdaysToday(people: PersonRow[], todayICT: string): BirthdayPerson[] {
  const todayMonthDay = todayICT.slice(5, 10)
  const todayYear = Number(todayICT.slice(0, 4))

  return people
    .filter(
      (p): p is PersonRow & { birth_date: string } =>
        p.deleted_at === null && p.birth_date !== null && p.birth_date.slice(5, 10) === todayMonthDay,
    )
    .map((p) => ({
      id: p.id,
      full_name: p.full_name,
      age: todayYear - Number(p.birth_date.slice(0, 4)),
      consent: p.photo_publish_consent,
    }))
}

export function consentBadge(consent: boolean | null): { emoji: string; label: string } {
  if (consent === true) {
    return { emoji: '✅', label: 'boleh diucapkan di grup WA' }
  }
  if (consent === false) {
    return { emoji: '🔒', label: 'japri saja — tidak setuju publikasi' }
  }
  // Not reachable today — photo_publish_consent is NOT NULL at the DB level (Sprint 6's
  // import maps blank/"?" to false per B/3). Kept for a future state where consent is
  // genuinely unrecorded, so a ❓ digest line doesn't silently become dead code.
  return { emoji: '❓', label: 'belum ada jawaban — japri saja' }
}

export function formatBirthdayDigest(people: BirthdayPerson[]): string {
  const lines = people.map((p) => {
    const badge = consentBadge(p.consent)
    return `  • ${p.full_name} (${p.age})     ${badge.emoji} ${badge.label}`
  })
  return [`🎂 Ulang tahun hari ini (${people.length})`, ...lines].join('\n')
}
