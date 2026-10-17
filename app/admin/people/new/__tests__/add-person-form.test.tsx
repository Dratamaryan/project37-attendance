// @vitest-environment jsdom
//
// S8-T10 admin "Add person" short form: phone → full name → nickname → birth
// date, createPerson on submit, redirect to the edit page, duplicate-phone
// handling (active / soft-deleted / empty-id fallback) and the similar-name
// warning that holds Submit until "Continue anyway".
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AddPersonForm } from '../add-person-form'
import type { CreateResult, LookupByNameResult, PersonSummary } from '@/lib/actions/people.types'

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, params?: Record<string, string>) =>
    params ? `${key} ${Object.values(params).join(' ')}` : key,
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string; [key: string]: unknown }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}))

const mockPush = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

vi.mock('@/lib/actions/people', () => ({
  createPerson: vi.fn(),
  lookupByName: vi.fn(),
}))

import { createPerson, lookupByName } from '@/lib/actions/people'

const mockCreate = vi.mocked(createPerson)
const mockLookupByName = vi.mocked(lookupByName)

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CREATED: PersonSummary = {
  id: 'new-person-id',
  phone_e164: '+6299912340001',
  full_name: 'Budi Santoso',
  nickname: 'Budi',
  email: null,
  birth_date: '1990-05-15',
  gender: null,
  origin_parish: null,
  marital_status: null,
  photo_url: null,
  photo_publish_consent: false,
  created_at: '2026-10-17T00:00:00Z',
}

function summary(id: string, full_name: string, nickname: string, phone_e164: string): PersonSummary {
  return { ...CREATED, id, full_name, nickname, phone_e164 }
}

const NO_MATCHES: LookupByNameResult = { status: 'none' }

// ── Helpers ───────────────────────────────────────────────────────────────────

function setup() {
  const user = userEvent.setup({ delay: null })
  render(<AddPersonForm />)
  return { user }
}

async function fillAll(
  user: ReturnType<typeof userEvent.setup>,
  values: Partial<{ phone: string; full_name: string; nickname: string; birth_date: string }> = {},
) {
  const v = { phone: '0812345678', full_name: 'Budi Santoso', nickname: 'Budi', birth_date: '1990-05-15', ...values }
  if (v.phone) await user.type(screen.getByLabelText('phone_label'), v.phone)
  if (v.full_name) await user.type(screen.getByLabelText(/full_name_label/), v.full_name)
  if (v.nickname) await user.type(screen.getByLabelText(/nickname_label/), v.nickname)
  // Date inputs: set the value directly (userEvent typing into type=date is jsdom-flaky).
  if (v.birth_date) fireEvent.change(screen.getByLabelText(/birth_date_label/), { target: { value: v.birth_date } })
}

/** Lets the 400ms name debounce settle and the lookup promise resolve, inside act(). */
async function settleDebounce() {
  await act(async () => { await new Promise(r => setTimeout(r, 450)) })
}

function submitButton() {
  return screen.getByRole('button', { name: 'submit' })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AddPersonForm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLookupByName.mockResolvedValue(NO_MATCHES)
  })

  it('renders phone first, then full name, nickname, birth date', () => {
    setup()
    const phone = screen.getByLabelText('phone_label')
    const fullName = screen.getByLabelText(/full_name_label/)
    const nickname = screen.getByLabelText(/nickname_label/)
    const birth = screen.getByLabelText(/birth_date_label/)
    const order = [phone, fullName, nickname, birth]
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
  })

  it('created → createPerson called with the four fields, then redirects to the edit page', async () => {
    mockCreate.mockResolvedValue({ status: 'created', person: CREATED } satisfies CreateResult)
    const { user } = setup()
    await fillAll(user)
    await settleDebounce()
    await user.click(submitButton())

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/admin/people/new-person-id'))
    expect(mockCreate).toHaveBeenCalledWith({
      phone_e164_raw: '0812345678',
      country: 'ID',
      full_name: 'Budi Santoso',
      nickname: 'Budi',
      birth_date: '1990-05-15',
    })
  })

  it('duplicate (active) → "already registered" with a link to the existing person', async () => {
    mockCreate.mockResolvedValue({
      status: 'duplicate_phone',
      existing: { id: 'existing-id', full_name: 'Maria Santos', deleted_at: null },
    } satisfies CreateResult)
    const { user } = setup()
    await fillAll(user)
    await settleDebounce()
    await user.click(submitButton())

    expect(await screen.findByText('duplicate_phone Maria Santos')).toBeInTheDocument()
    const link = screen.getByRole('link', { name: 'open_existing' })
    expect(link).toHaveAttribute('href', '/admin/people/existing-id')
    expect(screen.queryByText(/duplicate_phone_deleted/)).not.toBeInTheDocument()
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('duplicate (soft-deleted) → "(deleted)" wording + "Open to restore" link', async () => {
    mockCreate.mockResolvedValue({
      status: 'duplicate_phone',
      existing: { id: 'deleted-id', full_name: 'Gone Person', deleted_at: '2026-10-01T00:00:00Z' },
    } satisfies CreateResult)
    const { user } = setup()
    await fillAll(user)
    await settleDebounce()
    await user.click(submitButton())

    expect(await screen.findByText('duplicate_phone_deleted Gone Person')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'open_to_restore' })).toHaveAttribute('href', '/admin/people/deleted-id')
    expect(screen.queryByRole('link', { name: 'open_existing' })).not.toBeInTheDocument()
  })

  it('duplicate with empty id (row not visible) → message, no link', async () => {
    mockCreate.mockResolvedValue({
      status: 'duplicate_phone',
      existing: { id: '', full_name: 'Unknown', deleted_at: null },
    } satisfies CreateResult)
    const { user } = setup()
    await fillAll(user)
    await settleDebounce()
    await user.click(submitButton())

    expect(await screen.findByText('duplicate_phone Unknown')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'open_existing' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'open_to_restore' })).not.toBeInTheDocument()
  })

  it('editing the phone clears the duplicate message', async () => {
    mockCreate.mockResolvedValue({
      status: 'duplicate_phone',
      existing: { id: 'existing-id', full_name: 'Maria Santos', deleted_at: null },
    } satisfies CreateResult)
    const { user } = setup()
    await fillAll(user)
    await settleDebounce()
    await user.click(submitButton())
    await screen.findByText('duplicate_phone Maria Santos')

    await user.type(screen.getByLabelText('phone_label'), '9')
    expect(screen.queryByText('duplicate_phone Maria Santos')).not.toBeInTheDocument()
  })

  it('similar name → warning with masked phones + links; Submit held; "Continue anyway" creates', async () => {
    mockLookupByName.mockImplementation(async (q: string) =>
      q === 'Budi Santoso'
        ? { status: 'matches', people: [summary('m1', 'Budi Santoso', 'Budi', '+6281111112222')], hasMore: false }
        : {
            status: 'matches',
            people: [
              summary('m1', 'Budi Santoso', 'Budi', '+6281111112222'),
              summary('m2', 'Budi Hartono', 'Har', '+6281111113333'),
            ],
            hasMore: false,
          },
    )
    mockCreate.mockResolvedValue({ status: 'created', person: CREATED } satisfies CreateResult)
    const { user } = setup()
    await fillAll(user)
    await settleDebounce()

    // Both queries ran: full name and first token.
    expect(mockLookupByName).toHaveBeenCalledWith('Budi Santoso')
    expect(mockLookupByName).toHaveBeenCalledWith('Budi')

    const panel = await screen.findByRole('region', { name: 'similar_title' })
    // Deduped (m1 once), full-name match first, masked phone tails only.
    expect(panel).toHaveTextContent('…2222')
    expect(panel).toHaveTextContent('…3333')
    expect(panel).not.toHaveTextContent('+6281111112222')
    const links = screen.getAllByRole('link', { name: 'similar_open' })
    expect(links.map(l => l.getAttribute('href'))).toEqual(['/admin/people/m1', '/admin/people/m2'])

    // Submit is held while the warning is open.
    expect(submitButton()).toBeDisabled()
    expect(mockCreate).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'similar_continue' }))
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/admin/people/new-person-id'))
    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('region', { name: 'similar_title' })).not.toBeInTheDocument()
  })

  it('submitting before the debounce settles still runs the name check and holds on matches', async () => {
    mockLookupByName.mockResolvedValue({
      status: 'matches',
      people: [summary('m1', 'Budi Santoso', 'Budi', '+6281111112222')],
      hasMore: false,
    })
    const { user } = setup()
    await fillAll(user)
    // No settleDebounce — submit immediately.
    await user.click(submitButton())

    expect(await screen.findByRole('region', { name: 'similar_title' })).toBeInTheDocument()
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('missing birth date → required error, createPerson not called', async () => {
    const { user } = setup()
    await fillAll(user, { birth_date: '' })
    await settleDebounce()
    await user.click(submitButton())

    expect(screen.getByText('error.required')).toBeInTheDocument()
    expect(screen.getByLabelText(/birth_date_label/)).toHaveAttribute('aria-invalid', 'true')
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('future birth date → future_date error, createPerson not called', async () => {
    const { user } = setup()
    await fillAll(user, { birth_date: '2999-01-01' })
    await settleDebounce()
    await user.click(submitButton())

    expect(screen.getByText('error.future_date')).toBeInTheDocument()
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('empty form → required on all four fields, createPerson not called', async () => {
    const { user } = setup()
    await user.click(submitButton())
    expect(screen.getAllByText('error.required')).toHaveLength(4)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('server validation_error on phone → translated invalid_phone, not the raw server text', async () => {
    mockCreate.mockResolvedValue({
      status: 'validation_error',
      field_errors: { phone_e164_raw: 'Invalid phone: invalid_for_country' },
    } satisfies CreateResult)
    const { user } = setup()
    await fillAll(user)
    await settleDebounce()
    await user.click(submitButton())

    expect(await screen.findByText('error.invalid_phone')).toBeInTheDocument()
    expect(screen.queryByText(/invalid_for_country/)).not.toBeInTheDocument()
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('server error → generic alert, no redirect', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockCreate.mockResolvedValue({ status: 'error', message: 'Failed to create person' } satisfies CreateResult)
    const { user } = setup()
    await fillAll(user)
    await settleDebounce()
    await user.click(submitButton())

    expect(await screen.findByText('error_generic')).toBeInTheDocument()
    expect(mockPush).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
