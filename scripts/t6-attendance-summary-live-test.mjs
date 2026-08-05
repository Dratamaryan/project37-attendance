/**
 * Sprint 4 T4-11 (live) — verify GET /api/cron/attendance-summary against
 * prod: a real attendance summary reaches Ryan's Telegram, correctly
 * truncated with an accurate "…dan N lainnya" count — not just a 200.
 *
 * Seeds one prod fixture event + event_instance scheduled today, and 60
 * fixture attendance rows with deliberately long names (full_name has no DB
 * length constraint — see lib/events/attendance-summary.ts) to force real
 * truncation over the wire, not just in Vitest. Triggers the deployed cron
 * route with CRON_SECRET bearer auth, then removes every fixture row
 * (event, event_instance, people, attendance). The system_health row the
 * cron writes is left in place — a real record of a real invocation, same
 * convention as T5.
 *
 * Run: node scripts/t6-attendance-summary-live-test.mjs
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

const EVENT_NAME = 'T6 Live Test Event'
const PHONE_PREFIX = '+628888006' // distinct from T5's +628888005xxx
const ATTENDEE_COUNT = 60
const REAL_ADMIN_ID = '00000000-0000-0000-0000-000000000000' // admin@example.com — used as checked_in_by

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !CRON_SECRET) {
  console.error('Missing env vars (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / CRON_SECRET)')
  process.exit(1)
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

async function cleanupByName() {
  const { data: existingEvents } = await admin.from('events').select('id').eq('name', EVENT_NAME)
  if (existingEvents?.length) {
    const eventIds = existingEvents.map((e) => e.id)
    const { data: existingInstances } = await admin
      .from('event_instances')
      .select('id')
      .in('event_id', eventIds)
    if (existingInstances?.length) {
      const instanceIds = existingInstances.map((i) => i.id)
      await admin.from('attendance').delete().in('event_instance_id', instanceIds)
      await admin.from('event_instances').delete().in('id', instanceIds)
    }
    await admin.from('events').delete().in('id', eventIds)
    console.log(`  Pre-cleanup: removed ${eventIds.length} existing T6 fixture event(s) + descendants`)
  }
  const { data: existingPeople } = await admin
    .from('people')
    .select('id')
    .like('phone_e164', `${PHONE_PREFIX}%`)
  if (existingPeople?.length) {
    await admin.from('attendance').delete().in('person_id', existingPeople.map((p) => p.id))
    await admin.from('people').delete().in('id', existingPeople.map((p) => p.id))
    console.log(`  Pre-cleanup: removed ${existingPeople.length} existing T6 fixture people`)
  }
}

async function main() {
  console.log('\n=== Sprint 4 T4-11 — live attendance summary test ===\n')

  await cleanupByName()

  const nowIso = new Date().toISOString()

  const { data: ev, error: evErr } = await admin
    .from('events')
    .insert({
      name: EVENT_NAME,
      event_type: 'adhoc',
      start_date: nowIso.slice(0, 10),
      start_time: '18:00:00',
      active: true,
      created_by: REAL_ADMIN_ID,
    })
    .select('id')
    .single()
  if (evErr) throw evErr
  console.log('  Inserted fixture event:', ev.id)

  const { data: inst, error: instErr } = await admin
    .from('event_instances')
    .insert({
      event_id: ev.id,
      scheduled_at: nowIso,
      event_name_snapshot: EVENT_NAME,
      event_name_snapshot_id: null,
      status: 'scheduled',
    })
    .select('id')
    .single()
  if (instErr) throw instErr
  console.log('  Inserted fixture event_instance:', inst.id)

  const peopleRows = Array.from({ length: ATTENDEE_COUNT }, (_, i) => ({
    phone_e164: `${PHONE_PREFIX}${String(i + 1).padStart(3, '0')}`,
    full_name: `T6 Live Test Attendee With A Deliberately Long Padded Name Number ${i + 1}`,
    nickname: `T6Live${i + 1}`,
  }))
  const { data: people, error: peopleErr } = await admin.from('people').insert(peopleRows).select('id')
  if (peopleErr) throw peopleErr
  console.log(`  Inserted ${people.length} fixture people`)

  const attendanceRows = people.map((p) => ({
    event_instance_id: inst.id,
    person_id: p.id,
    checked_in_at: nowIso,
    checked_in_by: REAL_ADMIN_ID,
  }))
  const { error: attErr } = await admin.from('attendance').insert(attendanceRows)
  if (attErr) throw attErr
  console.log(`  Inserted ${attendanceRows.length} fixture attendance rows`)

  console.log('\nTriggering GET /api/cron/attendance-summary ...')
  const res = await fetch(`${PROD_URL}/api/cron/attendance-summary`, {
    headers: { Authorization: `Bearer ${CRON_SECRET}` },
  })
  const body = await res.json().catch(() => null)
  console.log(`HTTP ${res.status}`)
  console.log(JSON.stringify(body, null, 2))

  // Cleanup fixture rows regardless of outcome — never leave test residue on prod
  const personIds = people.map((p) => p.id)
  await admin.from('attendance').delete().in('person_id', personIds)
  await admin.from('people').delete().in('id', personIds)
  await admin.from('event_instances').delete().eq('id', inst.id)
  await admin.from('events').delete().eq('id', ev.id)
  console.log('\n  Cleanup: removed fixture event, event_instance, people, and attendance rows')

  if (res.status === 200 && body?.ok === true && body?.status === 'sent' && body?.count === ATTENDEE_COUNT) {
    console.log(`\n✓ T4-11 PASS (server-side) — Telegram accepted the summary, messageId: ${body.message_id}, count: ${body.count}`)
    console.log('  Manual step: confirm the message physically arrived, is under 4096 chars,')
    console.log(`  and shows "…dan N lainnya" with N = ${ATTENDEE_COUNT} minus however many names were shown —`)
    console.log('  before citing verified: live (a 200 to a wrong chat, or an unverified body, is a silent failure).')
  } else {
    console.log('\n✗ T4-11 FAIL (server-side)')
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error('Script error:', err)
  process.exit(1)
})
