// Step-defs for features/photo_consent_gates_publication.feature. Drives the
// real roster-export read path (impl_getRosterRows + mapRosterRowToExportRow
// — the same functions the people-roster Excel export route uses). That
// query has no scenario-scoping filter (it reads the whole `people` table),
// so assertions match on this scenario's own fixture rows by phone number
// rather than assuming the returned list contains only what this scenario
// created.
import { Given, When, Then } from '@cucumber/cucumber'
import { strict as assert } from 'node:assert'
import type { SupabaseClient } from '@supabase/supabase-js'
import { impl_getRosterRows, mapRosterRowToExportRow } from '../../lib/actions/people-export.impl'
import type { PeopleRosterExportRow } from '../../lib/actions/people-export.types'
import type { BddWorld } from '../support/world'

interface ScenarioState {
  adminSession: SupabaseClient | null
  phoneByName: Map<string, string>
  exportRowsByPhone: Map<string, PeopleRosterExportRow>
}

function scenarioState(world: BddWorld): ScenarioState {
  if (!(world.state as Partial<ScenarioState>).phoneByName) {
    world.state = {
      adminSession: null,
      phoneByName: new Map(),
      exportRowsByPhone: new Map(),
    } satisfies ScenarioState
  }
  return world.state as ScenarioState
}

Given('{string} agreed to have their photo published', async function (this: BddWorld, name: string) {
  const state = scenarioState(this)
  const { phone } = await this.createPerson({
    full_name: name,
    photo_consent_state: 'granted',
    photo_publish_consent: true,
  })
  state.phoneByName.set(name, phone)
})

Given('{string} declined to have their photo published', async function (this: BddWorld, name: string) {
  const state = scenarioState(this)
  const { phone } = await this.createPerson({
    full_name: name,
    photo_consent_state: 'refused',
    photo_publish_consent: false,
  })
  state.phoneByName.set(name, phone)
})

Given('{string} has never been asked', async function (this: BddWorld, name: string) {
  const state = scenarioState(this)
  // DB defaults already are photo_consent_state='unknown' / photo_publish_consent=false —
  // no override needed, this row is exactly what "never asked" looks like on import.
  const { phone } = await this.createPerson({ full_name: name })
  state.phoneByName.set(name, phone)
})

When('the roster export is generated', async function (this: BddWorld) {
  const state = scenarioState(this)
  const admin = await this.createAppUser('roster-export-admin', 'admin')
  state.adminSession = admin.session

  const result = await impl_getRosterRows({ supabase: admin.session })
  assert.equal(result.status, 'ok', `getRosterRows failed: ${JSON.stringify(result)}`)
  if (result.status !== 'ok') return

  for (const row of result.data) {
    const exportRow = mapRosterRowToExportRow(row)
    state.exportRowsByPhone.set(row.phone_e164, exportRow)
  }
})

function publishFlag(world: BddWorld, name: string): string {
  const state = scenarioState(world)
  const phone = state.phoneByName.get(name)
  if (!phone) throw new Error(`Unknown person "${name}"`)
  const row = state.exportRowsByPhone.get(phone)
  if (!row) throw new Error(`"${name}" did not appear in the roster export`)
  return row['Can publish']
}

Then('{string} is marked publishable', function (this: BddWorld, name: string) {
  assert.equal(publishFlag(this, name), 'Yes')
})

Then('{string} is marked not publishable', function (this: BddWorld, name: string) {
  assert.equal(publishFlag(this, name), 'No')
})
