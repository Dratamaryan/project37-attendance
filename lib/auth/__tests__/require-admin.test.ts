import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requireActiveAdmin, requireActiveRole } from '../require-admin'

const ACTOR_ID = 'actor-uuid-0001'

function makeSupabase(opts: {
  claims: { sub: string } | null
  appUser: { role: string; active: boolean } | null
}) {
  return {
    auth: {
      getClaims: async () =>
        opts.claims ? { data: { claims: opts.claims } } : { data: null },
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: opts.appUser, error: opts.appUser ? null : { code: 'PGRST116' } }),
        }),
      }),
    }),
  } as unknown as SupabaseClient
}

describe('requireActiveAdmin', () => {
  it('returns unauthenticated when getClaims has no session', async () => {
    const supabase = makeSupabase({ claims: null, appUser: null })
    expect(await requireActiveAdmin(supabase)).toEqual({ status: 'unauthenticated' })
  })

  it('returns denied when the caller has no app_users row', async () => {
    const supabase = makeSupabase({ claims: { sub: ACTOR_ID }, appUser: null })
    expect(await requireActiveAdmin(supabase)).toEqual({ status: 'denied' })
  })

  it('returns denied when the caller is an active organizer', async () => {
    const supabase = makeSupabase({
      claims: { sub: ACTOR_ID },
      appUser: { role: 'organizer', active: true },
    })
    expect(await requireActiveAdmin(supabase)).toEqual({ status: 'denied' })
  })

  it('returns denied when the caller is an admin but active=false', async () => {
    const supabase = makeSupabase({
      claims: { sub: ACTOR_ID },
      appUser: { role: 'admin', active: false },
    })
    expect(await requireActiveAdmin(supabase)).toEqual({ status: 'denied' })
  })

  it('returns ok when the caller is an active admin', async () => {
    const supabase = makeSupabase({
      claims: { sub: ACTOR_ID },
      appUser: { role: 'admin', active: true },
    })
    expect(await requireActiveAdmin(supabase)).toEqual({
      status: 'ok',
      actorId: ACTOR_ID,
      role: 'admin',
    })
  })
})

describe('requireActiveRole', () => {
  it('allows any role in the list when active', async () => {
    const supabase = makeSupabase({
      claims: { sub: ACTOR_ID },
      appUser: { role: 'organizer', active: true },
    })
    expect(await requireActiveRole(supabase, ['admin', 'organizer'])).toEqual({
      status: 'ok',
      actorId: ACTOR_ID,
      role: 'organizer',
    })
  })

  it('denies a role not in the list', async () => {
    const supabase = makeSupabase({
      claims: { sub: ACTOR_ID },
      appUser: { role: 'organizer', active: true },
    })
    expect(await requireActiveRole(supabase, ['admin'])).toEqual({ status: 'denied' })
  })

  it('denies an inactive organizer even when organizer is in the list', async () => {
    const supabase = makeSupabase({
      claims: { sub: ACTOR_ID },
      appUser: { role: 'organizer', active: false },
    })
    expect(await requireActiveRole(supabase, ['admin', 'organizer'])).toEqual({ status: 'denied' })
  })

  it('returns unauthenticated when there is no session', async () => {
    const supabase = makeSupabase({ claims: null, appUser: null })
    expect(await requireActiveRole(supabase, ['admin', 'organizer'])).toEqual({
      status: 'unauthenticated',
    })
  })
})
