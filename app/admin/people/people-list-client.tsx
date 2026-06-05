'use client'

import { useState, useEffect, useRef, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { listPeople } from '@/lib/actions/people'
import type { ListPeopleResult, PersonListItem } from '@/lib/actions/people.types'
import { PersonRow } from './person-row'

// Local debounce hook — mirrors the pattern from checkin-client.tsx.
// Returns [debouncedValue, fireCount] where fireCount increments on every
// settlement, even if the settled value equals the previous value.
function useDebounce<T>(value: T, delayMs: number): [T, number] {
  const [debounced, setDebounced] = useState(value)
  const [fireCount, setFireCount] = useState(0)

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(value)
      setFireCount(c => c + 1)
    }, delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])

  return [debounced, fireCount]
}

type State =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ok'; people: PersonListItem[]; total: number; page: number; page_size: number }
  | { phase: 'error' }

export function PeopleListClient() {
  const t = useTranslations('admin.people')

  const [rawQuery, setRawQuery] = useState('')
  const [includeDeleted, setIncludeDeleted] = useState(false)
  const [page, setPage] = useState(1)
  const [state, setState] = useState<State>({ phase: 'idle' })
  const [, startTransition] = useTransition()

  const requestIdRef = useRef(0)
  // Tracks the last query+filter params the fetch effect used, so the fetch effect
  // can detect when they change and reset page to 1 before fetching.
  const prevSearchRef = useRef({ query: '', includeDeleted: false })

  const [debouncedQuery] = useDebounce(rawQuery, 300)

  // Fetch whenever debounced query, includeDeleted, or page changes.
  // When query/filter change, resets page to 1 inside startTransition (avoids
  // react-hooks/set-state-in-effect cascade-render warning).
  useEffect(() => {
    const paramsChanged =
      prevSearchRef.current.query !== debouncedQuery ||
      prevSearchRef.current.includeDeleted !== includeDeleted

    const effectivePage = paramsChanged ? 1 : page
    prevSearchRef.current = { query: debouncedQuery, includeDeleted }

    const id = ++requestIdRef.current

    startTransition(async () => {
      if (paramsChanged) {
        setPage(1) // reset pagination state to match effectivePage
      }
      setState({ phase: 'loading' })

      const result: ListPeopleResult = await listPeople({
        query: debouncedQuery || undefined,
        include_deleted: includeDeleted,
        page: effectivePage,
        page_size: 25,
      })

      if (requestIdRef.current !== id) return // stale — discard

      if (result.status === 'ok') {
        setState({
          phase: 'ok',
          people: result.people,
          total: result.total,
          page: result.page,
          page_size: result.page_size,
        })
      } else {
        setState({ phase: 'error' })
      }
    })
  }, [debouncedQuery, includeDeleted, page])

  const totalPages = state.phase === 'ok'
    ? Math.max(1, Math.ceil(state.total / state.page_size))
    : 1

  return (
    <div>
      {/* Controls */}
      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <input
          type="search"
          value={rawQuery}
          onChange={e => setRawQuery(e.target.value)}
          placeholder={t('search_placeholder')}
          className="flex-1 px-4 py-2 border border-line rounded-lg text-sm text-charcoal bg-cream placeholder-muted focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold transition-colors"
          aria-label={t('search_placeholder')}
        />
        <label className="flex items-center gap-2 text-sm text-charcoal cursor-pointer select-none">
          <input
            type="checkbox"
            checked={includeDeleted}
            onChange={e => setIncludeDeleted(e.target.checked)}
            className="rounded border-line accent-gold"
          />
          {t('show_deleted')}
        </label>
      </div>

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

      {state.phase === 'ok' && state.people.length === 0 && (
        <div className="text-sm text-muted py-8 text-center">
          {debouncedQuery ? t('empty_state_filtered') : t('empty_state')}
        </div>
      )}

      {state.phase === 'ok' && state.people.length > 0 && (
        <>
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="min-w-full divide-y divide-line">
              <thead className="bg-cream-2">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-muted uppercase tracking-wider">
                    Name
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-muted uppercase tracking-wider">
                    Phone
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-muted uppercase tracking-wider">
                    Parish
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-muted uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="bg-cream divide-y divide-line">
                {state.people.map(person => (
                  <PersonRow key={person.id} person={person} />
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between mt-4 text-sm text-muted">
            <span>{t('pagination.total', { count: state.total })}</span>
            <div className="flex items-center gap-3">
              <span>{t('pagination.page_of', { current: state.page, total: totalPages })}</span>
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={state.page <= 1}
                className="px-3 py-1 rounded border border-line disabled:opacity-40 disabled:cursor-not-allowed hover:bg-cream-2 transition-colors"
                aria-label={t('pagination.prev')}
              >
                {t('pagination.prev')}
              </button>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={state.page >= totalPages}
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
