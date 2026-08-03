'use client'

import { useState, useEffect, useRef, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { listAuditLog } from '@/lib/actions/audit-log'
import { AUDIT_ACTIONS, type AuditAction } from '@/lib/audit'
import type { AuditLogCursor, AuditLogFilters, AuditLogListItem } from '@/lib/actions/audit-log.types'
import type { AppUserSummary } from '@/lib/actions/admin-users.types'

const ACTION_VALUE_TO_KEY: Record<string, keyof typeof AUDIT_ACTIONS> = Object.fromEntries(
  Object.entries(AUDIT_ACTIONS).map(([key, value]) => [value, key as keyof typeof AUDIT_ACTIONS]),
)

function toDateInputValue(d: Date): string {
  return d.toISOString().slice(0, 10)
}

// Bounded default window: audit_log has no standalone created_at index (only
// composite indexes led by actor/action), so an unfiltered "all rows, newest
// first" view is a seq-scan+sort over the whole table. The table also has no
// retention/archival job — it only grows. Defaulting to a recent window keeps
// the common case (opening the page with no filters set) off that path,
// regardless of how large the table gets over time. Visible and adjustable,
// not hidden magic — the note below the filters explains it.
function defaultDateRange(): { from: string; to: string } {
  const to = new Date()
  const from = new Date()
  from.setDate(from.getDate() - 30)
  return { from: toDateInputValue(from), to: toDateInputValue(to) }
}

type Filters = {
  actorUserId: string   // '' = all
  action: string         // '' = all
  entityType: string
  from: string
  to: string
}

type State =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ok'; rows: AuditLogListItem[]; total: number; nextCursor: AuditLogCursor | null }
  | { phase: 'error' }

function toApiFilters(f: Filters): AuditLogFilters {
  return {
    actorUserId: f.actorUserId || undefined,
    action: (f.action || undefined) as AuditAction | undefined,
    entityType: f.entityType.trim() || undefined,
    from: f.from || undefined,
    to: f.to || undefined,
  }
}

function renderDetailValue(value: unknown): string {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj)
    if (keys.length === 2 && keys.includes('from') && keys.includes('to')) {
      return `${String(obj.from)} → ${String(obj.to)}`
    }
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return JSON.stringify(value)
  return String(value)
}

function DetailsCell({ detailsJson }: { detailsJson: Record<string, unknown> | null }) {
  const t = useTranslations('admin.audit_log')
  const [expanded, setExpanded] = useState(false)
  const entries = detailsJson ? Object.entries(detailsJson) : []

  if (entries.length === 0) {
    return <span className="text-muted">{t('details.none')}</span>
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className="text-xs font-medium text-gold hover:underline"
      >
        {expanded ? t('details.hide') : t('details.show')}
      </button>
      {expanded && (
        <dl className="mt-2 space-y-1 text-xs">
          {entries.map(([key, value]) => (
            <div key={key} className="flex gap-2">
              <dt className="font-medium text-ink-2 flex-shrink-0">{key}:</dt>
              <dd className="text-muted break-all">{renderDetailValue(value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

function ActorCell({ item }: { item: AuditLogListItem }) {
  const t = useTranslations('admin.audit_log')
  if (item.actor.kind === 'system') return <span className="text-muted">{t('actor.system')}</span>
  if (item.actor.kind === 'unresolved') {
    return <span className="text-muted">{t('actor.unknown', { id: item.actor.actorUserId })}</span>
  }
  return <span>{item.actor.fullName ?? item.actor.email}</span>
}

export function AuditLogClient({ actors }: { actors: AppUserSummary[] }) {
  const t = useTranslations('admin.audit_log')

  const [filters, setFilters] = useState<Filters>(() => ({
    actorUserId: '',
    action: '',
    entityType: '',
    ...defaultDateRange(),
  }))
  const [entityTypeInput, setEntityTypeInput] = useState('')

  // cursorStack[i] is the cursor used to fetch page i (cursorStack[0] is
  // always null — the first page). pageIndex is the currently displayed
  // page. "Prev" re-fetches cursorStack[pageIndex - 1] rather than caching
  // pages, so the displayed page is always live data.
  const [cursorStack, setCursorStack] = useState<Array<AuditLogCursor | null>>([null])
  const [pageIndex, setPageIndex] = useState(0)
  const [state, setState] = useState<State>({ phase: 'idle' })
  const [, startTransition] = useTransition()

  const requestIdRef = useRef(0)
  // Tracks the last filters the fetch effect used, so it can detect a filter
  // change and reset pagination to page 0 — same effectivePage pattern as
  // people-list-client.tsx, which keeps the setState calls inside the
  // startTransition callback rather than as direct effect-body statements
  // (avoids the react-hooks/set-state-in-effect cascade-render lint error).
  const prevFiltersKeyRef = useRef(JSON.stringify(filters))

  // Debounce the free-text entity_type input, mirroring people-list-client's
  // pattern, then fold it into filters (which resets pagination below).
  useEffect(() => {
    const timer = setTimeout(() => {
      setFilters(f => (f.entityType === entityTypeInput ? f : { ...f, entityType: entityTypeInput }))
    }, 300)
    return () => clearTimeout(timer)
  }, [entityTypeInput])

  // Fetches whenever filters or the current page's cursor changes. A filter
  // change resets pagination to page 0 inside the same effect run.
  useEffect(() => {
    const filtersKey = JSON.stringify(filters)
    const filtersChanged = prevFiltersKeyRef.current !== filtersKey
    const effectiveCursorStack = filtersChanged ? [null] : cursorStack
    const effectivePageIndex = filtersChanged ? 0 : pageIndex
    prevFiltersKeyRef.current = filtersKey

    const cursor = effectiveCursorStack[effectivePageIndex] ?? null
    const id = ++requestIdRef.current

    startTransition(async () => {
      if (filtersChanged) {
        setCursorStack([null])
        setPageIndex(0)
      }
      setState({ phase: 'loading' })
      const result = await listAuditLog({ filters: toApiFilters(filters), cursor })

      if (requestIdRef.current !== id) return // stale — a newer request superseded this one

      if (result.status === 'ok') {
        setState({ phase: 'ok', rows: result.rows, total: result.total, nextCursor: result.nextCursor })
      } else {
        setState({ phase: 'error' })
      }
    })
  }, [filters, cursorStack, pageIndex])

  const hasFilters =
    filters.actorUserId !== '' || filters.action !== '' || filters.entityType !== ''

  function goNext() {
    if (state.phase !== 'ok' || !state.nextCursor) return
    const cursor = state.nextCursor
    setCursorStack(stack => [...stack.slice(0, pageIndex + 1), cursor])
    setPageIndex(p => p + 1)
  }

  function goPrev() {
    if (pageIndex === 0) return
    setPageIndex(p => p - 1)
  }

  return (
    <div>
      {/* Filters */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 mb-2">
        <div>
          <label className="block text-xs font-medium text-muted mb-1">{t('filters.actor_label')}</label>
          <select
            value={filters.actorUserId}
            onChange={e => setFilters(f => ({ ...f, actorUserId: e.target.value }))}
            className="w-full px-3 py-2 border border-line rounded-lg text-sm text-charcoal bg-cream focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold"
          >
            <option value="">{t('filters.actor_all')}</option>
            {actors.map(a => (
              <option key={a.id} value={a.id}>
                {a.full_name ?? a.email}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-muted mb-1">{t('filters.action_label')}</label>
          <select
            value={filters.action}
            onChange={e => setFilters(f => ({ ...f, action: e.target.value }))}
            className="w-full px-3 py-2 border border-line rounded-lg text-sm text-charcoal bg-cream focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold"
          >
            <option value="">{t('filters.action_all')}</option>
            {Object.entries(AUDIT_ACTIONS).map(([key, value]) => (
              <option key={value} value={value}>
                {t(`actions.${key}` as never)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-muted mb-1">{t('filters.entity_type_label')}</label>
          <input
            type="text"
            value={entityTypeInput}
            onChange={e => setEntityTypeInput(e.target.value)}
            placeholder={t('filters.entity_type_placeholder')}
            className="w-full px-3 py-2 border border-line rounded-lg text-sm text-charcoal bg-cream placeholder-muted focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-muted mb-1">{t('filters.from_label')}</label>
          <input
            type="date"
            value={filters.from}
            onChange={e => setFilters(f => ({ ...f, from: e.target.value }))}
            className="w-full px-3 py-2 border border-line rounded-lg text-sm text-charcoal bg-cream focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-muted mb-1">{t('filters.to_label')}</label>
          <input
            type="date"
            value={filters.to}
            onChange={e => setFilters(f => ({ ...f, to: e.target.value }))}
            className="w-full px-3 py-2 border border-line rounded-lg text-sm text-charcoal bg-cream focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold"
          />
        </div>
      </div>
      {!hasFilters && (
        <p className="text-xs text-muted mb-4">{t('default_window_note')}</p>
      )}
      {hasFilters && <div className="mb-4" />}

      {/* Table */}
      {state.phase === 'loading' && (
        <div className="text-sm text-muted py-8 text-center" role="status">
          {t('loading')}
        </div>
      )}

      {state.phase === 'error' && (
        <div className="text-sm text-red-600 py-8 text-center" role="alert">
          {t('error')}
        </div>
      )}

      {state.phase === 'ok' && state.rows.length === 0 && (
        <div className="text-sm text-muted py-8 text-center">
          {hasFilters ? t('empty_state_filtered') : t('empty_state')}
        </div>
      )}

      {state.phase === 'ok' && state.rows.length > 0 && (
        <>
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="min-w-full divide-y divide-line">
              <thead className="bg-cream-2">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-muted uppercase tracking-wider">
                    {t('table.time')}
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-muted uppercase tracking-wider">
                    {t('table.actor')}
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-muted uppercase tracking-wider">
                    {t('table.action')}
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-muted uppercase tracking-wider">
                    {t('table.entity')}
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-muted uppercase tracking-wider">
                    {t('table.details')}
                  </th>
                </tr>
              </thead>
              <tbody className="bg-cream divide-y divide-line">
                {state.rows.map(row => {
                  const actionKey = ACTION_VALUE_TO_KEY[row.action]
                  return (
                    <tr key={row.id}>
                      <td className="px-4 py-3 text-sm text-ink-2 whitespace-nowrap">
                        {new Date(row.createdAt).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-sm text-charcoal">
                        <ActorCell item={row} />
                      </td>
                      <td className="px-4 py-3 text-sm text-charcoal whitespace-nowrap">
                        {actionKey ? t(`actions.${actionKey}` as never) : row.action}
                      </td>
                      <td className="px-4 py-3 text-sm text-ink-2">
                        {row.entityType} / {row.entityId}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        <DetailsCell detailsJson={row.detailsJson} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between mt-4 text-sm text-muted">
            <span>{t('pagination.total', { count: state.total })}</span>
            <div className="flex items-center gap-3">
              <button
                onClick={goPrev}
                disabled={pageIndex === 0}
                className="px-3 py-1 rounded border border-line disabled:opacity-40 disabled:cursor-not-allowed hover:bg-cream-2 transition-colors"
                aria-label={t('pagination.prev')}
              >
                {t('pagination.prev')}
              </button>
              <button
                onClick={goNext}
                disabled={!state.nextCursor}
                className="px-3 py-1 rounded border border-line disabled:opacity-40 disabled:cursor-not-allowed hover:bg-cream-2 transition-colors"
                aria-label={t('pagination.next')}
              >
                {t('pagination.next')}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
