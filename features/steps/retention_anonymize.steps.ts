// Step-defs for features/retention_anonymize.feature. Drives the real
// impl_anonymizePerson (requireActiveAdmin-gated admin "anonymize now" path,
// same one tests/integration/retention-anonymize.test.ts exercises), backed
// by the anonymize_person() SQL primitive.
import { Given, When, Then } from '@cucumber/cucumber'
import { strict as assert } from 'node:assert'
import type { SupabaseClient } from '@supabase/supabase-js'
import { impl_anonymizePerson } from '../../lib/actions/people.impl'
import type { BddWorld } from '../support/world'

interface ScenarioState {
  adminSession: SupabaseClient
  personId: string
  attendanceId: string
}

function scenarioState(world: BddWorld): ScenarioState {
  return world.state as ScenarioState
}

Given('a member named {string} who checked in to an event', async function (this: BddWorld, name: string) {
  const admin = await this.createAppUser('retention-admin', 'admin')
  const { instanceId } = await this.createEventWithInstance('BDD Retention Event', admin.id)
  const { id: personId } = await this.createPerson({ full_name: name })

  const { data: attRow, error } = await this.serviceAdmin
    .from('attendance')
    .insert({ event_instance_id: instanceId, person_id: personId, checked_in_by: admin.id })
    .select('id')
    .single()
  if (error || !attRow) throw new Error(`fixture attendance insert: ${error?.message}`)

  this.state = {
    adminSession: admin.session,
    personId,
    attendanceId: (attRow as { id: string }).id,
  } satisfies ScenarioState
})

When("an admin anonymizes {string}'s record", async function (this: BddWorld, name: string) {
  const state = scenarioState(this)
  const result = await impl_anonymizePerson({
    supabase: state.adminSession,
    adminSupabase: this.serviceAdmin,
    input: { personId: state.personId },
  })
  assert.equal(result.status, 'anonymized', `anonymizing "${name}" failed: ${JSON.stringify(result)}`)
})

Then("{string}'s name and phone number are no longer stored", async function (this: BddWorld, name: string) {
  const state = scenarioState(this)
  const { data, error } = await this.serviceAdmin
    .from('people')
    .select('full_name, phone_e164')
    .eq('id', state.personId)
    .single()
  if (error || !data) throw new Error(`getPerson: ${error?.message}`)
  const person = data as { full_name: string; phone_e164: string }
  assert.equal(person.full_name, '[anonymized]', `expected "${name}"'s name to be scrubbed`)
  // scrubbed to the anon:<uuid> placeholder, not a real phone
  assert.doesNotMatch(person.phone_e164, /^\+62/, `expected "${name}"'s phone to be scrubbed`)
})

Then('their attendance at the event is still recorded', async function (this: BddWorld) {
  const state = scenarioState(this)
  const { data, error } = await this.serviceAdmin
    .from('attendance')
    .select('id, person_id')
    .eq('id', state.attendanceId)
    .single()
  if (error || !data) throw new Error(`attendance row missing after anonymize: ${error?.message}`)
  assert.equal((data as { person_id: string }).person_id, state.personId)
})

Then('it can no longer be traced back to their name', async function (this: BddWorld) {
  const state = scenarioState(this)
  const { data, error } = await this.serviceAdmin
    .from('people')
    .select('full_name')
    .eq('id', state.personId)
    .single()
  if (error || !data) throw new Error(`getPerson: ${error?.message}`)
  assert.equal((data as { full_name: string }).full_name, '[anonymized]')
})
