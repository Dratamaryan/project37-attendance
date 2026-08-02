/**
 * Sprint 5 T5 — live verification: cron hardening (claim-first idempotency +
 * scheduled→completed flip) against prod. Exercises both crons:
 *
 *  Attendance summary:
 *   1. Quantify the real scheduled_at < now() backlog just before firing.
 *   2. Seed one fixture event/instance/person/attendance row (scheduled a few
 *      minutes in the past, checked in "today") so a real Telegram send is
 *      guaranteed regardless of today's real check-in volume, and so the
 *      fixture instance itself contributes +1 to the flip count.
 *   3. Fire GET /api/cron/attendance-summary → expect status 'sent',
 *      flipped_count === backlog + 1 (the fixture instance).
 *   4. Fire again, same day → expect 'skipped_already_sent', flipped_count 0
 *      (idempotent no-op — the live idempotency proof).
 *   5. Confirm the fixture instance flipped to 'completed', a sampled
 *      still-future instance and the known cancelled instance are untouched.
 *   6. Clean up fixtures; the system_health claim row is left in place (a
 *      real record of a real invocation, same convention as T5/T6 Sprint 4).
 *
 *  Birthday digest:
 *   7. Seed one fixture person with today's real ICT birthday.
 *   8. Fire GET /api/cron/birthday-digest → expect 'sent'.
 *   9. Fire again → expect 'skipped_already_sent'.
 *  10. Clean up the fixture person.
 *
 * Run: node scripts/t5-cron-hardening-live-test.mjs
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const __dir = dirname(fileURLToPath(import.meta.url))
const envPath = resolve(__dir, '../.env.local')
try {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx < 0) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '')
    if (!process.env[key]) process.env[key] = val
  }
} catch { /* env may already be set */ }

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const CRON_SECRET = process.env.CRON_SECRET
const PROD_URL = 'https://project37-attendance.vercel.app'

const EVENT_NAME = 'T5 Cron Hardening Live Test Event'
const ATTENDANCE_PHONE = '+628888007001' // distinct from T5/T6 sprint-4 fixture spaces (005xxx/006xxx)
const BIRTHDAY_PHONE = '+628888007002'
const REAL_ADMIN_ID = '00000000-0000-0000-0000-000000000000' // admin-example@example.test

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !CRON_SECRET) {
  console.error('Missing env vars (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / CRON_SECRET)')
  process.exit(1)
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

function todayICT() {
  const now = new Date()
  const ict = new Date(now.getTime() + 7 * 60 * 60 * 1000)
  const y = ict.getUTCFullYear()
  const m = String(ict.getUTCMonth() + 1).padStart(2, '0')
  const d = String(ict.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

async function cleanupByName() {
  const { data: existingEvents } = await admin.from('events').select('id').eq('name', EVENT_NAME)
  if (existingEvents?.length) {
    const eventIds = existingEvents.map((e) => e.id)
    const { data: existingInstances } = await admin.from('event_instances').select('id').in('event_id', eventIds)
    if (existingInstances?.length) {
      const instanceIds = existingInstances.map((i) => i.id)
      await admin.from('attendance').delete().in('event_instance_id', instanceIds)
      await admin.from('event_instances').delete().in('id', instanceIds)
    }
    await admin.from('events').delete().in('id', eventIds)
    console.log(`  Pre-cleanup: removed ${eventIds.length} existing fixture event(s) + descendants`)
  }
  const { data: existingPeople } = await admin
    .from('people')
    .select('id')
    .in('phone_e164', [ATTENDANCE_PHONE, BIRTHDAY_PHONE])
  if (existingPeople?.length) {
    await admin.from('attendance').delete().in('person_id', existingPeople.map((p) => p.id))
    await admin.from('people').delete().in('id', existingPeople.map((p) => p.id))
    console.log(`  Pre-cleanup: removed ${existingPeople.length} existing fixture people`)
  }
}

async function fireCron(path) {
  const res = await fetch(`${PROD_URL}${path}`, {
    headers: { Authorization: `Bearer ${CRON_SECRET}` },
  })
  const body = await res.json().catch(() => null)
  console.log(`  HTTP ${res.status}`, JSON.stringify(body))
  return { status: res.status, body }
}

async function runAttendanceSummaryPart() {
  console.log('\n--- Attendance summary ---\n')

  const nowIso = new Date().toISOString()

  const { count: backlogBefore, error: backlogErr } = await admin
    .from('event_instances')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'scheduled')
    .lt('scheduled_at', nowIso)
  if (backlogErr) throw backlogErr
  console.log(`  Real backlog (status=scheduled AND scheduled_at < now) just before firing: ${backlogBefore}`)

  const { data: futureSample } = await admin
    .from('event_instances')
    .select('id, status, scheduled_at')
    .eq('status', 'scheduled')
    .gt('scheduled_at', nowIso)
    .limit(1)
    .maybeSingle()
  const { data: cancelledSample } = await admin
    .from('event_instances')
    .select('id, status')
    .eq('status', 'cancelled')
    .limit(1)
    .maybeSingle()

  const { data: ev, error: evErr } = await admin
    .from('events')
    .insert({
      name: EVENT_NAME,
      event_type: 'adhoc',
      start_date: nowIso.slice(0, 10),
      start_time: '00:00:00',
      active: true,
      created_by: REAL_ADMIN_ID,
    })
    .select('id')
    .single()
  if (evErr) throw evErr
  console.log('  Inserted fixture event:', ev.id)

  // Scheduled 5 minutes in the past — guaranteed < now at fire time, and its
  // check-in lands inside today's ICT window for the digest content itself.
  const scheduledAt = new Date(Date.now() - 5 * 60 * 1000).toISOString()
  const { data: inst, error: instErr } = await admin
    .from('event_instances')
    .insert({
      event_id: ev.id,
      scheduled_at: scheduledAt,
      event_name_snapshot: EVENT_NAME,
      event_name_snapshot_id: null,
      status: 'scheduled',
    })
    .select('id')
    .single()
  if (instErr) throw instErr
  console.log('  Inserted fixture event_instance (scheduled_at 5min ago):', inst.id)

  const { data: person, error: personErr } = await admin
    .from('people')
    .insert({ phone_e164: ATTENDANCE_PHONE, full_name: 'T5 Live Attendance Fixture', nickname: 'T5Attend' })
    .select('id')
    .single()
  if (personErr) throw personErr

  const { error: attErr } = await admin.from('attendance').insert({
    event_instance_id: inst.id,
    person_id: person.id,
    checked_in_at: nowIso,
    checked_in_by: REAL_ADMIN_ID,
  })
  if (attErr) throw attErr
  console.log('  Inserted fixture attendance row')

  const expectedFlipCount = backlogBefore + 1 // + the fixture instance itself

  console.log('\n  Triggering GET /api/cron/attendance-summary (first fire) ...')
  const first = await fireCron('/api/cron/attendance-summary')

  console.log('\n  Triggering GET /api/cron/attendance-summary (second fire, same day) ...')
  const second = await fireCron('/api/cron/attendance-summary')

  const { data: instAfter } = await admin.from('event_instances').select('status').eq('id', inst.id).single()
  let futureAfter = null
  let cancelledAfter = null
  if (futureSample) {
    const { data } = await admin.from('event_instances').select('status').eq('id', futureSample.id).single()
    futureAfter = data
  }
  if (cancelledSample) {
    const { data } = await admin.from('event_instances').select('status').eq('id', cancelledSample.id).single()
    cancelledAfter = data
  }

  // Cleanup fixtures regardless of outcome — never leave test residue on prod.
  // The system_health claim row is left in place per convention.
  await admin.from('attendance').delete().eq('person_id', person.id)
  await admin.from('people').delete().eq('id', person.id)
  await admin.from('event_instances').delete().eq('id', inst.id)
  await admin.from('events').delete().eq('id', ev.id)
  console.log('\n  Cleanup: removed fixture event, event_instance, person, attendance row')

  const pass =
    first.status === 200 &&
    first.body?.ok === true &&
    first.body?.status === 'sent' &&
    first.body?.flipped_count === expectedFlipCount &&
    second.status === 200 &&
    second.body?.ok === true &&
    second.body?.status === 'skipped_already_sent' &&
    second.body?.flipped_count === 0 &&
    instAfter?.status === 'completed' &&
    (!futureSample || futureAfter?.status === 'scheduled') &&
    (!cancelledSample || cancelledAfter?.status === 'cancelled')

  console.log('\n  Summary:')
  console.log(`    expected flipped_count (backlog ${backlogBefore} + fixture 1) = ${expectedFlipCount}`)
  console.log(`    first fire  flipped_count = ${first.body?.flipped_count}, status = ${first.body?.status}, message_id = ${first.body?.message_id}`)
  console.log(`    second fire flipped_count = ${second.body?.flipped_count}, status = ${second.body?.status}`)
  console.log(`    fixture instance status after = ${instAfter?.status}`)
  console.log(`    future-scheduled sample untouched = ${!futureSample || futureAfter?.status === 'scheduled'}`)
  console.log(`    cancelled sample untouched = ${!cancelledSample || cancelledAfter?.status === 'cancelled'}`)
  console.log(pass ? '\n  ✓ Attendance summary PASS (server-side)' : '\n  ✗ Attendance summary FAIL (server-side)')

  return { pass, first, second, expectedFlipCount }
}

async function runBirthdayDigestPart() {
  console.log('\n--- Birthday digest ---\n')

  const birthDate = todayICT()
  console.log('  Today (ICT):', birthDate)

  const { data: person, error: personErr } = await admin
    .from('people')
    .insert({
      phone_e164: BIRTHDAY_PHONE,
      full_name: 'T5 Live Birthday Fixture',
      nickname: 'T5Bday',
      birth_date: birthDate,
      photo_publish_consent: true,
    })
    .select('id')
    .single()
  if (personErr) throw personErr
  console.log('  Inserted fixture person:', person.id)

  console.log('\n  Triggering GET /api/cron/birthday-digest (first fire) ...')
  const first = await fireCron('/api/cron/birthday-digest')

  console.log('\n  Triggering GET /api/cron/birthday-digest (second fire, same day) ...')
  const second = await fireCron('/api/cron/birthday-digest')

  await admin.from('people').delete().eq('id', person.id)
  console.log('\n  Cleanup: removed fixture person')

  const pass =
    first.status === 200 &&
    first.body?.ok === true &&
    first.body?.status === 'sent' &&
    second.status === 200 &&
    second.body?.ok === true &&
    second.body?.status === 'skipped_already_sent'

  console.log('\n  Summary:')
  console.log(`    first fire  status = ${first.body?.status}, message_id = ${first.body?.message_id}, count = ${first.body?.count}`)
  console.log(`    second fire status = ${second.body?.status}`)
  console.log(pass ? '\n  ✓ Birthday digest PASS (server-side)' : '\n  ✗ Birthday digest FAIL (server-side)')

  return { pass, first, second }
}

async function main() {
  console.log('\n=== Sprint 5 T5 — live cron hardening test ===\n')

  await cleanupByName()

  const attendance = await runAttendanceSummaryPart()
  const birthday = await runBirthdayDigestPart()

  console.log('\n=== Overall ===')
  console.log(`  Attendance summary: ${attendance.pass ? 'PASS' : 'FAIL'}`)
  console.log(`  Birthday digest:    ${birthday.pass ? 'PASS' : 'FAIL'}`)
  console.log('\n  Manual step: confirm BOTH messages physically arrived in Telegram chat 000000000')
  console.log('  before citing verified: live (a 200 to a wrong chat, or an unverified body, is a silent failure).')

  if (!attendance.pass || !birthday.pass) process.exitCode = 1
}

main().catch((err) => {
  console.error('Script error:', err)
  process.exit(1)
})
