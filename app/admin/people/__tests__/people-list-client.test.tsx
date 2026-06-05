// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PeopleListClient } from '../people-list-client'
import type { ListPeopleResult, PersonListItem } from '@/lib/actions/people.types'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('next-intl', () => ({
  useTranslations:
    () =>
    (key: string, params?: Record<string, string | number>) => {
      if (params) return `${key} ${Object.values(params).join(' ')}`
      return key
    },
}))

vi.mock('@/lib/actions/people', () => ({
  listPeople: vi.fn(),
}))

// PersonRow is a child — mock it to avoid needing next/link etc.
vi.mock('../person-row', () => ({
  PersonRow: ({ person }: { person: PersonListItem }) => (
    <tr data-testid={`row-${person.id}`}>
      <td>{person.full_name}</td>
    </tr>
  ),
}))

import { listPeople } from '@/lib/actions/people'
const mockListPeople = vi.mocked(listPeople)

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MOCK_PERSON: PersonListItem = {
  id: 'person-001',
  phone_e164: '+6281234567890',
  full_name: 'Ryan Dratama',
  nickname: 'Ryan',
  origin_parish: null,
  photo_url: null,
  photo_signed_url: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  deleted_at: null,
}

const OK_RESULT: ListPeopleResult = {
  status: 'ok',
  people: [MOCK_PERSON],
  total: 1,
  page: 1,
  page_size: 25,
}

const EMPTY_RESULT: ListPeopleResult = {
  status: 'ok',
  people: [],
  total: 0,
  page: 1,
  page_size: 25,
}

const ERROR_RESULT: ListPeopleResult = { status: 'error', message: 'Query failed' }

// ── Helpers ───────────────────────────────────────────────────────────────────

function setup() {
  const user = userEvent.setup({ delay: null })
  render(<PeopleListClient />)
  return { user }
}

async function flushDebounce() {
  await act(async () => {
    await new Promise(r => setTimeout(r, 400))
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PeopleListClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListPeople.mockResolvedValue(OK_RESULT)
  })

  it('renders search input and show-deleted toggle', async () => {
    setup()
    await flushDebounce()
    expect(screen.getByRole('searchbox')).toBeInTheDocument()
    expect(screen.getByRole('checkbox')).toBeInTheDocument()
  })

  it('calls listPeople on mount', async () => {
    setup()
    await flushDebounce()
    expect(mockListPeople).toHaveBeenCalledTimes(1)
  })

  it('debounces listPeople — only one call after rapid typing', async () => {
    const { user } = setup()
    await flushDebounce() // initial mount call

    mockListPeople.mockClear()
    const input = screen.getByRole('searchbox')
    await user.type(input, 'Ryan')
    // Typing fast — 300ms hasn't elapsed yet
    expect(mockListPeople).toHaveBeenCalledTimes(0)
    await flushDebounce()
    expect(mockListPeople).toHaveBeenCalledTimes(1)
  })

  it('resets to page 1 when query changes', async () => {
    // Start with a two-page scenario
    mockListPeople.mockResolvedValue({
      status: 'ok',
      people: Array.from({ length: 25 }, (_, i) => ({ ...MOCK_PERSON, id: `p-${i}` })),
      total: 50,
      page: 1,
      page_size: 25,
    })
    const { user } = setup()
    await flushDebounce()

    // Click next page
    const nextBtn = screen.getByRole('button', { name: /pagination\.next/ })
    await user.click(nextBtn)
    await flushDebounce()
    // Verify page 2 was requested
    expect(mockListPeople).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }))

    // Now type a query — page should reset to 1
    const input = screen.getByRole('searchbox')
    await user.type(input, 'Ryan')
    await flushDebounce()
    expect(mockListPeople).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, query: 'Ryan' }))
  })

  it('renders rows when listPeople returns data', async () => {
    setup()
    await flushDebounce()
    expect(screen.getByTestId('row-person-001')).toBeInTheDocument()
  })

  it('shows empty state when no results and no query', async () => {
    mockListPeople.mockResolvedValue(EMPTY_RESULT)
    setup()
    await flushDebounce()
    expect(screen.getByText('empty_state')).toBeInTheDocument()
  })

  it('shows filtered empty state when query non-empty and zero results', async () => {
    mockListPeople.mockResolvedValue(EMPTY_RESULT)
    const { user } = setup()
    await flushDebounce()

    const input = screen.getByRole('searchbox')
    await user.type(input, 'xyz')
    await flushDebounce()
    expect(screen.getByText('empty_state_filtered')).toBeInTheDocument()
  })

  it('stale lookup result does not overwrite a newer one', async () => {
    const { user } = setup()
    // Let the initial mount call complete before setting up the stale scenario
    await flushDebounce()

    let resolveFirst!: (r: ListPeopleResult) => void
    let resolveSecond!: (r: ListPeopleResult) => void
    const firstPromise = new Promise<ListPeopleResult>(res => { resolveFirst = res })
    const secondPromise = new Promise<ListPeopleResult>(res => { resolveSecond = res })

    mockListPeople
      .mockReturnValueOnce(firstPromise)
      .mockReturnValueOnce(secondPromise)

    // Type 'a' → first fetch (firstPromise)
    const input = screen.getByRole('searchbox')
    await user.type(input, 'a')
    await flushDebounce()

    // Type 'b' without waiting for first to resolve → second fetch (secondPromise)
    await user.clear(input)
    await user.type(input, 'b')
    await flushDebounce()

    // Resolve second (newer) first
    await act(async () => {
      resolveSecond({
        status: 'ok',
        people: [{ ...MOCK_PERSON, full_name: 'Second Result' }],
        total: 1,
        page: 1,
        page_size: 25,
      })
      await new Promise(r => setTimeout(r, 50))
    })
    expect(screen.getByText('Second Result')).toBeInTheDocument()

    // Now resolve the stale first — should NOT overwrite
    await act(async () => {
      resolveFirst({
        status: 'ok',
        people: [{ ...MOCK_PERSON, full_name: 'Stale Result' }],
        total: 1,
        page: 1,
        page_size: 25,
      })
      await new Promise(r => setTimeout(r, 50))
    })
    expect(screen.queryByText('Stale Result')).toBeNull()
    expect(screen.getByText('Second Result')).toBeInTheDocument()
  })

  it('shows error message when listPeople returns error', async () => {
    mockListPeople.mockResolvedValue(ERROR_RESULT)
    setup()
    await flushDebounce()
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText('error')).toBeInTheDocument()
  })

  it('pagination prev is disabled on page 1', async () => {
    mockListPeople.mockResolvedValue({
      ...OK_RESULT,
      total: 50,
      page: 1,
      page_size: 25,
    })
    setup()
    await flushDebounce()
    const prev = screen.getByRole('button', { name: /pagination\.prev/ })
    expect(prev).toBeDisabled()
  })

  it('pagination next is disabled on last page', async () => {
    mockListPeople.mockResolvedValue({
      ...OK_RESULT,
      total: 1,
      page: 1,
      page_size: 25,
    })
    setup()
    await flushDebounce()
    const next = screen.getByRole('button', { name: /pagination\.next/ })
    expect(next).toBeDisabled()
  })
})
