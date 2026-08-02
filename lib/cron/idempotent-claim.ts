import type { SupabaseClient } from '@supabase/supabase-js'

// Shared by every daily cron that must send-at-most-once per (source, ict_date):
// birthday-digest and attendance-summary (Sprint 5 T5). Concurrency-critical — kept
// in one place instead of duplicated per cron so a fix here fixes both.
//
// Claim-first idempotency against system_health(source, ict_date), enforced by the
// T3 partial unique index idx_system_health_source_ict_date. The INSERT race itself
// is arbitrated atomically by Postgres at commit time — that's what "claim-first"
// buys over the old read-then-write check (which only closed the sequential re-fire
// case, not a concurrent double-invoke).
//
// Outcome state machine (system_health.status, reusing the existing vocabulary —
// no new enum value beyond 'pending'):
//   - INSERT succeeds                                → claimed, proceed to send.
//   - INSERT conflicts (23505), existing status='ok' → already_done — a finished
//     job never replays, regardless of age.
//   - existing status='pending', fresh (age < staleMs)  → concurrent — another
//     invocation owns this; skip without sending.
//   - existing status='degraded' (prior send failed)     → reclaim immediately,
//     no staleness gate — it's already a known-terminal failure, not "maybe still
//     running".
//   - existing status='pending', stale (age >= staleMs)  → reclaim — a crash left
//     this mid-flight with no terminal write; treat as abandoned and retry.
//   - reclaim UPDATE uses an optimistic lock (WHERE status=<just-read> AND
//     checked_at=<just-read>) so two invocations racing the same reclaim can't both
//     win — the loser's WHERE no longer matches after the winner's UPDATE, and it
//     folds into `concurrent`.
//
// Accepted residual (see docs/sprint-5-task-5-verify.md): if sendMessage succeeds
// but the *following* resolveCronClaim write itself fails or the process crashes
// before it lands, the row is left 'pending' and a later retry past staleMs will
// reclaim and re-send — a real duplicate. Not closed by this design: doing so would
// need a pre-send/post-send two-phase marker this table doesn't have. Accepted per
// the explicit priority a missed digest is worse than a duplicate; the window
// requires two independent failures (send succeeds AND the tiny follow-up UPDATE
// fails) plus a later retry, so it's rare in practice.
//
// Reattempt only applies within the same ict_date. If a claim is never retried
// before the ICT day rolls over, the next scheduled cron computes a different
// ict_date (a different claim key) and that day's digest is permanently missed —
// unchanged from before this task. No cross-day retry infrastructure exists or is
// added here.

/** 600s — 2x the Hobby-plan effective function ceiling (300s, confirmed live via
 * Vercel docs: Hobby default AND maximum duration are both 300s with fluid compute;
 * neither cron route exports maxDuration, so the platform default applies). Must
 * exceed the longest a live invocation can actually run, or a still-running claim
 * could be falsely reclaimed and double-sent. */
export const DEFAULT_STALE_MS = 10 * 60 * 1000

export type ClaimOutcome =
  | { outcome: 'claimed'; claimId: number }
  | { outcome: 'already_done' }
  | { outcome: 'concurrent' }

export type ClaimCronSlotInput = {
  supabase: SupabaseClient
  source: string
  ictDate: string
  now: Date
  staleMs?: number
}

type ClaimRow = { id: number; status: string; checked_at: string }

export async function claimCronSlot({
  supabase,
  source,
  ictDate,
  now,
  staleMs = DEFAULT_STALE_MS,
}: ClaimCronSlotInput): Promise<ClaimOutcome> {
  const nowIso = now.toISOString()

  const { data: inserted, error: insertErr } = await supabase
    .from('system_health')
    .insert({ source, ict_date: ictDate, status: 'pending', checked_at: nowIso })
    .select('id')
    .single()

  if (!insertErr) {
    return { outcome: 'claimed', claimId: (inserted as { id: number }).id }
  }

  if (insertErr.code !== '23505') {
    throw new Error(`Failed to claim system_health slot: ${insertErr.message}`)
  }

  const { data: existing, error: readErr } = await supabase
    .from('system_health')
    .select('id, status, checked_at')
    .eq('source', source)
    .eq('ict_date', ictDate)
    .single()

  if (readErr || !existing) {
    throw new Error(`Failed to read conflicting claim row: ${readErr?.message ?? 'not found'}`)
  }

  const row = existing as ClaimRow

  if (row.status === 'ok') {
    return { outcome: 'already_done' }
  }

  const ageMs = now.getTime() - new Date(row.checked_at).getTime()
  if (row.status === 'pending' && ageMs < staleMs) {
    return { outcome: 'concurrent' }
  }

  // status === 'degraded', or status === 'pending' and stale — reclaim.
  const { data: reclaimed, error: reclaimErr } = await supabase
    .from('system_health')
    .update({ status: 'pending', checked_at: nowIso })
    .eq('id', row.id)
    .eq('status', row.status)
    .eq('checked_at', row.checked_at)
    .select('id')

  if (reclaimErr) {
    throw new Error(`Failed to reclaim system_health slot: ${reclaimErr.message}`)
  }

  if (!reclaimed || reclaimed.length === 0) {
    // Someone else reclaimed or resolved it between our read and this update.
    return { outcome: 'concurrent' }
  }

  return { outcome: 'claimed', claimId: row.id }
}

export type ResolveCronClaimInput = {
  supabase: SupabaseClient
  claimId: number
  status: 'ok' | 'degraded'
  now: Date
  payload: Record<string, unknown>
  notes?: string
}

/** Non-fatal on write failure (logs + returns) — the outcome returned to the caller
 * is already decided by the send result, not by whether this bookkeeping write
 * lands. A failed write here leaves the row 'pending', which the staleness
 * mechanism will recover on a later retry (see the accepted-residual note above). */
export async function resolveCronClaim({
  supabase,
  claimId,
  status,
  now,
  payload,
  notes,
}: ResolveCronClaimInput): Promise<void> {
  const updatePayload: Record<string, unknown> = {
    status,
    checked_at: now.toISOString(),
    table_row_counts: payload,
  }
  if (notes !== undefined) {
    updatePayload.notes = notes
  }

  const { error } = await supabase.from('system_health').update(updatePayload).eq('id', claimId)

  if (error) {
    console.warn('[idempotent-claim] resolve write failed:', error.message)
  }
}
