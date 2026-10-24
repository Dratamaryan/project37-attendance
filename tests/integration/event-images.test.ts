// Integration tests for Sprint 9 P0 — event image upload to Supabase Storage
// against real local Docker (Postgres + Storage API). Real requireActiveAdmin()
// gating, real event-images bucket limits, real storage.objects RLS, real
// public-URL reads, real audit rows. Synthetic data only.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'crypto'
import {
  impl_uploadInstanceImage,
  impl_removeInstanceImage,
} from '@/lib/storage/event-images.impl'
import { impl_updateInstance } from '@/lib/actions/events.impl'
import type { UpdateInstanceInput } from '@/lib/actions/events.types'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !anonKey || !serviceRoleKey) {
  throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY')
}

const { hostname } = new URL(url)
if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
  throw new Error(
    `[event-images.test.ts] NEXT_PUBLIC_SUPABASE_URL (${hostname}) is not local Docker. This suite ` +
      `creates/deletes auth users and storage objects — must run against local Docker only.`,
  )
}

const BUCKET = 'event-images'

// Real 1×1 PNG.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)
const pngFile = () => new File([PNG_BYTES], 'synthetic.png', { type: 'image/png' })

let serviceAdmin: SupabaseClient
let anon: SupabaseClient
const ts = Date.now()
const authUserIds: Set<string> = new Set()
const eventIds: Set<string> = new Set()
const instanceIds: Set<string> = new Set()

async function createAppUserFixture(
  label: string,
  role: 'admin' | 'organizer',
): Promise<{ id: string; session: SupabaseClient }> {
  const email = `s9-p0-${label}-${randomUUID()}@example.com`
  const pass = `S9P0Pass-${label}-${ts}!`
  const { data: authData, error: authErr } = await serviceAdmin.auth.admin.createUser({
    email,
    password: pass,
    email_confirm: true,
  })
  if (authErr || !authData.user) throw new Error(`createUser (${label}): ${authErr?.message}`)
  authUserIds.add(authData.user.id)

  const { error: appErr } = await serviceAdmin
    .from('app_users')
    .insert({ id: authData.user.id, email, full_name: `[SYNTH] S9 P0 Test ${label}`, role, active: true })
  if (appErr) throw new Error(`insert app_user (${label}): ${appErr.message}`)

  const session = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { error: signInErr } = await session.auth.signInWithPassword({ email, password: pass })
  if (signInErr) throw new Error(`sign-in (${label}): ${signInErr.message}`)
  return { id: authData.user.id, session }
}

async function createInstanceFixture(imageUrl: string | null = null): Promise<string> {
  const name = `[SYNTH] S9 P0 Image Test ${randomUUID()}`
  const scheduledAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()
  const { data: ev, error: evErr } = await serviceAdmin
    .from('events')
    .insert({
      name,
      event_type: 'adhoc',
      start_date: scheduledAt.slice(0, 10),
      start_time: '18:00:00',
      duration_min: 90,
      active: true,
      created_by: adminId,
    })
    .select('id')
    .single()
  if (evErr || !ev) throw new Error(`insert event: ${evErr?.message}`)
  eventIds.add(ev.id)

  const { data: inst, error: instErr } = await serviceAdmin
    .from('event_instances')
    .insert({
      event_id: ev.id,
      scheduled_at: scheduledAt,
      event_name_snapshot: name,
      status: 'scheduled',
      image_url: imageUrl,
    })
    .select('id')
    .single()
  if (instErr || !inst) throw new Error(`insert instance: ${instErr?.message}`)
  instanceIds.add(inst.id)
  return inst.id
}

async function imageUrlOf(instanceId: string): Promise<string | null> {
  const { data } = await serviceAdmin.from('event_instances').select('image_url').eq('id', instanceId).single()
  return (data as { image_url: string | null } | null)?.image_url ?? null
}

async function objectNames(instanceId: string): Promise<string[]> {
  const { data, error } = await serviceAdmin.storage.from(BUCKET).list(`instances/${instanceId}`)
  if (error) throw new Error(`storage.list: ${error.message}`)
  return (data ?? []).map(o => `instances/${instanceId}/${o.name}`)
}

async function auditRows(instanceId: string, action: string) {
  const { data } = await serviceAdmin
    .from('audit_log')
    .select('actor_user_id, details_json')
    .eq('entity_type', 'event_instance')
    .eq('entity_id', instanceId)
    .eq('action', action)
  return data ?? []
}

let adminId: string
let adminSession: SupabaseClient
let organizerSession: SupabaseClient

beforeAll(async () => {
  serviceAdmin = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })
  anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })

  const admin = await createAppUserFixture('admin', 'admin')
  adminId = admin.id
  adminSession = admin.session

  const organizer = await createAppUserFixture('organizer', 'organizer')
  organizerSession = organizer.session
}, 30_000)

afterAll(async () => {
  for (const id of instanceIds) {
    const names = await objectNames(id)
    if (names.length > 0) await serviceAdmin.storage.from(BUCKET).remove(names)
    await serviceAdmin.from('audit_log').delete().eq('entity_type', 'event_instance').eq('entity_id', id)
  }
  // events → event_instances (CASCADE)
  if (eventIds.size > 0) await serviceAdmin.from('events').delete().in('id', Array.from(eventIds))

  const userIds = Array.from(authUserIds)
  if (userIds.length === 0) return
  await serviceAdmin.from('audit_log').delete().in('actor_user_id', userIds)
  await serviceAdmin.from('app_users').delete().in('id', userIds)
  for (const id of userIds) {
    await serviceAdmin.auth.admin.deleteUser(id)
  }
}, 60_000)

// ── bucket shape ─────────────────────────────────────────────────────────────

describe('event-images bucket', () => {
  it('exists, is public, 4 MB limit, jpeg/png/webp only', async () => {
    const { data, error } = await serviceAdmin.storage.getBucket(BUCKET)
    expect(error).toBeNull()
    expect(data?.public).toBe(true)
    expect(data?.file_size_limit).toBe(4194304)
    expect(data?.allowed_mime_types).toEqual(['image/jpeg', 'image/png', 'image/webp'])
  })
})

// ── admin upload ─────────────────────────────────────────────────────────────

describe('uploadInstanceImage — admin', () => {
  it('object exists, image_url = public URL, anon GET 200 image/png, audit row written', async () => {
    const instanceId = await createInstanceFixture()

    const result = await impl_uploadInstanceImage({ instanceId, file: pngFile() }, adminSession)
    expect(result.status).toBe('uploaded')
    if (result.status !== 'uploaded') return

    expect(result.path).toMatch(new RegExp(`^instances/${instanceId}/[0-9a-f-]{36}\\.png$`))
    expect(result.url).toBe(`${url}/storage/v1/object/public/${BUCKET}/${result.path}`)

    expect(await objectNames(instanceId)).toEqual([result.path])
    expect(await imageUrlOf(instanceId)).toBe(result.url)

    const res = await fetch(result.url)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toContain('max-age=31536000')
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG_BYTES)).toBe(true)

    const rows = await auditRows(instanceId, 'event_image.upload')
    expect(rows).toHaveLength(1)
    expect(rows[0].actor_user_id).toBe(adminId)
    expect(rows[0].details_json).toEqual({
      instance_id: instanceId,
      path: result.path,
      size: PNG_BYTES.length,
      mime: 'image/png',
    })
  })

  it('replace keeps the old object; image_url points at the new one', async () => {
    const instanceId = await createInstanceFixture()

    const first = await impl_uploadInstanceImage({ instanceId, file: pngFile() }, adminSession)
    const second = await impl_uploadInstanceImage({ instanceId, file: pngFile() }, adminSession)
    expect(first.status).toBe('uploaded')
    expect(second.status).toBe('uploaded')
    if (first.status !== 'uploaded' || second.status !== 'uploaded') return

    expect(first.path).not.toBe(second.path)
    expect((await objectNames(instanceId)).sort()).toEqual([first.path, second.path].sort())
    expect(await imageUrlOf(instanceId)).toBe(second.url)
    expect((await fetch(first.url)).status).toBe(200)
    expect(await auditRows(instanceId, 'event_image.upload')).toHaveLength(2)
  })

  it('declared PNG with non-PNG bytes → invalid_type; nothing stored, image_url unchanged', async () => {
    const instanceId = await createInstanceFixture()
    const fake = new File([new TextEncoder().encode('<html>not an image</html>')], 'x.png', { type: 'image/png' })

    const result = await impl_uploadInstanceImage({ instanceId, file: fake }, adminSession)
    expect(result.status).toBe('invalid_type')
    expect(await objectNames(instanceId)).toEqual([])
    expect(await imageUrlOf(instanceId)).toBeNull()
    expect(await auditRows(instanceId, 'event_image.upload')).toHaveLength(0)
  })

  it('unknown instance id → not_found; no object stored', async () => {
    const missing = randomUUID()
    const result = await impl_uploadInstanceImage({ instanceId: missing, file: pngFile() }, adminSession)
    expect(result.status).toBe('not_found')
    expect(await objectNames(missing)).toEqual([])
  })
})

// ── non-admin denial ─────────────────────────────────────────────────────────

describe('non-admin upload denied', () => {
  it('organizer via action → not_authorized; nothing stored, image_url unchanged', async () => {
    const instanceId = await createInstanceFixture()
    const result = await impl_uploadInstanceImage({ instanceId, file: pngFile() }, organizerSession)
    expect(result.status).toBe('not_authorized')
    expect(await objectNames(instanceId)).toEqual([])
    expect(await imageUrlOf(instanceId)).toBeNull()
  })

  it('organizer direct storage INSERT into event-images → denied by RLS', async () => {
    const instanceId = await createInstanceFixture()
    const { error } = await organizerSession.storage
      .from(BUCKET)
      .upload(`instances/${instanceId}/${randomUUID()}.png`, pngFile(), { contentType: 'image/png' })
    expect(error).not.toBeNull()
    expect(await objectNames(instanceId)).toEqual([])
  })

  it('anon direct storage INSERT into event-images → denied', async () => {
    const instanceId = await createInstanceFixture()
    const { error } = await anon.storage
      .from(BUCKET)
      .upload(`instances/${instanceId}/${randomUUID()}.png`, pngFile(), { contentType: 'image/png' })
    expect(error).not.toBeNull()
    expect(await objectNames(instanceId)).toEqual([])
  })

  it('anon list of event-images returns no object names (public bucket not enumerable)', async () => {
    const instanceId = await createInstanceFixture()
    const up = await impl_uploadInstanceImage({ instanceId, file: pngFile() }, adminSession)
    expect(up.status).toBe('uploaded')
    // Precondition: the object really exists (service role can see it).
    expect(await objectNames(instanceId)).toHaveLength(1)

    // No SELECT policy on storage.objects for event-images → RLS filters every
    // row for anon. Either an error or an empty listing is acceptable.
    const { data: top, error: topErr } = await anon.storage.from(BUCKET).list('instances')
    expect(topErr !== null || (top ?? []).length === 0).toBe(true)
    const { data: leaf, error: leafErr } = await anon.storage.from(BUCKET).list(`instances/${instanceId}`)
    expect(leafErr !== null || (leaf ?? []).length === 0).toBe(true)
  })

  it('bucket rejects text/html even from an admin session (allowed_mime_types)', async () => {
    const instanceId = await createInstanceFixture()
    const html = new Blob(['<html><script>alert(1)</script></html>'], { type: 'text/html' })
    const { error } = await adminSession.storage
      .from(BUCKET)
      .upload(`instances/${instanceId}/${randomUUID()}.html`, html, { contentType: 'text/html' })
    expect(error).not.toBeNull()
    expect(await objectNames(instanceId)).toEqual([])
  })
})

// ── remove ───────────────────────────────────────────────────────────────────

describe('removeInstanceImage', () => {
  it('admin: image_url → NULL, object still present, audit previous_was_storage = true', async () => {
    const instanceId = await createInstanceFixture()
    const up = await impl_uploadInstanceImage({ instanceId, file: pngFile() }, adminSession)
    expect(up.status).toBe('uploaded')
    if (up.status !== 'uploaded') return

    const result = await impl_removeInstanceImage({ instanceId }, adminSession)
    expect(result.status).toBe('removed')
    expect(await imageUrlOf(instanceId)).toBeNull()
    expect(await objectNames(instanceId)).toEqual([up.path])
    expect((await fetch(up.url)).status).toBe(200)

    const rows = await auditRows(instanceId, 'event_image.remove')
    expect(rows).toHaveLength(1)
    expect(rows[0].actor_user_id).toBe(adminId)
    expect(rows[0].details_json).toEqual({ instance_id: instanceId, previous_was_storage: true })
  })

  it('admin: legacy pasted URL cleared → previous_was_storage = false', async () => {
    const instanceId = await createInstanceFixture('https://example.invalid/legacy.jpg')
    const result = await impl_removeInstanceImage({ instanceId }, adminSession)
    expect(result.status).toBe('removed')
    expect(await imageUrlOf(instanceId)).toBeNull()

    const rows = await auditRows(instanceId, 'event_image.remove')
    expect(rows).toHaveLength(1)
    expect(rows[0].details_json).toEqual({ instance_id: instanceId, previous_was_storage: false })
  })

  it('admin: no image set → no_image, no audit row', async () => {
    const instanceId = await createInstanceFixture()
    const result = await impl_removeInstanceImage({ instanceId }, adminSession)
    expect(result.status).toBe('no_image')
    expect(await auditRows(instanceId, 'event_image.remove')).toHaveLength(0)
  })

  it('organizer → not_authorized; image_url unchanged', async () => {
    const legacy = 'https://example.invalid/keep.jpg'
    const instanceId = await createInstanceFixture(legacy)
    const result = await impl_removeInstanceImage({ instanceId }, organizerSession)
    expect(result.status).toBe('not_authorized')
    expect(await imageUrlOf(instanceId)).toBe(legacy)
  })
})

// ── updateInstance no longer owns image_url ──────────────────────────────────

describe('updateInstance no longer accepts image_url', () => {
  it('admin passing image_url → invalid_input; image_url unchanged; no event_instance.update audit', async () => {
    const legacy = 'https://example.invalid/existing.jpg'
    const instanceId = await createInstanceFixture(legacy)

    const result = await impl_updateInstance({
      supabase: adminSession,
      adminSupabase: serviceAdmin,
      instanceId,
      // Cast: the type no longer has image_url — simulates a stale/hostile caller.
      input: { image_url: 'https://cdn.example.com/should-not-apply.jpg' } as unknown as UpdateInstanceInput,
    })
    expect(result.status).toBe('invalid_input')
    if (result.status !== 'invalid_input') return
    expect(result.field).toBe('image_url')

    expect(await imageUrlOf(instanceId)).toBe(legacy)
    expect(await auditRows(instanceId, 'event_instance.update')).toHaveLength(0)
  })

  it('admin passing {} → invalid_input (no updatable fields); no audit', async () => {
    const instanceId = await createInstanceFixture()
    const result = await impl_updateInstance({
      supabase: adminSession,
      adminSupabase: serviceAdmin,
      instanceId,
      input: {},
    })
    expect(result.status).toBe('invalid_input')
    expect(await auditRows(instanceId, 'event_instance.update')).toHaveLength(0)
  })
})
