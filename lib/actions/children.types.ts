// Types for children lookup server actions — imported by children.impl.ts and
// children.ts.

// Fields returned by child lookups. Children have no phone — on check-in they
// are disambiguated by parent name and birth date instead.
export type ChildSummary = {
  id: string
  parent_person_id: string
  full_name: string
  birth_date: string | null      // ISO date (YYYY-MM-DD); Postgres `date` serialized as string
  gender: 'male' | 'female' | null
}

// Name-search result row: the parent's name is the disambiguator, playing the
// role the masked phone tail plays in the adult NameMatchList.
export type ChildWithParentSummary = ChildSummary & {
  parent_full_name: string
}

// ── listChildrenByParent ─────────────────────────────────────────

export type ListChildrenByParentResult =
  | { status: 'children'; children: ChildSummary[] }
  | { status: 'none' }
  | { status: 'invalid_input'; field: string; message: string }
  | { status: 'error'; message: string }

// ── lookupChildByName ────────────────────────────────────────────

// Mirrors LookupByNameResult (S7-T5): at most CHILD_NAME_MATCH_LIMIT (5) children
// are returned; hasMore signals a 6th row existed and the organizer should keep
// typing rather than scroll.
export type LookupChildByNameResult =
  | { status: 'matches'; children: ChildWithParentSummary[]; hasMore: boolean }
  | { status: 'none' }
  | { status: 'query_too_short' }
  | { status: 'error'; message: string }

// ── createChild ──────────────────────────────────────────────────

export type CreateChildInput = {
  parentPersonId: string
  full_name: string
  birth_date?: string | null     // ISO date (YYYY-MM-DD); absent/null = unknown
  gender?: 'male' | 'female' | null
  notes?: string | null
}

// 'duplicate_warning' means the child WAS created AND at least one non-deleted
// sibling with the same (case-insensitive) full_name already existed under this
// parent. Advisory only — the write is never blocked; the UI decides what to show.
export type CreateChildResult =
  | { status: 'created'; child: ChildSummary }
  | { status: 'duplicate_warning'; child: ChildSummary; existing: ChildSummary[] }
  | { status: 'parent_not_found' }
  | { status: 'validation_error'; field_errors: Record<string, string> }
  | { status: 'forbidden'; message: string }
  | { status: 'error'; message: string }

// ── updateChild ──────────────────────────────────────────────────

// Field-presence convention (mirrors UpdatePersonInput): present (even null) =
// write it; absent = don't touch. parent_person_id is not editable.
export type UpdateChildInput = Partial<{
  full_name:  string
  birth_date: string | null
  gender:     'male' | 'female' | null
  notes:      string | null
}>

export type UpdateChildResult =
  | { status: 'updated'; child: ChildSummary }
  | { status: 'not_found' }
  | { status: 'validation_error'; field_errors: Record<string, string> }
  | { status: 'forbidden'; message: string }
  | { status: 'error'; message: string }

// ── softDeleteChild ──────────────────────────────────────────────

// Admin-only by RLS (organizers have no policy that lets them set deleted_at);
// the impl does not role-gate and maps the RLS rejection to 'forbidden'.
export type SoftDeleteChildResult =
  | { status: 'soft_deleted'; id: string }
  | { status: 'not_found' }
  | { status: 'forbidden'; message: string }
  | { status: 'error'; message: string }
