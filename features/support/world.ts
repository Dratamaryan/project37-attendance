// S6-T11: BDD World — fixture + teardown scaffolding shared by all scenarios.
// Same local-Docker-only guard as setupTests.ts, duplicated here because
// Cucumber does not load that file. Same fixture/teardown idioms as
// tests/integration/*.test.ts (service-role client for setup, per-actor
// session clients for RLS-sensitive calls, reverse-dependency cleanup).
//
// Fixture reservation: phones +62812000930xxx, app_users ids are fresh
// randomUUID()s (no fixed suffix needed — this file never upserts a shared
// fixed-id fixture the way the vitest suite's FAKE_ADMIN_ID convention does).
import { setWorldConstructor, World as CucumberWorld } from '@cucumber/cucumber'
import type { IWorldOptions } from '@cucumber/cucumber'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'

const PROD_PROJECT_REF = 'bftifxgdcmisasgvobuf'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !anonKey || !serviceRoleKey) {
  throw new Error(
    '[features/support/world.ts] Missing env: NEXT_PUBLIC_SUPABASE_URL, ' +
      'NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY — is .env.test.local ' +
      'present? `npm run bdd` loads it via --env-file.',
  )
}

if (url.includes(PROD_PROJECT_REF)) {
  throw new Error(
    `[features/support/world.ts] NEXT_PUBLIC_SUPABASE_URL resolves to the PRODUCTION ` +
      `project (${PROD_PROJECT_REF}). The BDD suite must run against local Docker only ` +
      `— check .env.test.local exists and 'supabase start' is running.`,
  )
}

const serviceAdmin: SupabaseClient = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

let phoneCounter = 0
function nextPhone(): string {
  return `+62812000930${(phoneCounter++).toString().padStart(3, '0')}`
}

export class BddWorld extends CucumberWorld {
  serviceAdmin = serviceAdmin

  // Teardown tracking — reverse-dependency order in features/support/hooks.ts.
  eventIds: string[] = []
  personIds: string[] = []
  sessionUserIds: string[] = [] // real auth.users + app_users rows
  fakeActorIds: string[] = [] // app_users rows only, no auth.users (e.g. import actor)

  // Cross-step scratch space for a single scenario. Each steps/*.ts file owns
  // a small typed view onto this (see the `scenarioState` helper at the top
  // of each file, which casts via `as ScenarioState`) rather than the World
  // class growing one optional field per scenario — keeps this file about
  // fixtures/teardown, not per-feature state. Typed `unknown` (not
  // `Record<string, unknown>`) so a step file's own named interface can be
  // assigned straight back into it without an index-signature mismatch.
  state: unknown = {}

  constructor(options: IWorldOptions) {
    super(options)
  }

  nextPhone(): string {
    return nextPhone()
  }

  /** A real signed-in admin/organizer, for calls that go through RLS or requireActiveAdmin. */
  async createAppUser(
    label: string,
    role: 'admin' | 'organizer',
    active = true,
  ): Promise<{ id: string; session: SupabaseClient }> {
    const tag = `${Date.now()}-${randomUUID().slice(0, 8)}`
    const email = `bdd-${label}-${tag}@test.invalid`
    const password = `BddPass-${tag}!`
    const { data: authData, error: authErr } = await this.serviceAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    })
    if (authErr || !authData.user) {
      throw new Error(`[BddWorld.createAppUser] createUser (${label}): ${authErr?.message}`)
    }
    this.sessionUserIds.push(authData.user.id)

    const { error: appErr } = await this.serviceAdmin.from('app_users').insert({
      id: authData.user.id,
      email,
      full_name: `BDD ${label}`,
      role,
      active,
    })
    if (appErr) throw new Error(`[BddWorld.createAppUser] insert app_user (${label}): ${appErr.message}`)

    const session = createClient(url!, anonKey!, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const { error: signInErr } = await session.auth.signInWithPassword({ email, password })
    if (signInErr) throw new Error(`[BddWorld.createAppUser] sign-in (${label}): ${signInErr.message}`)

    return { id: authData.user.id, session }
  }

  /** An app_users row with no backing auth.users account — for FK targets like
   *  events.created_by / import actorUserId where impl code takes a plain id,
   *  not an authenticated session (same idiom as FAKE_ADMIN_ID across the
   *  vitest integration suite). */
  async createFakeActor(label: string, role: 'admin' | 'organizer' = 'admin'): Promise<string> {
    const id = randomUUID()
    const { error } = await this.serviceAdmin.from('app_users').insert({
      id,
      email: `bdd-fake-${label}-${id}@test.invalid`,
      full_name: `BDD Fake ${label}`,
      role,
      active: true,
    })
    if (error) throw new Error(`[BddWorld.createFakeActor] insert app_user (${label}): ${error.message}`)
    this.fakeActorIds.push(id)
    return id
  }

  async createPerson(overrides: Record<string, unknown> = {}): Promise<{ id: string; phone: string }> {
    const phone = this.nextPhone()
    const { data, error } = await this.serviceAdmin
      .from('people')
      .insert({
        phone_e164: phone,
        full_name: `BDD Person ${phone.slice(-4)}`,
        nickname: 'BDD',
        ...overrides,
      })
      .select('id')
      .single()
    if (error || !data) throw new Error(`[BddWorld.createPerson] insert: ${error?.message}`)
    const id = (data as { id: string }).id
    this.personIds.push(id)
    return { id, phone }
  }

  async createEventWithInstance(
    name: string,
    createdBy: string,
    scheduledAt: Date = new Date(Date.now() + 86_400_000),
  ): Promise<{ eventId: string; instanceId: string }> {
    const { data: ev, error: evErr } = await this.serviceAdmin
      .from('events')
      .insert({
        name,
        event_type: 'adhoc',
        start_date: scheduledAt.toISOString().slice(0, 10),
        start_time: '18:00:00',
        active: true,
        created_by: createdBy,
      })
      .select('id')
      .single()
    if (evErr || !ev) throw new Error(`[BddWorld.createEventWithInstance] insert event: ${evErr?.message}`)
    const eventId = (ev as { id: string }).id
    this.eventIds.push(eventId)

    const { data: inst, error: instErr } = await this.serviceAdmin
      .from('event_instances')
      .insert({
        event_id: eventId,
        scheduled_at: scheduledAt.toISOString(),
        event_name_snapshot: name,
        status: 'scheduled',
      })
      .select('id')
      .single()
    if (instErr || !inst) {
      throw new Error(`[BddWorld.createEventWithInstance] insert instance: ${instErr?.message}`)
    }
    const instanceId = (inst as { id: string }).id

    return { eventId, instanceId }
  }
}

setWorldConstructor(BddWorld)
