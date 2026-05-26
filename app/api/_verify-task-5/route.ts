// Verify route for Sprint 1 Task 5 — people server actions.
// Gated on VERIFY_ROUTES_ENABLED=true AND NODE_ENV !== 'production'.
// Delete or leave permanently gated — the env var is never set in prod.
//
// Usage:
//   VERIFY_ROUTES_ENABLED=true npm run dev
//   While logged in as admin, GET /api/_verify-task-5
//   Paste the JSON response into docs/sprint-1-task-5-verify.md

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { impl_createPerson, impl_setPhotoConsent, impl_softDeletePerson } from '@/lib/actions/people.impl'

const VERIFY_PHONE = '08123450999'  // local format; normalizes to +6281234509999 — test number only
const VERIFY_INPUT = {
  phone_e164_raw: VERIFY_PHONE,
  country:        'ID' as const,
  full_name:      '_VerifyTask5 Test Person',
  nickname:       '_VerifyTask5',
  birth_date:     '2000-01-01',
  notes:          'Created by _verify-task-5 route. Safe to delete.',
}

export async function GET() {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Not available in production' }, { status: 403 })
  }
  if (process.env.VERIFY_ROUTES_ENABLED !== 'true') {
    return NextResponse.json(
      { error: 'Set VERIFY_ROUTES_ENABLED=true in your env to enable this route' },
      { status: 403 },
    )
  }

  const supabase = await createClient()
  const { data: authData } = await supabase.auth.getUser()
  if (!authData.user) {
    return NextResponse.json({ error: 'Must be logged in as admin to run this verify' }, { status: 401 })
  }

  const actorId = authData.user.id

  // Clean up any leftover test person from a previous run
  const { data: leftover } = await supabase
    .from('people')
    .select('id')
    .eq('phone_e164', '+6281234509999')
    .single()

  if (leftover) {
    await impl_softDeletePerson(leftover.id, supabase)
  }

  // Step 1: createPerson
  const createResult = await impl_createPerson(VERIFY_INPUT, supabase)
  if (createResult.status !== 'created') {
    return NextResponse.json({ step: 'createPerson', result: createResult }, { status: 400 })
  }
  const personId = createResult.person.id

  // Step 2: setPhotoConsent (grant)
  const consentResult = await impl_setPhotoConsent(personId, true, supabase)

  // Step 3: read audit rows for this entity
  const { data: auditRows, error: auditError } = await supabase
    .from('audit_log')
    .select('id, actor_user_id, action, entity_type, entity_id, details_json, created_at')
    .eq('entity_id', personId)
    .order('created_at', { ascending: true })

  // Step 4: soft-delete the test person (cleanup)
  await impl_softDeletePerson(personId, supabase)

  return NextResponse.json({
    actor_user_id:  actorId,
    person:         createResult.person,
    consent_result: consentResult,
    audit_rows:     auditRows,
    audit_error:    auditError,
    assertions: {
      create_row_actor_matches:   auditRows?.[0]?.actor_user_id === actorId,
      create_action_correct:      auditRows?.[0]?.action === 'people.create',
      consent_action_correct:     auditRows?.[1]?.action === 'consent.grant',
      consent_row_actor_matches:  auditRows?.[1]?.actor_user_id === actorId,
    },
  })
}
