// Step-defs for features/roster_import_consent.feature. Builds a real .xlsx
// buffer (same shape as tests/integration/import-commit.test.ts's
// buildXlsxBuffer helper) and drives the real import pipeline via
// runImportCommit — parse, normalize, classify, insert are all exercised,
// not stubbed. Fixture phones: +62812000930{5,6,7}xx, well clear of the
// low auto-incrementing range features/support/world.ts hands out to other
// scenarios' createPerson() calls.
import { Given, When, Then, DataTable } from '@cucumber/cucumber'
import { strict as assert } from 'node:assert'
import * as XLSX from 'xlsx'
import { runImportCommit } from '../../lib/import/commit.impl'
import { COLUMN_MAPPINGS } from '../../lib/import/columns'
import type { BddWorld } from '../support/world'

const NAME_HEADER = COLUMN_MAPPINGS.find((m) => m.target === 'full_name')!.headerAliases[0]
const PHONE_HEADER = COLUMN_MAPPINGS.find((m) => m.target === 'phone_raw')!.headerAliases[0]
const CONSENT_HEADER = COLUMN_MAPPINGS.find((m) => m.target === 'photo_consent_raw')!.headerAliases[0]

interface RosterRow {
  Name: string
  'Phone number': string
  'Photo consent answer': string
}

interface ScenarioState {
  rows: RosterRow[]
  buffer: Buffer
}

function scenarioState(world: BddWorld): ScenarioState {
  return world.state as ScenarioState
}

function phoneE164(raw: string): string {
  // The Given table writes phones the way the real sign-up form does
  // (leading 0, no country code) — same shape normalizePhoneField expects.
  return `+62${raw.replace(/^0/, '')}`
}

Given('a roster spreadsheet listing:', function (this: BddWorld, table: DataTable) {
  const rows = table.hashes() as unknown as RosterRow[]

  const worksheet = XLSX.utils.aoa_to_sheet([
    [NAME_HEADER, PHONE_HEADER, CONSENT_HEADER],
    ...rows.map((r) => [r.Name, r['Phone number'], r['Photo consent answer'] || null]),
  ])
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1')
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer

  this.state = { rows, buffer } satisfies ScenarioState
})

When('the roster is imported', async function (this: BddWorld) {
  const { buffer } = scenarioState(this)
  const actorId = await this.createFakeActor('roster-importer')

  const outcome = await runImportCommit(
    { fileBuffer: buffer, filename: 'bdd-roster.xlsx', actorUserId: actorId, ipAddress: null, userAgent: null },
    this.serviceAdmin,
  )
  assert.equal(outcome.ok, true, `import failed: ${JSON.stringify(outcome)}`)
})

async function getImportedPerson(world: BddWorld, name: string) {
  const { rows } = scenarioState(world)
  const row = rows.find((r) => r.Name === name)
  if (!row) throw new Error(`No roster row named "${name}"`)

  const { data, error } = await world.serviceAdmin
    .from('people')
    .select('id, photo_consent_state, photo_publish_consent')
    .eq('phone_e164', phoneE164(row['Phone number']))
    .single()
  if (error || !data) throw new Error(`Imported person "${name}" not found: ${error?.message}`)

  const person = data as { id: string; photo_consent_state: string; photo_publish_consent: boolean }
  world.personIds.push(person.id)
  return person
}

Then('{string} is recorded as having agreed to photos', async function (this: BddWorld, name: string) {
  const person = await getImportedPerson(this, name)
  assert.equal(person.photo_consent_state, 'granted')
  assert.equal(person.photo_publish_consent, true)
})

Then('{string} is recorded as having declined photos', async function (this: BddWorld, name: string) {
  const person = await getImportedPerson(this, name)
  assert.equal(person.photo_consent_state, 'refused')
  assert.equal(person.photo_publish_consent, false)
})

Then('{string} is recorded as not yet asked', async function (this: BddWorld, name: string) {
  const person = await getImportedPerson(this, name)
  assert.equal(person.photo_consent_state, 'unknown')
  assert.equal(person.photo_publish_consent, false)
})
