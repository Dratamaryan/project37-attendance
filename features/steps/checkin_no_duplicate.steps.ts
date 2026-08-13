// Step-defs for features/checkin_no_duplicate.feature. Drives the real
// impl_createAttendance twice for the same person/instance — the duplicate
// path is the DB's unique constraint (uniq_attendance) surfacing as
// status: 'already_checked_in', same as tests/integration/attendance-actions.test.ts.
import { Given, When, Then } from '@cucumber/cucumber'
import { strict as assert } from 'node:assert'
import type { SupabaseClient } from '@supabase/supabase-js'
import { impl_createAttendance } from '../../lib/actions/attendance.impl'
import type { CreateAttendanceResult } from '../../lib/actions/attendance.types'
import type { BddWorld } from '../support/world'

interface ScenarioState {
  instanceId: string
  organizerSession: SupabaseClient
  personId: string
  lastResult: CreateAttendanceResult | null
}

function scenarioState(world: BddWorld): ScenarioState {
  return world.state as ScenarioState
}

Given('an event happening today', async function (this: BddWorld) {
  const creator = await this.createFakeActor('event-creator')
  const { instanceId } = await this.createEventWithInstance('BDD Check-in Event', creator, new Date())
  const organizer = await this.createAppUser('checkin-volunteer', 'organizer')

  this.state = {
    instanceId,
    organizerSession: organizer.session,
    personId: '',
    lastResult: null,
  } satisfies ScenarioState
})

Given('a member named {string}', async function (this: BddWorld, name: string) {
  const { id } = await this.createPerson({ full_name: name })
  scenarioState(this).personId = id
})

async function checkIn(world: BddWorld, name: string) {
  const state = scenarioState(world)
  state.lastResult = await impl_createAttendance({
    supabase: state.organizerSession,
    adminSupabase: world.serviceAdmin,
    input: { personId: state.personId, eventInstanceId: state.instanceId },
  })
  if (state.lastResult.status !== 'ok' && state.lastResult.status !== 'already_checked_in') {
    throw new Error(`check-in for "${name}" failed unexpectedly: ${JSON.stringify(state.lastResult)}`)
  }
}

When('a volunteer checks {string} in', async function (this: BddWorld, name: string) {
  await checkIn(this, name)
})

When('a volunteer checks {string} in a second time', async function (this: BddWorld, name: string) {
  await checkIn(this, name)
})

Then('{string} is marked as checked in', function (this: BddWorld, name: string) {
  assert.equal(scenarioState(this).lastResult?.status, 'ok', `expected "${name}" to be checked in`)
})

Then('the system recognizes {string} is already checked in', function (this: BddWorld, name: string) {
  assert.equal(
    scenarioState(this).lastResult?.status,
    'already_checked_in',
    `expected "${name}"'s second check-in to be recognized as a duplicate`,
  )
})

Then('only one attendance record exists for {string}', async function (this: BddWorld, name: string) {
  const state = scenarioState(this)
  const { count, error } = await this.serviceAdmin
    .from('attendance')
    .select('id', { count: 'exact', head: true })
    .eq('event_instance_id', state.instanceId)
    .eq('person_id', state.personId)
  if (error) throw new Error(`attendance count query: ${error.message}`)
  assert.equal(count, 1, `expected exactly one attendance record for "${name}"`)
})
