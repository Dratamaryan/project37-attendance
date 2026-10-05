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
