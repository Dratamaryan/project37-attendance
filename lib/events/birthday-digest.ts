// Pure birthday-selection and formatting logic — no I/O. See lib/events/birthday-digest.impl.ts
// for the DB/Telegram orchestration that calls this.

import { formatJakarta } from '@/lib/events/timezone'

export type ConsentState = 'granted' | 'refused' | 'unknown'

export type PersonRow = {
  id: string
  full_name: string
  birth_date: string | null // Postgres `date`, comes back as 'YYYY-MM-DD' — no zone, no Date parsing needed
  photo_publish_consent: boolean
  photo_consent_state: ConsentState
  deleted_at: string | null
}

export type BirthdayPerson = {
  id: string
  full_name: string
  age: number
  publish: boolean
  consentState: ConsentState
}

const DAY_MS = 86_400_000
const FEB_28 = '02-28'
const FEB_29 = '02-29'

/**
 * S8-T6 (H-1): the digest greets TOMORROW's birthdays in WIB. Asia/Jakarta is a fixed
 * UTC+7 with no DST, so now + 24h always lands on the next WIB calendar day. Never
 * derive this from `now.toISOString()` — at 06:30 WIB the UTC date is still yesterday.
 */
export function cohortDateFor(now: Date): string {
  return formatJakarta(new Date(now.getTime() + DAY_MS), 'yyyy-MM-dd')
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

/**
 * `cohortIso` is the WIB calendar date being greeted ('YYYY-MM-DD', from cohortDateFor).
 * Matching is a string slice on `birth_date`, never a Date, so a Postgres `date` (no
 * zone) can't shift across a UTC/WIB boundary.
 *
 * Feb 29 (S8-T6 T2): in a non-leap cohort year, Feb-29 birthdays join the Feb-28
 * cohort. In a leap year they stay on Feb 29 only.
 */
export function selectBirthdaysOn(people: PersonRow[], cohortIso: string): BirthdayPerson[] {
  const cohortMonthDay = cohortIso.slice(5, 10)
  const cohortYear = Number(cohortIso.slice(0, 4))
  const includeFeb29 = cohortMonthDay === FEB_28 && !isLeapYear(cohortYear)

  return people
    .filter((p): p is PersonRow & { birth_date: string } => {
      if (p.deleted_at !== null || p.birth_date === null) return false
      const monthDay = p.birth_date.slice(5, 10)
      return monthDay === cohortMonthDay || (includeFeb29 && monthDay === FEB_29)
    })
    .map((p) => ({
      id: p.id,
      full_name: p.full_name,
      age: cohortYear - Number(p.birth_date.slice(0, 4)),
      publish: p.photo_publish_consent,
      consentState: p.photo_consent_state,
    }))
}

const ID_MONTHS = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
] as const

/** 'YYYY-MM-DD' → 'd MMMM yyyy' in Indonesian (e.g. '2027-01-01' → '1 Januari 2027'). String-only. */
export function formatIndonesianDate(iso: string): string {
  const year = iso.slice(0, 4)
  const month = ID_MONTHS[Number(iso.slice(5, 7)) - 1]
  const day = Number(iso.slice(8, 10))
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || month === undefined || day < 1 || day > 31) {
    throw new TypeError(`Invalid ISO date: "${iso}"`)
  }
  return `${day} ${month} ${year}`
}

/**
 * photo_publish_consent is the effective gate; photo_consent_state only adds "never
 * answered" to a false. Known writer drift (tracked separately): setPhotoConsent
 * (lib/actions/people.impl.ts) writes only the boolean, so the two legitimately
 * diverge — the state alone would show a revoked person as ✅ and a later grant as ❓.
 */
export function consentBadge(publish: boolean, state: ConsentState): { emoji: string; label: string } {
  if (publish) {
    return { emoji: '✅', label: 'boleh diucapkan di grup WA' }
  }
  if (state === 'unknown') {
    return { emoji: '❓', label: 'belum ada jawaban — japri saja' }
  }
  return { emoji: '🔒', label: 'japri saja — tidak setuju publikasi' }
}

export function formatBirthdayDigest(people: BirthdayPerson[], cohortIso: string): string {
  const lines = people.map((p) => {
    const badge = consentBadge(p.publish, p.consentState)
    return `  • ${p.full_name} (${p.age})     ${badge.emoji} ${badge.label}`
  })
  return [`🎂 Ulang tahun besok — ${formatIndonesianDate(cohortIso)} (${people.length})`, ...lines].join('\n')
}
