import { describe, it, expect, vi } from 'vitest'
import { logAudit, AUDIT_ACTIONS, type AuditAction } from '../audit'
import type { SupabaseClient } from '@supabase/supabase-js'

function makeClient(rpcResult: { data?: unknown; error: unknown }) {
  return { rpc: vi.fn().mockResolvedValue(rpcResult) } as unknown as SupabaseClient
}

describe('logAudit', () => {
  it('calls rpc with correct snake_case p_-prefixed params', async () => {
    const client = makeClient({ data: null, error: null })
    await logAudit(
      {
        actorUserId:  '00000000-0000-0000-0000-000000000001',
        action:       AUDIT_ACTIONS.PEOPLE_CREATE,
        entityType:   'people',
        entityId:     '00000000-0000-0000-0000-000000000002',
        detailsJson:  { source: 'import' },
        ipAddress:    '203.0.113.10',
        userAgent:    'Mozilla/5.0',
      },
      client,
    )

    expect(client.rpc).toHaveBeenCalledOnce()
    expect(client.rpc).toHaveBeenCalledWith('log_audit', {
      p_actor_user_id: '00000000-0000-0000-0000-000000000001',
      p_action:        'people.create',
      p_entity_type:   'people',
      p_entity_id:     '00000000-0000-0000-0000-000000000002',
      p_details_json:  { source: 'import' },
      p_ip_address:    '203.0.113.10',
      p_user_agent:    'Mozilla/5.0',
    })
  })

  it('passes null actor_user_id for cron callers', async () => {
    const client = makeClient({ data: null, error: null })
    await logAudit(
      { actorUserId: null, action: AUDIT_ACTIONS.CHECKIN_CREATE, entityType: 'checkin', entityId: '1' },
      client,
    )

    const call = (client.rpc as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(call[1].p_actor_user_id).toBeNull()
  })

  it('defaults optional params to null when omitted', async () => {
    const client = makeClient({ data: null, error: null })
    await logAudit(
      { actorUserId: 'abc', action: AUDIT_ACTIONS.SETTINGS_UPDATE, entityType: 'app_settings', entityId: '1' },
      client,
    )

    const call = (client.rpc as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(call[1].p_details_json).toBeNull()
    expect(call[1].p_ip_address).toBeNull()
    expect(call[1].p_user_agent).toBeNull()
  })

  it('throws when rpc returns an error', async () => {
    const client = makeClient({ data: null, error: { message: 'DB error', code: '42501' } })
    await expect(
      logAudit(
        { actorUserId: 'abc', action: AUDIT_ACTIONS.PEOPLE_UPDATE, entityType: 'people', entityId: '2' },
        client,
      ),
    ).rejects.toMatchObject({ message: 'DB error' })
  })

  it('resolves without throwing on success', async () => {
    const client = makeClient({ data: null, error: null })
    await expect(
      logAudit(
        { actorUserId: 'abc', action: AUDIT_ACTIONS.CONSENT_GRANT, entityType: 'people', entityId: '3' },
        client,
      ),
    ).resolves.toBeUndefined()
  })
})

describe('AuditAction type', () => {
  it('rejects arbitrary strings at compile time', () => {
    // @ts-expect-error — 'people.hack' is not a valid AuditAction
    const _bad: AuditAction = 'people.hack'
    void _bad
  })
})
