/**
 * Demo-data verification — S3-T3
 *
 * Run:  npm run verify:demo
 *   or  npx tsx --env-file .env.local seed/verify-demo-data.ts
 *
 * Checks all 5 T2 analytics views against ground-truth expectations derived
 * from the seed script's data definition. Exits non-zero on any failure.
 *
 * Expected new_vs_returning_monthly (derived from seed attendance plan):
 *   Jan: new=15 ret=0   Feb: new=8  ret=12  Mar: new=7  ret=16
 *   Apr: new=5  ret=15  May: new=3  ret=17  Jun: new=2  ret=16
 */

import { createClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Expected values — ground truth from the seed data plan
// ---------------------------------------------------------------------------

// Derived from seed attendance plan (persons attending each month):
//   Jan ret=0:  no one has attended before Jan
//   Feb ret=12: regulars(10) + persons 13,14 (Jan debutants who attend Feb)
//   Mar ret=15: regulars(10) + persons 11,15 (Jan) + persons 17,18,21 (Feb)
//               (person 23 attends Feb+Apr, not Mar)
//   Apr ret=15: regulars(10) + persons 12,14 (Jan) + persons 16,19,23 (Feb)
//   May ret=16: regulars(10) + persons 11,13 (Jan) + persons 17,19,22 (Feb) + person 24 (Mar)
//               (person 15 attends Jan+Mar+Jun, not May)
//   Jun ret=16: regulars(10) + persons 12,15 (Jan) + persons 16,18,20 (Feb) + person 25 (Mar)
const EXPECTED_NEW_VS_RETURNING: Array<{
  month: string
  new_count: number
  returning_count: number
}> = [
  { month: '2026-01', new_count: 15, returning_count:  0 },
  { month: '2026-02', new_count:  8, returning_count: 12 },
  { month: '2026-03', new_count:  7, returning_count: 15 },
  { month: '2026-04', new_count:  5, returning_count: 15 },
  { month: '2026-05', new_count:  3, returning_count: 16 },
  { month: '2026-06', new_count:  2, returning_count: 16 },
]

// Parish counts: [count, parishName] sorted descending
const EXPECTED_PARISH_COUNTS = [10, 9, 8, 7, 4, 2]  // Serpong, Bintaro Jaya, Danau Sunter, Grogol, Rawamangun, Citra Raya

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type CheckResult = { label: string; pass: boolean; detail: string }

function pass(label: string, detail: string): CheckResult {
  return { label, pass: true, detail }
}

function fail(label: string, detail: string): CheckResult {
  return { label, pass: false, detail }
}

function isoToYYYYMM(iso: string): string {
  // '2026-01-01T00:00:00+00:00' → '2026-01'
  return iso.slice(0, 7)
}

function die(msg: string): never {
  console.error(`\n[verify-demo] FATAL: ${msg}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    die('NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set. Run via: npm run verify:demo')
  }

  const supabase = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const results: CheckResult[] = []

  // ── Check 1: parish_breakdown — ≥5 parishes with differing people_count ──
  console.log('Querying parish_breakdown...')
  const { data: parishRows, error: parishErr } = await supabase
    .from('parish_breakdown')
    .select('parish, people_count')
    .ilike('parish', 'Paroki %')
    .order('people_count', { ascending: false })

  if (parishErr) die(`parish_breakdown query failed: ${parishErr.message}`)

  const rows = (parishRows ?? []) as Array<{ parish: string; people_count: number }>
  const demoParishRows = rows.filter((r) => EXPECTED_PARISH_COUNTS.includes(r.people_count))

  if (demoParishRows.length < 5) {
    results.push(fail('parish_breakdown: ≥5 parishes', `only ${demoParishRows.length} found`))
  } else {
    const unique = new Set(demoParishRows.map((r) => r.people_count))
    if (unique.size < 5) {
      results.push(fail('parish_breakdown: differing counts', `only ${unique.size} distinct counts`))
    } else {
      results.push(pass('parish_breakdown: ≥5 parishes with differing counts', demoParishRows.map((r) => `${r.parish}=${r.people_count}`).join(', ')))
    }
  }

  // ── Check 2: event_attendance_trend — ≥5 months, spread of attendee_count
  console.log('Querying event_attendance_trend...')
  const { data: trendRows, error: trendErr } = await supabase
    .from('event_attendance_trend')
    .select('event_instance_id, scheduled_at, attendee_count')
    .gte('scheduled_at', '2026-01-01T00:00:00Z')
    .lt('scheduled_at',  '2026-07-01T00:00:00Z')
    .order('scheduled_at')

  if (trendErr) die(`event_attendance_trend query failed: ${trendErr.message}`)

  const trendData = (trendRows ?? []) as Array<{ event_instance_id: string; scheduled_at: string; attendee_count: number }>
  const months = new Set(trendData.map((r) => isoToYYYYMM(r.scheduled_at)))
  const counts = trendData.map((r) => r.attendee_count)

  if (months.size < 5) {
    results.push(fail('event_attendance_trend: ≥5 months', `only ${months.size} months found`))
  } else if (trendData.length < 10) {
    results.push(fail('event_attendance_trend: ≥10 instances', `only ${trendData.length} instances`))
  } else {
    const minC = Math.min(...counts)
    const maxC = Math.max(...counts)
    results.push(pass(
      `event_attendance_trend: ${trendData.length} instances across ${months.size} months`,
      `attendee_count range ${minC}–${maxC}`
    ))
  }

  // ── Check 3: new_vs_returning_monthly — exact match ───────────────────────
  console.log('Querying new_vs_returning_monthly...')
  const { data: nvrRows, error: nvrErr } = await supabase
    .from('new_vs_returning_monthly')
    .select('month, new_count, returning_count')
    .gte('month', '2026-01-01T00:00:00Z')
    .lt('month',  '2026-07-01T00:00:00Z')
    .order('month')

  if (nvrErr) die(`new_vs_returning_monthly query failed: ${nvrErr.message}`)

  const nvrData = (nvrRows ?? []) as Array<{ month: string; new_count: number; returning_count: number }>

  if (nvrData.length !== 6) {
    results.push(fail('new_vs_returning_monthly: 6 months', `got ${nvrData.length} rows`))
  } else {
    let allMatch = true
    const mismatches: string[] = []

    for (let i = 0; i < 6; i++) {
      const actual = nvrData[i]
      const expected = EXPECTED_NEW_VS_RETURNING[i]
      const actualMonth = isoToYYYYMM(actual.month)

      if (actualMonth !== expected.month) {
        mismatches.push(`row ${i}: month ${actualMonth} ≠ ${expected.month}`)
        allMatch = false
      }
      if (Number(actual.new_count) !== expected.new_count) {
        mismatches.push(`${actualMonth} new: ${actual.new_count} ≠ ${expected.new_count}`)
        allMatch = false
      }
      if (Number(actual.returning_count) !== expected.returning_count) {
        mismatches.push(`${actualMonth} returning: ${actual.returning_count} ≠ ${expected.returning_count}`)
        allMatch = false
      }
    }

    if (allMatch) {
      results.push(pass(
        'new_vs_returning_monthly: exact match',
        nvrData.map((r) => `${isoToYYYYMM(r.month)} new=${r.new_count} ret=${r.returning_count}`).join('  ')
      ))
    } else {
      results.push(fail('new_vs_returning_monthly: exact match', mismatches.join('; ')))
    }
  }

  // ── Check 4: person_attendance_counts — distribution visible ─────────────
  console.log('Querying person_attendance_counts...')
  const { data: pacRows, error: pacErr } = await supabase
    .from('person_attendance_counts')
    .select('person_id, full_name, total_attendance')
    .like('phone_e164', '+62999100%')
    .order('total_attendance', { ascending: false })

  if (pacErr) die(`person_attendance_counts query failed: ${pacErr.message}`)

  const pacData = (pacRows ?? []) as Array<{ person_id: string; full_name: string; total_attendance: number }>
  const highCount  = pacData.filter((r) => Number(r.total_attendance) >= 10).length
  const midCount   = pacData.filter((r) => Number(r.total_attendance) >= 2 && Number(r.total_attendance) < 10).length
  const singleCount = pacData.filter((r) => Number(r.total_attendance) === 1).length

  if (pacData.length < 30) {
    results.push(fail('person_attendance_counts: ≥30 demo people', `only ${pacData.length} rows`))
  } else if (highCount < 5 || singleCount < 10) {
    results.push(fail(
      'person_attendance_counts: distribution',
      `high(≥10)=${highCount} mid=${midCount} single=${singleCount} — expected ≥5 high, ≥10 single`
    ))
  } else {
    results.push(pass(
      `person_attendance_counts: ${pacData.length} people`,
      `high(≥10)=${highCount}  mid(2-9)=${midCount}  single=1: ${singleCount}`
    ))
  }

  // ── Check 5: attendance_summary — source=demo_seed rows present ───────────
  console.log('Querying attendance_summary...')
  const { count: demoAttCount, error: sumErr } = await supabase
    .from('attendance_summary')
    .select('attendance_id', { count: 'exact', head: true })
    .eq('source', 'demo_seed')

  if (sumErr) die(`attendance_summary query failed: ${sumErr.message}`)

  if ((demoAttCount ?? 0) < 100) {
    results.push(fail('attendance_summary: demo_seed rows', `only ${demoAttCount} rows`))
  } else {
    results.push(pass('attendance_summary: demo_seed rows present', `${demoAttCount} rows`))
  }

  // ── Print results ──────────────────────────────────────────────────────────
  console.log('\n─────────────────────────────────────────────────────────')
  let failures = 0
  for (const r of results) {
    const icon = r.pass ? '✓' : '✗'
    console.log(`${icon} ${r.label}`)
    if (!r.pass || process.env.VERBOSE) console.log(`    ${r.detail}`)
    if (!r.pass) failures++
  }
  console.log('─────────────────────────────────────────────────────────')

  if (failures === 0) {
    console.log(`\n✓ All ${results.length} checks pass\n`)
    process.exit(0)
  } else {
    console.log(`\n✗ ${failures}/${results.length} checks failed\n`)
    process.exit(1)
  }
}

main().catch((err: unknown) => {
  console.error('[verify-demo] Unhandled error:', err)
  process.exit(1)
})
