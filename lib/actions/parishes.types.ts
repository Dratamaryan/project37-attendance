export type ParishSearchResult = {
  id: string
  name: string
  city: string | null
  region: string | null
  status: 'approved' | 'pending'
}

export type SearchParishOptions = {
  /** When true (default), pending parishes are included in results.
   *  Organizers see their own pending submissions to avoid re-submitting duplicates. */
  includePending?: boolean
}

export type SearchResult =
  | { status: 'success'; parishes: ParishSearchResult[] }
  | { status: 'error';   message: string }

export type CreateParishInput = {
  name: string
  city?: string | null
  region?: string | null
}

export type CreateParishResult =
  | { status: 'created';          parish: ParishSearchResult }
  | { status: 'duplicate';        existing: { id: string; name: string; status: 'approved' | 'pending' } }
  | { status: 'validation_error'; field_errors: Record<string, string> }
  | { status: 'error';            message: string }

export type ListPendingParishesResult =
  | { status: 'ok';            parishes: ParishSearchResult[] }
  | { status: 'not_authorized' }
  | { status: 'error';         message: string }

export type ApproveParishResult =
  | { status: 'approved';      parish: ParishSearchResult }
  | { status: 'not_found' }
  | { status: 'not_pending';   currentStatus: 'approved' | 'pending' }
  | { status: 'not_authorized' }
  | { status: 'error';         message: string }
