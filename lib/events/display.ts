// Pure display helpers for event instance names.
// No Supabase imports — fully unit-testable.

export type DisplayInstanceNameInput = {
  scheduledAt: Date
  snapshot: string          // event_name_snapshot (EN historical)
  snapshotId: string | null // event_name_snapshot_id (ID historical, nullable)
  liveName: string          // events.name (live EN)
  liveNameId: string | null // events.name_id (live ID, nullable)
  locale: 'en' | 'id'
  /** Injectable for tests — defaults to new Date(). */
  now?: Date
}

/**
 * Returns the display name for an event instance (T2-07 implementation).
 *
 * Past rule (scheduledAt < now): return snapshot (the historical name captured at
 * instance creation). ID locale falls back to EN snapshot when snapshotId is null.
 *
 * Future rule (scheduledAt >= now): return live event name.
 * ID locale falls back to EN live name when liveNameId is null.
 *
 * Boundary: scheduledAt === now is treated as FUTURE (strict less-than comparison).
 * This is intentional and tested in DIN-07.
 */
export function displayInstanceName(input: DisplayInstanceNameInput): string {
  const now = input.now ?? new Date()
  const isPast = input.scheduledAt < now

  if (isPast) {
    return input.locale === 'id'
      ? (input.snapshotId ?? input.snapshot)
      : input.snapshot
  }

  return input.locale === 'id'
    ? (input.liveNameId ?? input.liveName)
    : input.liveName
}
