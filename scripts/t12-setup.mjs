/**
 * Sprint 1 T12 — Setup script
 * 1. Creates organizer auth user (organizer-example@example.test) + app_users row
 * 2. Seeds 30 Dogfood Test people for acceptance testing + 50-in-30 dogfood
 *
 * Run: node scripts/t12-setup.mjs
 * Cleanup: node scripts/t12-setup.mjs --cleanup
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

const SUPABASE_URL     = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SERVICE_ROLE_KEY'); process.exit(1)
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const ORGANIZER_EMAIL = 'organizer-example@example.test'

// 6 parish IDs from production DB
const PARISHES = [
  { id: '67b69fe9-cc3a-4731-868f-332227a07b32', name: 'Paroki Hati Kudus Yesus, Kramat' },
  { id: '9734383d-eee7-4a1d-afdf-8c79e34c0267', name: 'Paroki Katedral Jakarta' },
  { id: '3feb2824-0ee0-47b5-86fb-6cde672e647d', name: 'Paroki Santa Theresia, Menteng' },
  { id: '16b308b9-0faf-44c8-8b82-0c689238868f', name: 'Paroki Cempaka Putih' },
  { id: '5d139b15-4377-4b8d-9db1-29186c7c54c2', name: 'Paroki Ekspatriat' },
  { id: 'defff111-8b19-400e-8df4-ae46a5f03c91', name: 'Paroki Jalan Malang' },
]

// Build 30 dogfood seed people
// Phones: +628000000001 through +628000000030
// Two "Maria" variants at positions 15 and 16 for T1-15 search test
function buildSeedPeople() {
  const rows = []
  for (let i = 1; i <= 30; i++) {
    const phone = `+62800000${String(i).padStart(4, '0')}`
    const parish = PARISHES[(i - 1) % PARISHES.length]
    const isMariaSlot = i === 15 || i === 16
    const full_name = isMariaSlot
      ? `Dogfood Test Maria ${String(i - 14).padStart(2, '0')}`
      : `Dogfood Test ${String(i).padStart(2, '0')}`
    const nickname = isMariaSlot ? `Maria${i - 14}` : `Test${i}`
    rows.push({
      phone_e164:           phone,
      full_name,
      nickname,
      birth_date:           `199${(i % 10)}-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
      origin_parish:        parish.name,
      current_city:         'Jakarta',
      photo_publish_consent: i % 3 !== 0,
      photo_consent_at:     i % 3 !== 0 ? new Date().toISOString() : null,
      created_at:           new Date().toISOString(),
      updated_at:           new Date().toISOString(),
    })
  }
  return rows
}

async function setupOrganizer() {
  console.log('\n--- Setting up organizer account ---')

  // Check if already exists in auth.users
  const { data: { users }, error: listErr } = await admin.auth.admin.listUsers({ perPage: 100 })
  if (listErr) throw listErr

  let organizerUser = users.find(u => u.email === ORGANIZER_EMAIL)

  if (!organizerUser) {
    const { data, error } = await admin.auth.admin.createUser({
      email: ORGANIZER_EMAIL,
      email_confirm: true,
    })
    if (error) throw error
    organizerUser = data.user
    console.log(`  ✓ Created auth user: ${ORGANIZER_EMAIL} (${organizerUser.id})`)
  } else {
    console.log(`  ✓ Auth user already exists: ${ORGANIZER_EMAIL} (${organizerUser.id})`)
  }

  // Check if in app_users
  const { data: existing } = await admin.from('app_users').select('id,role').eq('id', organizerUser.id).maybeSingle()
  if (!existing) {
    const { error } = await admin.from('app_users').insert({
      id: organizerUser.id,
      email: ORGANIZER_EMAIL,
      role: 'organizer',
      created_at: new Date().toISOString(),
    })
    if (error) throw error
    console.log(`  ✓ Inserted app_users row: role=organizer`)
  } else {
    console.log(`  ✓ app_users row exists: role=${existing.role}`)
  }

  return organizerUser.id
}

async function seedDogfoodPeople() {
  console.log('\n--- Seeding 30 Dogfood Test people ---')

  // Check how many already exist
  const { data: existing, error: chkErr } = await admin
    .from('people')
    .select('id,phone_e164')
    .like('full_name', 'Dogfood Test%')
  if (chkErr) throw chkErr

  if (existing.length === 30) {
    console.log('  ✓ All 30 Dogfood Test people already exist — skipping seed')
    return
  }
  if (existing.length > 0) {
    console.log(`  ! ${existing.length} already exist, cleaning up first`)
    const phones = existing.map(r => r.phone_e164)
    await admin.from('people').delete().in('phone_e164', phones)
  }

  const rows = buildSeedPeople()
  const { error } = await admin.from('people').insert(rows)
  if (error) throw error
  console.log(`  ✓ Inserted 30 Dogfood Test people (phones +628000000001–030)`)
  console.log('    Including: Dogfood Test Maria 01 (+628000000015) and Dogfood Test Maria 02 (+628000000016)')
}

async function cleanup() {
  console.log('\n--- Cleanup: deleting Dogfood Test + T12 AcceptTest people ---')
  const { data, error } = await admin
    .from('people')
    .delete()
    .like('full_name', 'Dogfood Test%')
    .select('id,full_name')
  if (error) { console.error('Cleanup error:', error); process.exit(1) }
  console.log(`  ✓ Deleted ${data.length} rows: ${data.map(r => r.full_name).join(', ')}`)
  console.log('\n  NOTE: audit_log rows for these people remain (append-only, expected).')
  console.log('  To verify cleanup: SELECT COUNT(*) FROM people WHERE full_name LIKE \'Dogfood Test%\';')
}

async function main() {
  const isCleanup = process.argv.includes('--cleanup')

  if (isCleanup) {
    await cleanup()
    console.log('\n✓ Cleanup complete')
    return
  }

  const organizerId = await setupOrganizer()
  await seedDogfoodPeople()

  // Verify
  const { data: check } = await admin.from('people').select('id').like('full_name', 'Dogfood Test%')
  const { data: orgCheck } = await admin.from('app_users').select('id,role').eq('id', organizerId).maybeSingle()

  console.log('\n--- Verification ---')
  console.log(`  People with "Dogfood Test" in name: ${check?.length ?? 0} (expected 30)`)
  console.log(`  Organizer in app_users: role=${orgCheck?.role} (expected organizer)`)
  console.log(`  Organizer ID: ${organizerId}`)
  console.log('\n✓ Setup complete. Ready for T1-01 through T1-21 acceptance tests and 50-in-30 dogfood.')
  console.log('\nCleanup (run AFTER retrospective is written, as final step):')
  console.log('  node scripts/t12-setup.mjs --cleanup')
}

main().catch(e => { console.error(e); process.exit(1) })
