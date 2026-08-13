// S6-T11: per-scenario teardown. Reverse-dependency order, same shape as the
// afterAll blocks across tests/integration/*.test.ts:
//   events (cascades event_instances -> attendance / event_invitations)
//   -> people -> audit_log (by actor) -> app_users -> auth.users
import { After } from '@cucumber/cucumber'
import type { BddWorld } from './world'

After(async function (this: BddWorld) {
  if (this.eventIds.length > 0) {
    await this.serviceAdmin.from('events').delete().in('id', this.eventIds)
  }

  if (this.personIds.length > 0) {
    await this.serviceAdmin
      .from('audit_log')
      .delete()
      .eq('entity_type', 'people')
      .in('entity_id', this.personIds)
    await this.serviceAdmin.from('people').delete().in('id', this.personIds)
  }

  const actorIds = [...this.sessionUserIds, ...this.fakeActorIds]
  if (actorIds.length > 0) {
    await this.serviceAdmin.from('audit_log').delete().in('actor_user_id', actorIds)
  }

  if (this.sessionUserIds.length > 0) {
    await this.serviceAdmin.from('app_users').delete().in('id', this.sessionUserIds)
    for (const id of this.sessionUserIds) {
      await this.serviceAdmin.auth.admin.deleteUser(id)
    }
  }

  if (this.fakeActorIds.length > 0) {
    await this.serviceAdmin.from('app_users').delete().in('id', this.fakeActorIds)
  }
})
