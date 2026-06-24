/**
 * Demo-data seed — S3-T3
 *
 * Run:  npm run seed:demo
 *   or  npx tsx --env-file .env.local seed/demo-data.ts
 *
 * Wipe-able by construction (targeted in S6-T0):
 *   people:     phone_e164 LIKE '+62999%'
 *   events:     created_by = demo actor row
 *   attendance: source = 'demo_seed'
 *
 * Idempotent: safe to run multiple times — ON CONFLICT DO NOTHING everywhere.
 * Audit rows written only when a row is actually inserted (gate on RETURNING).
 */

import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Month = '2026-01' | '2026-02' | '2026-03' | '2026-04' | '2026-05' | '2026-06'
type Tier = 'regular' | 'occasional' | 'onetimer'
type Gender = 'male' | 'female'
type MaritalStatus = 'married' | 'single'

interface PersonDef {
  idx: number
  phone: string
  fullName: string
  nickname: string
  originParish: string
  gender: Gender
  maritalStatus: MaritalStatus | null
  tribe: string | null
  kepanitiaan: string | null
  tier: Tier
  debutMonth: Month
  attendedMonths: Month[]
}

interface EventDef {
  name: string
  nameId: string
  eventType: 'friday_monthly' | 'sunday_monthly' | 'adhoc'
  startDate: string
  startTime: string
}

interface InstanceDef {
  eventName: string
  scheduledAt: string
  nameSnapshot: string
  nameSnapshotId: string
}

// ---------------------------------------------------------------------------
// Instance schedule: 15 instances across 6 months
// ---------------------------------------------------------------------------
//   Friday (18:00 WIB = 11:00 UTC): 2nd Friday of each month Jan–Jun 2026
//   Sunday (15:00 WIB = 08:00 UTC): 1st Sunday of each month Jan–Jun 2026
//   Adhoc  (19:00 WIB = 12:00 UTC): Feb 25, Apr 22, Jun 17

const INSTANCES_BY_MONTH: Record<Month, string[]> = {
  '2026-01': ['2026-01-04T08:00:00Z', '2026-01-09T11:00:00Z'],
  '2026-02': ['2026-02-01T08:00:00Z', '2026-02-13T11:00:00Z', '2026-02-25T12:00:00Z'],
  '2026-03': ['2026-03-01T08:00:00Z', '2026-03-13T11:00:00Z'],
  '2026-04': ['2026-04-05T08:00:00Z', '2026-04-10T11:00:00Z', '2026-04-22T12:00:00Z'],
  '2026-05': ['2026-05-03T08:00:00Z', '2026-05-08T11:00:00Z'],
  '2026-06': ['2026-06-07T08:00:00Z', '2026-06-12T11:00:00Z', '2026-06-17T12:00:00Z'],
}

const ALL_MONTHS: Month[] = [
  '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06',
]

// ---------------------------------------------------------------------------
// Event definitions (3 events, recurrence_rule = NULL → materializer skips)
// ---------------------------------------------------------------------------

const EVENTS: EventDef[] = [
  {
    name: 'Project Day [DEMO]',
    nameId: 'Project Day [DEMO]',
    eventType: 'friday_monthly',
    startDate: '2026-01-09',
    startTime: '18:00',
  },
  {
    name: 'Tribe Connect [DEMO]',
    nameId: 'Obor Doa [DEMO]',
    eventType: 'sunday_monthly',
    startDate: '2026-01-04',
    startTime: '15:00',
  },
  {
    name: 'Pertemuan Khusus [DEMO]',
    nameId: 'Pertemuan Khusus [DEMO]',
    eventType: 'adhoc',
    startDate: '2026-02-25',
    startTime: '19:00',
  },
]

// Which event each scheduledAt belongs to (for building InstanceDef list)
const INSTANCE_DEFS: InstanceDef[] = [
  // Friday — Project Day [DEMO]
  ...(['2026-01-09T11:00:00Z', '2026-02-13T11:00:00Z', '2026-03-13T11:00:00Z',
       '2026-04-10T11:00:00Z', '2026-05-08T11:00:00Z', '2026-06-12T11:00:00Z'] as const).map(
    (sat) => ({ eventName: 'Project Day [DEMO]', scheduledAt: sat, nameSnapshot: 'Project Day [DEMO]', nameSnapshotId: 'Project Day [DEMO]' })
  ),
  // Sunday — Tribe Connect [DEMO]
  ...(['2026-01-04T08:00:00Z', '2026-02-01T08:00:00Z', '2026-03-01T08:00:00Z',
       '2026-04-05T08:00:00Z', '2026-05-03T08:00:00Z', '2026-06-07T08:00:00Z'] as const).map(
    (sat) => ({ eventName: 'Tribe Connect [DEMO]', scheduledAt: sat, nameSnapshot: 'Tribe Connect [DEMO]', nameSnapshotId: 'Obor Doa [DEMO]' })
  ),
  // Adhoc — Pertemuan Khusus [DEMO]
  ...(['2026-02-25T12:00:00Z', '2026-04-22T12:00:00Z', '2026-06-17T12:00:00Z'] as const).map(
    (sat) => ({ eventName: 'Pertemuan Khusus [DEMO]', scheduledAt: sat, nameSnapshot: 'Pertemuan Khusus [DEMO]', nameSnapshotId: 'Pertemuan Khusus [DEMO]' })
  ),
]

// ---------------------------------------------------------------------------
// People definitions (40 people)
//
// Debut / attendance layout:
//   Persons  1–10 : regulars  — debut Jan, attend ALL 15 instances
//   Persons 11–15 : occasional — debut Jan, 3 months each
//   Persons 16–23 : occasional — debut Feb, 2–3 months each
//   Persons 24–25 : occasional — debut Mar, 2 months each
//   Persons 26–30 : one-timer  — debut Mar
//   Persons 31–35 : one-timer  — debut Apr
//   Persons 36–38 : one-timer  — debut May
//   Persons 39–40 : one-timer  — debut Jun
//
// Expected new_vs_returning_monthly:
//   Jan: new=15 ret=0  Feb: new=8 ret=12  Mar: new=7 ret=16
//   Apr: new=5 ret=15  May: new=3 ret=17  Jun: new=2 ret=16
// ---------------------------------------------------------------------------

const PEOPLE: PersonDef[] = [
  // ── Paroki Serpong — regulars (1–10) ─────────────────────────────────────
  { idx:  1, phone: '+629991000001', fullName: 'Alberto Hartono',       nickname: 'Alberto',   originParish: 'Paroki Serpong',                         gender: 'male',   maritalStatus: 'married', tribe: 'Deborah',  kepanitiaan: 'Shepherd/Servant', tier: 'regular',    debutMonth: '2026-01', attendedMonths: ALL_MONTHS },
  { idx:  2, phone: '+629991000002', fullName: 'Benedikta Liem',        nickname: 'Bene',      originParish: 'Paroki Serpong',                         gender: 'female', maritalStatus: 'single',  tribe: 'Cana',     kepanitiaan: null,               tier: 'regular',    debutMonth: '2026-01', attendedMonths: ALL_MONTHS },
  { idx:  3, phone: '+629991000003', fullName: 'Carolus Tanujaya',      nickname: 'Carl',      originParish: 'Paroki Serpong',                         gender: 'male',   maritalStatus: 'married', tribe: null,       kepanitiaan: 'Member',           tier: 'regular',    debutMonth: '2026-01', attendedMonths: ALL_MONTHS },
  { idx:  4, phone: '+629991000004', fullName: 'Dorothea Wibowo',       nickname: 'Thea',      originParish: 'Paroki Serpong',                         gender: 'female', maritalStatus: 'single',  tribe: 'Eden',     kepanitiaan: null,               tier: 'regular',    debutMonth: '2026-01', attendedMonths: ALL_MONTHS },
  { idx:  5, phone: '+629991000005', fullName: 'Emmanuel Susanto',      nickname: 'Manu',      originParish: 'Paroki Serpong',                         gender: 'male',   maritalStatus: 'married', tribe: 'Daniel',   kepanitiaan: 'Servant',          tier: 'regular',    debutMonth: '2026-01', attendedMonths: ALL_MONTHS },
  { idx:  6, phone: '+629991000006', fullName: 'Florentina Gunawan',    nickname: 'Flo',       originParish: 'Paroki Serpong',                         gender: 'female', maritalStatus: 'married', tribe: 'Deborah',  kepanitiaan: 'Member',           tier: 'regular',    debutMonth: '2026-01', attendedMonths: ALL_MONTHS },
  { idx:  7, phone: '+629991000007', fullName: 'Gregorius Halim',       nickname: 'Gregor',    originParish: 'Paroki Serpong',                         gender: 'male',   maritalStatus: 'single',  tribe: 'Mary',     kepanitiaan: null,               tier: 'regular',    debutMonth: '2026-01', attendedMonths: ALL_MONTHS },
  { idx:  8, phone: '+629991000008', fullName: 'Hendrika Santoso',      nickname: 'Ika',       originParish: 'Paroki Serpong',                         gender: 'female', maritalStatus: 'married', tribe: null,       kepanitiaan: 'Servant',          tier: 'regular',    debutMonth: '2026-01', attendedMonths: ALL_MONTHS },
  { idx:  9, phone: '+629991000009', fullName: 'Ignatius Lukman',       nickname: 'Ignas',     originParish: 'Paroki Serpong',                         gender: 'male',   maritalStatus: 'single',  tribe: 'Cana',     kepanitiaan: null,               tier: 'regular',    debutMonth: '2026-01', attendedMonths: ALL_MONTHS },
  { idx: 10, phone: '+629991000010', fullName: 'Juventia Salim',        nickname: 'Iuven',     originParish: 'Paroki Serpong',                         gender: 'female', maritalStatus: 'single',  tribe: 'Eden',     kepanitiaan: null,               tier: 'regular',    debutMonth: '2026-01', attendedMonths: ALL_MONTHS },

  // ── Paroki Bintaro Jaya — occasionals Jan (11–15) + occasionals Feb (16–19) + one-timers Feb area (19)
  { idx: 11, phone: '+629991000011', fullName: 'Kevin Purnomo',         nickname: 'Kevin',     originParish: 'Paroki Bintaro Jaya',                    gender: 'male',   maritalStatus: 'single',  tribe: 'Daniel',   kepanitiaan: null,               tier: 'occasional', debutMonth: '2026-01', attendedMonths: ['2026-01', '2026-03', '2026-05'] },
  { idx: 12, phone: '+629991000012', fullName: 'Lucia Handayani',       nickname: 'Lucia',     originParish: 'Paroki Bintaro Jaya',                    gender: 'female', maritalStatus: 'married', tribe: null,       kepanitiaan: 'Member',           tier: 'occasional', debutMonth: '2026-01', attendedMonths: ['2026-01', '2026-04', '2026-06'] },
  { idx: 13, phone: '+629991000013', fullName: 'Martinus Chandra',      nickname: 'Martin',    originParish: 'Paroki Bintaro Jaya',                    gender: 'male',   maritalStatus: 'married', tribe: null,       kepanitiaan: null,               tier: 'occasional', debutMonth: '2026-01', attendedMonths: ['2026-01', '2026-02', '2026-05'] },
  { idx: 14, phone: '+629991000014', fullName: 'Natalia Kurniawan',     nickname: 'Nata',      originParish: 'Paroki Bintaro Jaya',                    gender: 'female', maritalStatus: 'single',  tribe: 'Mary',     kepanitiaan: null,               tier: 'occasional', debutMonth: '2026-01', attendedMonths: ['2026-01', '2026-02', '2026-04'] },
  { idx: 15, phone: '+629991000015', fullName: 'Oktavianus Setiawan',   nickname: 'Okta',      originParish: 'Paroki Bintaro Jaya',                    gender: 'male',   maritalStatus: 'married', tribe: null,       kepanitiaan: 'Servant',          tier: 'occasional', debutMonth: '2026-01', attendedMonths: ['2026-01', '2026-03', '2026-06'] },

  // ── Paroki Bintaro Jaya — occasionals Feb (16–19) ─────────────────────────
  { idx: 16, phone: '+629991000016', fullName: 'Patrisia Hidayat',      nickname: 'Patri',     originParish: 'Paroki Bintaro Jaya',                    gender: 'female', maritalStatus: 'single',  tribe: null,       kepanitiaan: null,               tier: 'occasional', debutMonth: '2026-02', attendedMonths: ['2026-02', '2026-04', '2026-06'] },
  { idx: 17, phone: '+629991000017', fullName: 'Quintus Rahardjo',      nickname: 'Quin',      originParish: 'Paroki Bintaro Jaya',                    gender: 'male',   maritalStatus: 'single',  tribe: 'Bethlehem', kepanitiaan: null,              tier: 'occasional', debutMonth: '2026-02', attendedMonths: ['2026-02', '2026-03', '2026-05'] },
  { idx: 18, phone: '+629991000018', fullName: 'Rosalinda Wongso',      nickname: 'Rosa',      originParish: 'Paroki Bintaro Jaya',                    gender: 'female', maritalStatus: 'married', tribe: null,       kepanitiaan: null,               tier: 'occasional', debutMonth: '2026-02', attendedMonths: ['2026-02', '2026-03', '2026-06'] },
  { idx: 19, phone: '+629991000019', fullName: 'Stanislaus Djaja',      nickname: 'Stan',      originParish: 'Paroki Bintaro Jaya',                    gender: 'male',   maritalStatus: 'single',  tribe: null,       kepanitiaan: null,               tier: 'occasional', debutMonth: '2026-02', attendedMonths: ['2026-02', '2026-04', '2026-05'] },

  // ── Paroki Danau Sunter — occasionals Feb (20–23) ─────────────────────────
  { idx: 20, phone: '+629991000020', fullName: 'Theresia Manurung',     nickname: 'Thesa',     originParish: 'Paroki Danau Sunter',                    gender: 'female', maritalStatus: 'married', tribe: 'Jacob',    kepanitiaan: null,               tier: 'occasional', debutMonth: '2026-02', attendedMonths: ['2026-02', '2026-06'] },
  { idx: 21, phone: '+629991000021', fullName: 'Urbanus Sihotang',      nickname: 'Urban',     originParish: 'Paroki Danau Sunter',                    gender: 'male',   maritalStatus: 'married', tribe: null,       kepanitiaan: null,               tier: 'occasional', debutMonth: '2026-02', attendedMonths: ['2026-02', '2026-03'] },
  { idx: 22, phone: '+629991000022', fullName: 'Veronica Simanjuntak',  nickname: 'Vero',      originParish: 'Paroki Danau Sunter',                    gender: 'female', maritalStatus: 'single',  tribe: 'Tabor',    kepanitiaan: null,               tier: 'occasional', debutMonth: '2026-02', attendedMonths: ['2026-02', '2026-05'] },
  { idx: 23, phone: '+629991000023', fullName: 'Wilhelmus Situmorang',  nickname: 'Wilhem',    originParish: 'Paroki Danau Sunter',                    gender: 'male',   maritalStatus: 'married', tribe: null,       kepanitiaan: null,               tier: 'occasional', debutMonth: '2026-02', attendedMonths: ['2026-02', '2026-04'] },

  // ── Paroki Danau Sunter — occasionals Mar (24–25) ─────────────────────────
  { idx: 24, phone: '+629991000024', fullName: 'Xaveria Gultom',        nickname: 'Xave',      originParish: 'Paroki Danau Sunter',                    gender: 'female', maritalStatus: 'single',  tribe: null,       kepanitiaan: 'Member',           tier: 'occasional', debutMonth: '2026-03', attendedMonths: ['2026-03', '2026-05'] },
  { idx: 25, phone: '+629991000025', fullName: 'Yohanes Saragih',       nickname: 'Yohan',     originParish: 'Paroki Danau Sunter',                    gender: 'male',   maritalStatus: 'single',  tribe: 'Nazareth', kepanitiaan: null,               tier: 'occasional', debutMonth: '2026-03', attendedMonths: ['2026-03', '2026-06'] },

  // ── Paroki Danau Sunter — one-timers Mar (26–27) ──────────────────────────
  { idx: 26, phone: '+629991000026', fullName: 'Zefanias Sinaga',       nickname: 'Zef',       originParish: 'Paroki Danau Sunter',                    gender: 'male',   maritalStatus: 'married', tribe: null,       kepanitiaan: null,               tier: 'onetimer',   debutMonth: '2026-03', attendedMonths: ['2026-03'] },
  { idx: 27, phone: '+629991000027', fullName: 'Angela Panjaitan',      nickname: 'Angel',     originParish: 'Paroki Danau Sunter',                    gender: 'female', maritalStatus: 'single',  tribe: null,       kepanitiaan: null,               tier: 'onetimer',   debutMonth: '2026-03', attendedMonths: ['2026-03'] },

  // ── Paroki Santo Kristoforus, Grogol — one-timers Mar (28–30) ────────────
  { idx: 28, phone: '+629991000028', fullName: 'Bernadus Widjaja',      nickname: 'Bernad',    originParish: 'Paroki Santo Kristoforus, Grogol',       gender: 'male',   maritalStatus: 'married', tribe: 'Deborah',  kepanitiaan: null,               tier: 'onetimer',   debutMonth: '2026-03', attendedMonths: ['2026-03'] },
  { idx: 29, phone: '+629991000029', fullName: 'Cecilia Tjipto',        nickname: 'Cecel',     originParish: 'Paroki Santo Kristoforus, Grogol',       gender: 'female', maritalStatus: 'single',  tribe: null,       kepanitiaan: null,               tier: 'onetimer',   debutMonth: '2026-03', attendedMonths: ['2026-03'] },
  { idx: 30, phone: '+629991000030', fullName: 'Daniel Hartawan',       nickname: 'Dani',      originParish: 'Paroki Santo Kristoforus, Grogol',       gender: 'male',   maritalStatus: 'single',  tribe: null,       kepanitiaan: null,               tier: 'onetimer',   debutMonth: '2026-03', attendedMonths: ['2026-03'] },

  // ── Paroki Santo Kristoforus, Grogol — one-timers Apr (31–34) ────────────
  { idx: 31, phone: '+629991000031', fullName: 'Elisabeth Budiarto',    nickname: 'Elisa',     originParish: 'Paroki Santo Kristoforus, Grogol',       gender: 'female', maritalStatus: 'married', tribe: null,       kepanitiaan: 'Member',           tier: 'onetimer',   debutMonth: '2026-04', attendedMonths: ['2026-04'] },
  { idx: 32, phone: '+629991000032', fullName: 'Fransiskus Santoso',    nickname: 'Frans',     originParish: 'Paroki Santo Kristoforus, Grogol',       gender: 'male',   maritalStatus: 'single',  tribe: null,       kepanitiaan: null,               tier: 'onetimer',   debutMonth: '2026-04', attendedMonths: ['2026-04'] },
  { idx: 33, phone: '+629991000033', fullName: 'Gertruda Suryadi',      nickname: 'Gertrud',   originParish: 'Paroki Santo Kristoforus, Grogol',       gender: 'female', maritalStatus: 'married', tribe: null,       kepanitiaan: null,               tier: 'onetimer',   debutMonth: '2026-04', attendedMonths: ['2026-04'] },
  { idx: 34, phone: '+629991000034', fullName: 'Herman Wahyudi',        nickname: 'Herman',    originParish: 'Paroki Santo Kristoforus, Grogol',       gender: 'male',   maritalStatus: 'single',  tribe: null,       kepanitiaan: null,               tier: 'onetimer',   debutMonth: '2026-04', attendedMonths: ['2026-04'] },

  // ── Paroki Rawamangun — one-timer Apr (35) + one-timers May (36–38) ──────
  { idx: 35, phone: '+629991000035', fullName: 'Indriani Kusuma',       nickname: 'Indri',     originParish: 'Paroki Rawamangun',                      gender: 'female', maritalStatus: 'married', tribe: 'Cana',     kepanitiaan: null,               tier: 'onetimer',   debutMonth: '2026-04', attendedMonths: ['2026-04'] },
  { idx: 36, phone: '+629991000036', fullName: 'Josephus Setiadi',      nickname: 'Jose',      originParish: 'Paroki Rawamangun',                      gender: 'male',   maritalStatus: 'single',  tribe: null,       kepanitiaan: null,               tier: 'onetimer',   debutMonth: '2026-05', attendedMonths: ['2026-05'] },
  { idx: 37, phone: '+629991000037', fullName: 'Katarina Nainggolan',   nickname: 'Katri',     originParish: 'Paroki Rawamangun',                      gender: 'female', maritalStatus: 'single',  tribe: null,       kepanitiaan: null,               tier: 'onetimer',   debutMonth: '2026-05', attendedMonths: ['2026-05'] },
  { idx: 38, phone: '+629991000038', fullName: 'Leontinus Hutapea',     nickname: 'Leon',      originParish: 'Paroki Rawamangun',                      gender: 'male',   maritalStatus: 'married', tribe: null,       kepanitiaan: null,               tier: 'onetimer',   debutMonth: '2026-05', attendedMonths: ['2026-05'] },

  // ── Paroki Citra Raya — one-timers Jun (39–40) ────────────────────────────
  { idx: 39, phone: '+629991000039', fullName: 'Maria Situmorang',      nickname: 'Maria',     originParish: 'Paroki Citra Raya',                      gender: 'female', maritalStatus: 'single',  tribe: 'Eden',     kepanitiaan: null,               tier: 'onetimer',   debutMonth: '2026-06', attendedMonths: ['2026-06'] },
  { idx: 40, phone: '+629991000040', fullName: 'Nikodemus Pangaribuan', nickname: 'Niko',      originParish: 'Paroki Citra Raya',                      gender: 'male',   maritalStatus: 'married', tribe: null,       kepanitiaan: null,               tier: 'onetimer',   debutMonth: '2026-06', attendedMonths: ['2026-06'] },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pick(arr: string[], idx: number): string {
  return arr[idx % arr.length]
}

function die(msg: string): never {
  console.error(`\n[demo-seed] FATAL: ${msg}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    die('NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set. Run via: npm run seed:demo')
  }

  const supabase = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  let peopleInserted = 0
  let eventsInserted = 0
  let instancesInserted = 0
  let attendanceInserted = 0
  let auditInserted = 0

  // ── Step 1: Find-or-create demo actor ────────────────────────────────────
  console.log('[1/6] Finding or creating demo actor...')
  const DEMO_EMAIL = 'demo.seed@project37.internal'

  const { data: existingActor } = await supabase
    .from('app_users')
    .select('id')
    .eq('email', DEMO_EMAIL)
    .maybeSingle()

  let demoActorId: string

  if (existingActor) {
    demoActorId = existingActor.id as string
    console.log(`     actor already exists: ${demoActorId}`)
  } else {
    const { data: newActor, error: actorErr } = await supabase
      .from('app_users')
      .insert({
        id: randomUUID(),
        email: DEMO_EMAIL,
        full_name: '[DEMO] Seed Actor',
        role: 'organizer',
        active: false,
      })
      .select('id')
      .single()

    if (actorErr || !newActor) die(`Failed to create demo actor: ${actorErr?.message}`)
    demoActorId = (newActor as { id: string }).id
    console.log(`     actor created: ${demoActorId}`)
  }

  // ── Step 2: Find-or-create 3 demo events ─────────────────────────────────
  console.log('[2/6] Finding or creating demo events...')
  const eventIdByName: Record<string, string> = {}

  for (const ev of EVENTS) {
    const { data: existing } = await supabase
      .from('events')
      .select('id')
      .eq('name', ev.name)
      .maybeSingle()

    if (existing) {
      eventIdByName[ev.name] = (existing as { id: string }).id
      console.log(`     event already exists: "${ev.name}"`)
      continue
    }

    const { data: inserted, error: evErr } = await supabase
      .from('events')
      .insert({
        name: ev.name,
        name_id: ev.nameId,
        event_type: ev.eventType,
        start_date: ev.startDate,
        start_time: ev.startTime,
        duration_min: 120,
        recurrence_rule: null,
        active: true,
        created_by: demoActorId,
      })
      .select('id')
      .single()

    if (evErr || !inserted) die(`Failed to create event "${ev.name}": ${evErr?.message}`)
    const insertedEvent = inserted as { id: string }
    eventIdByName[ev.name] = insertedEvent.id
    eventsInserted++

    // Audit — gated on actual insertion
    const { error: auditErr } = await supabase.from('audit_log').insert({
      actor_user_id: demoActorId,
      action: 'events.create',
      entity_type: 'events',
      entity_id: insertedEvent.id,
      details_json: { source: 'demo_seed', name: ev.name },
    })
    if (auditErr) console.warn(`     [warn] audit write failed for event ${ev.name}: ${auditErr.message}`)
    else auditInserted++

    console.log(`     event created: "${ev.name}"`)
  }

  // ── Step 3: Guard — each debut month must have ≥1 instance defined ───────
  console.log('[3/6] Guarding instance coverage for all debut months...')
  const debutMonths = new Set(PEOPLE.map((p) => p.debutMonth))
  for (const month of debutMonths) {
    const instances = INSTANCES_BY_MONTH[month]
    if (!instances || instances.length === 0) {
      die(`Debut month ${month} has no instances defined in INSTANCES_BY_MONTH. Fix seed data.`)
    }
    // Also verify each instance's eventName maps to a known event
    for (const inst of INSTANCE_DEFS.filter((i) => i.scheduledAt.startsWith(month))) {
      if (!eventIdByName[inst.eventName]) {
        die(`Instance ${inst.scheduledAt} references unknown event "${inst.eventName}"`)
      }
    }
  }
  console.log(`     all ${debutMonths.size} debut months covered`)

  // ── Step 4: Find-or-create 15 event instances ────────────────────────────
  console.log('[4/6] Finding or creating demo instances...')
  const instanceIdByScheduledAt: Record<string, string> = {}

  for (const inst of INSTANCE_DEFS) {
    const eventId = eventIdByName[inst.eventName]

    const { data: inserted, error: instErr } = await supabase
      .from('event_instances')
      .upsert(
        {
          event_id: eventId,
          scheduled_at: inst.scheduledAt,
          event_name_snapshot: inst.nameSnapshot,
          event_name_snapshot_id: inst.nameSnapshotId,
          status: 'scheduled',
        },
        { onConflict: 'event_id,scheduled_at', ignoreDuplicates: true }
      )
      .select('id')

    if (instErr) die(`Failed to upsert instance ${inst.scheduledAt}: ${instErr.message}`)

    if (inserted && inserted.length > 0) {
      const row = inserted[0] as { id: string }
      instanceIdByScheduledAt[inst.scheduledAt] = row.id
      instancesInserted++
    } else {
      // Already existed — fetch its id
      const { data: existing, error: fetchErr } = await supabase
        .from('event_instances')
        .select('id')
        .eq('event_id', eventId)
        .eq('scheduled_at', inst.scheduledAt)
        .single()

      if (fetchErr || !existing) die(`Could not fetch existing instance at ${inst.scheduledAt}: ${fetchErr?.message}`)
      instanceIdByScheduledAt[inst.scheduledAt] = (existing as { id: string }).id
    }
  }
  console.log(`     ${instancesInserted} new instances inserted (${INSTANCE_DEFS.length - instancesInserted} already existed)`)

  // Verify all scheduledAt values are mapped
  for (const [, instances] of Object.entries(INSTANCES_BY_MONTH)) {
    for (const sat of instances) {
      if (!instanceIdByScheduledAt[sat]) {
        die(`Instance lookup failed for scheduledAt=${sat} — check INSTANCE_DEFS coverage`)
      }
    }
  }

  // ── Step 5: Find-or-create 40 demo people ────────────────────────────────
  console.log('[5/6] Finding or creating demo people...')
  const personIdByIdx: Record<number, string> = {}

  for (const person of PEOPLE) {
    const payload = {
      phone_e164:           person.phone,
      full_name:            person.fullName,
      nickname:             person.nickname,
      origin_parish:        person.originParish,
      gender:               person.gender,
      marital_status:       person.maritalStatus,
      tribe:                person.tribe,
      kepanitiaan:          person.kepanitiaan,
      photo_publish_consent: false,
    }

    const { data: inserted, error: personErr } = await supabase
      .from('people')
      .upsert(payload, { onConflict: 'phone_e164', ignoreDuplicates: true })
      .select('id')

    if (personErr) die(`Failed to upsert person ${person.phone}: ${personErr.message}`)

    let personId: string

    if (inserted && inserted.length > 0) {
      const row = inserted[0] as { id: string }
      personId = row.id
      personIdByIdx[person.idx] = personId
      peopleInserted++

      // Audit — gated on actual insertion
      const { error: auditErr } = await supabase.from('audit_log').insert({
        actor_user_id: demoActorId,
        action: 'people.create',
        entity_type: 'people',
        entity_id: personId,
        details_json: { source: 'demo_seed', phone: person.phone },
      })
      if (auditErr) console.warn(`     [warn] audit write failed for ${person.phone}: ${auditErr.message}`)
      else auditInserted++
    } else {
      // Already existed — fetch id
      const { data: existing, error: fetchErr } = await supabase
        .from('people')
        .select('id')
        .eq('phone_e164', person.phone)
        .single()

      if (fetchErr || !existing) die(`Could not fetch existing person ${person.phone}: ${fetchErr?.message}`)
      personId = (existing as { id: string }).id
      personIdByIdx[person.idx] = personId
    }
  }
  console.log(`     ${peopleInserted} new people inserted (${PEOPLE.length - peopleInserted} already existed)`)

  // ── Step 6: Seed attendance ───────────────────────────────────────────────
  console.log('[6/6] Seeding attendance...')

  const attendanceRows: {
    event_instance_id: string
    person_id: string
    checked_in_at: string
    checked_in_by: string
    source: string
  }[] = []

  for (const person of PEOPLE) {
    const personId = personIdByIdx[person.idx]

    if (person.tier === 'regular') {
      // Attend ALL instances from debut month onward
      for (const [month, scheduledAts] of Object.entries(INSTANCES_BY_MONTH) as [Month, string[]][]) {
        if (month < person.debutMonth) continue
        for (const sat of scheduledAts) {
          const instanceId = instanceIdByScheduledAt[sat]
          if (!instanceId) die(`Missing instanceId for ${sat}`)
          attendanceRows.push({
            event_instance_id: instanceId,
            person_id: personId,
            checked_in_at: sat,
            checked_in_by: demoActorId,
            source: 'demo_seed',
          })
        }
      }
    } else {
      // Attend one instance per attendedMonth (deterministic: person.idx % instanceCount)
      for (const month of person.attendedMonths) {
        const instances = INSTANCES_BY_MONTH[month]
        const sat = pick(instances, person.idx - 1)
        const instanceId = instanceIdByScheduledAt[sat]
        if (!instanceId) die(`Missing instanceId for ${sat}`)
        attendanceRows.push({
          event_instance_id: instanceId,
          person_id: personId,
          checked_in_at: sat,
          checked_in_by: demoActorId,
          source: 'demo_seed',
        })
      }
    }
  }

  // Batch insert in chunks of 50 (safe for Supabase row limit)
  const CHUNK = 50
  for (let i = 0; i < attendanceRows.length; i += CHUNK) {
    const chunk = attendanceRows.slice(i, i + CHUNK)
    const { data: inserted, error: attErr } = await supabase
      .from('attendance')
      .upsert(chunk, { onConflict: 'event_instance_id,person_id', ignoreDuplicates: true })
      .select('id')

    if (attErr) die(`Attendance batch ${i}–${i + chunk.length - 1} failed: ${attErr.message}`)
    attendanceInserted += inserted?.length ?? 0
  }
  console.log(`     ${attendanceInserted} new attendance rows inserted (${attendanceRows.length - attendanceInserted} already existed)`)

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n✓ Demo seed complete')
  console.log(`  people:     ${peopleInserted} inserted`)
  console.log(`  events:     ${eventsInserted} inserted`)
  console.log(`  instances:  ${instancesInserted} inserted`)
  console.log(`  attendance: ${attendanceInserted} inserted`)
  console.log(`  audit rows: ${auditInserted} written`)
  console.log('\nRun `npm run verify:demo` to check the analytics views.')
}

main().catch((err: unknown) => {
  console.error('[demo-seed] Unhandled error:', err)
  process.exit(1)
})
