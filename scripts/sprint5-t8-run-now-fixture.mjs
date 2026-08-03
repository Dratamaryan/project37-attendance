/**
 * Sprint 5 T8 — live-verify fixture helper for the Settings "Run Attendance
 * Summary Now" button. Prod has zero check-ins and no past-due event
 * instances today (2026-08-03 ICT, confirmed by direct query before writing
 * this), so a real click would return 'empty' — not the 'sent' outcome the
 * live-verify plan needs to actually prove a message arrives. This seeds one
 * throwaway event/instance/person/attendance row (scheduled a few minutes in
 * the past, checked in today) so the first click is guaranteed to send, then
 * cleans it up afterward. Never fires a cron/action itself — the actual
 * "Run Attendance Summary Now" clicks are Ryan's, via the real /admin/settings
 * UI, so this test exercises the real server action + admin session, not a
 * scripted bypass. Same fixture-then-clean pattern as
 * scripts/t5-cron-hardening-live-test.mjs.
 *
 * Usage:
 *   node scripts/sprint5-t8-run-now-fixture.mjs seed
 *   node scripts/sprint5-t8-run-now-fixture.mjs cleanup
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

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing env vars (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)')
  process.exit(1)
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const EVENT_NAME = 'T8 Run-Now Live Verify Event'
const PHONE = '+628888008001' // distinct from T5's 007xxx live-test space
const REAL_ADMIN_ID = '00000000-0000-0000-0000-000000000000' // admin-example@example.test

async function cleanup() {
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
    console.log(`Removed ${eventIds.length} fixture event(s) + descendants`)
  }
  const { data: existingPeople } = await admin.from('people').select('id').eq('phone_e164', PHONE)
  if (existingPeople?.length) {
    await admin.from('attendance').delete().in('person_id', existingPeople.map((p) => p.id))
    await admin.from('people').delete().in('id', existingPeople.map((p) => p.id))
    console.log(`Removed ${existingPeople.length} fixture people`)
  }
}

async function seed() {
  await cleanup() // idempotent re-run safety

  const nowIso = new Date().toISOString()
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
  console.log('Inserted fixture event:', ev.id)

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
  console.log('Inserted fixture event_instance (scheduled_at 5min ago):', inst.id)

  const { data: person, error: personErr } = await admin
    .from('people')
    .insert({ phone_e164: PHONE, full_name: 'T8 Live Run-Now Fixture', nickname: 'T8RunNow' })
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
  console.log('Inserted fixture attendance row')
  console.log('\nSeed complete. Go click "Run Attendance Summary Now" on /admin/settings now.')
  console.log('When done (both clicks confirmed), run: node scripts/sprint5-t8-run-now-fixture.mjs cleanup')
}

const mode = process.argv[2]
if (mode === 'seed') {
  seed().catch((err) => {
    console.error(err)
    process.exit(1)
  })
} else if (mode === 'cleanup') {
  cleanup().catch((err) => {
    console.error(err)
    process.exit(1)
  })
} else {
  console.error('Usage: node scripts/sprint5-t8-run-now-fixture.mjs <seed|cleanup>')
  process.exit(1)
}
