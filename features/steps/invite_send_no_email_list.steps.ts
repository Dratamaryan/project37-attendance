// Step-defs for features/invite_send_no_email_list.feature. Drives the real
// impl_sendInvites with a stubbed EmailTransport (no real SMTP send — same
// stub shape as tests/integration/invites-send.test.ts). Recipients are
// scoped to this scenario via a unique `tribe` tag passed as the resolve
// filter — impl_sendInvites resolves candidates from the whole `people`
// table, so an unscoped filter would also pick up unrelated rows already
// sitting in the local Docker DB.
import { Given, When, Then } from '@cucumber/cucumber'
import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { impl_sendInvites } from '../../lib/actions/invites.impl'
import type { SendInvitesResult } from '../../lib/actions/invites.types'
import type { EmailTransport, EmailMessage, SendEmailResult } from '../../lib/email/transport'
import type { BddWorld } from '../support/world'

interface ScenarioState {
  tribe: string
  instanceId: string
  adminSession: SupabaseClient
  peopleByName: Map<string, { id: string; email: string | null }>
  sendResult: SendInvitesResult | null
}

function scenarioState(world: BddWorld): ScenarioState {
  return world.state as ScenarioState
}

async function ensureState(world: BddWorld): Promise<ScenarioState> {
  if ((world.state as Partial<ScenarioState>).tribe) return scenarioState(world)

  const admin = await world.createAppUser('invites-admin', 'admin')
  const { instanceId } = await world.createEventWithInstance('BDD Invite Event', admin.id)

  const state: ScenarioState = {
    tribe: `bdd-invite-${randomUUID()}`,
    instanceId,
    adminSession: admin.session,
    peopleByName: new Map(),
    sendResult: null,
  }
  world.state = state
  return state
}

function stubTransport(): EmailTransport {
  return {
    async send(msg: EmailMessage): Promise<SendEmailResult> {
      return { ok: true, messageId: `bdd-stub-${msg.to}`, response: '250 OK (stub, no real send)' }
    },
  }
}

Given(
  '{string} and {string} are invited to an event, both with an email on file',
  async function (this: BddWorld, nameA: string, nameB: string) {
    const state = await ensureState(this)
    for (const name of [nameA, nameB]) {
      const email = `bdd-${name.toLowerCase().replace(/\s+/g, '-')}-${state.tribe}@test.invalid`
      const { id } = await this.createPerson({ full_name: name, email, tribe: state.tribe })
      state.peopleByName.set(name, { id, email })
    }
  },
)

Given(
  '{string} is invited to the same event, with no email on file',
  async function (this: BddWorld, name: string) {
    const state = await ensureState(this)
    const { id } = await this.createPerson({ full_name: name, email: null, tribe: state.tribe })
    state.peopleByName.set(name, { id, email: null })
  },
)

When('invitations are sent', async function (this: BddWorld) {
  const state = await ensureState(this)
  state.sendResult = await impl_sendInvites({
    supabase: state.adminSession,
    transport: stubTransport(),
    eventInstanceId: state.instanceId,
    filter: { tribe: state.tribe },
    emailIdentity: { organizerEmail: 'bdd@test.invalid', fromName: 'BDD Pilot', replyTo: 'bdd-reply@test.invalid' },
    sendIntervalMs: 0,
    sleep: async () => {},
  })
})

Then('{string} and {string} are each sent an invitation', async function (this: BddWorld, nameA: string, nameB: string) {
  const { sendResult, instanceId, peopleByName } = scenarioState(this)
  assert.equal(sendResult?.status, 'ok')
  if (sendResult?.status !== 'ok') return

  for (const name of [nameA, nameB]) {
    const person = peopleByName.get(name)
    if (!person) throw new Error(`Unknown person "${name}"`)
    const { data, error } = await this.serviceAdmin
      .from('event_invitations')
      .select('status')
      .eq('event_instance_id', instanceId)
      .eq('person_id', person.id)
      .single()
    if (error || !data) throw new Error(`No invitation row for "${name}": ${error?.message}`)
    assert.equal((data as { status: string }).status, 'sent')
  }
})

Then('{string} appears on the manual follow-up list instead', function (this: BddWorld, name: string) {
  const { sendResult, peopleByName } = scenarioState(this)
  const person = peopleByName.get(name)
  assert.equal(sendResult?.status, 'ok')
  if (sendResult?.status !== 'ok' || !person) return
  const onList = sendResult.noEmail.some((r) => r.personId === person.id)
  assert.ok(onList, `"${name}" was expected on the no-email follow-up list`)
})

Then(
  'the manual follow-up list does not include {string} or {string}',
  function (this: BddWorld, nameA: string, nameB: string) {
    const { sendResult, peopleByName } = scenarioState(this)
    assert.equal(sendResult?.status, 'ok')
    if (sendResult?.status !== 'ok') return
    for (const name of [nameA, nameB]) {
      const person = peopleByName.get(name)
      if (!person) throw new Error(`Unknown person "${name}"`)
      const onList = sendResult.noEmail.some((r) => r.personId === person.id)
      assert.ok(!onList, `"${name}" should not be on the no-email follow-up list`)
    }
  },
)
