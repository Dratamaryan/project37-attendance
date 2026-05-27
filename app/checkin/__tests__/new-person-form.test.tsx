// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NewPersonForm } from '../new-person-form'
import type { PersonSummary, CreateResult } from '@/lib/actions/people.types'
import type { SearchResult } from '@/lib/actions/parishes.types'
import type { UploadResult } from '@/lib/storage/photos.types'

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, params?: Record<string, string>) => {
    if (params) {
      // Embed param values so tests can assert on interpolated content (e.g. person name)
      const paramStr = Object.values(params).join(' ')
      return `${key} ${paramStr}`
    }
    return key
  },
}))

vi.mock('@/lib/actions/people', () => ({
  createPerson: vi.fn(),
  updatePerson: vi.fn(),
  lookupByPhone: vi.fn(),
}))

vi.mock('@/lib/actions/parishes', () => ({
  searchParishes: vi.fn(),
  createPendingParish: vi.fn(),
}))

vi.mock('@/lib/storage/photos', () => ({
  uploadPhoto: vi.fn(),
}))

import { createPerson, updatePerson } from '@/lib/actions/people'
import { searchParishes } from '@/lib/actions/parishes'
import { uploadPhoto } from '@/lib/storage/photos'

const mockCreate = vi.mocked(createPerson)
const mockUpdate = vi.mocked(updatePerson)
const mockSearch = vi.mocked(searchParishes)
const mockUpload = vi.mocked(uploadPhoto)

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PHONE = '+6281234567890'
const COUNTRY = 'ID' as const

const MOCK_PERSON: PersonSummary = {
  id: 'person-001',
  phone_e164: PHONE,
  full_name: 'Budi Santoso',
  nickname: 'Budi',
  email: null,
  birth_date: '1990-05-15',
  gender: null,
  origin_parish: null,
  marital_status: null,
  photo_url: null,
  photo_publish_consent: false,
  created_at: '2026-01-01T00:00:00Z',
}

const PARISH_RESULTS = [
  { id: 'p-1', name: 'Paroki Santo Yusuf', city: 'Jakarta', region: 'DKI Jakarta', status: 'approved' as const },
  { id: 'p-2', name: 'Paroki Santa Maria', city: 'Bekasi', region: 'Jawa Barat', status: 'pending' as const },
]

const EMPTY_SEARCH: SearchResult = { status: 'success', parishes: [] }
const PARISH_SEARCH: SearchResult = { status: 'success', parishes: PARISH_RESULTS }

// ── Helpers ───────────────────────────────────────────────────────────────────

function setup(overrides: Partial<React.ComponentProps<typeof NewPersonForm>> = {}) {
  const onSuccess = vi.fn()
  const onUseExisting = vi.fn()
  const onPhotoError = vi.fn()
  const onCancel = vi.fn()
  const user = userEvent.setup({ delay: null })

  render(
    <NewPersonForm
      normalizedE164={PHONE}
      country={COUNTRY}
      onSuccess={onSuccess}
      onUseExisting={onUseExisting}
      onPhotoError={onPhotoError}
      onCancel={onCancel}
      {...overrides}
    />,
  )
  return { user, onSuccess, onUseExisting, onPhotoError, onCancel }
}

async function fillRequired(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByRole('textbox', { name: 'full_name_label' }), 'Budi Santoso')
  await user.type(screen.getByRole('textbox', { name: 'nickname_label' }), 'Budi')
  // birth_date is an input[type=date]; userEvent types into it
  const dateInput = screen.getByLabelText('birth_date_label')
  await user.type(dateInput, '1990-05-15')
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('NewPersonForm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: empty search results
    mockSearch.mockResolvedValue(EMPTY_SEARCH)
  })

  // ── Form rendering ──────────────────────────────────────────────────────────

  it('renders 4 required field inputs', () => {
    setup()
    expect(screen.getByRole('textbox', { name: 'full_name_label' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'nickname_label' })).toBeInTheDocument()
    expect(screen.getByLabelText('birth_date_label')).toBeInTheDocument()
    // PhotoUpload consent toggle is always rendered
    expect(screen.getByRole('checkbox', { name: /consent_label/i })).toBeInTheDocument()
  })

  it('phone is read-only, formatted via formatPhoneForDisplay', () => {
    setup()
    // formatPhoneForDisplay('+6281234567890') → '+62 812-3456-7890' or similar INTL format
    // The component renders the formatted phone as a <span>, not an input
    const phoneDisplay = screen.getByText(/\+62/)
    expect(phoneDisplay).toBeInTheDocument()
    // Confirm it is NOT an input element
    expect(phoneDisplay.tagName).not.toBe('INPUT')
  })

  it('"Change phone" link is present and calls onCancel', async () => {
    const { user, onCancel } = setup()
    const changeLink = screen.getByText('change_phone')
    expect(changeLink).toBeInTheDocument()
    // No unsaved changes → no confirm dialog needed
    await user.click(changeLink)
    expect(onCancel).toHaveBeenCalledOnce()
  })

  // ── Validation ──────────────────────────────────────────────────────────────

  it('submit with empty full_name shows validation error, no createPerson call', async () => {
    const { user } = setup()
    await user.click(screen.getByRole('button', { name: 'submit_button' }))
    expect(mockCreate).not.toHaveBeenCalled()
    // error_validation banner or field highlighted
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument()
    })
  })

  it('submit with empty nickname shows validation error, no createPerson call', async () => {
    const { user } = setup()
    await user.type(screen.getByRole('textbox', { name: 'full_name_label' }), 'Budi Santoso')
    await user.click(screen.getByRole('button', { name: 'submit_button' }))
    expect(mockCreate).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument()
    })
  })

  it('submit with no birth_date shows validation error, no createPerson call', async () => {
    const { user } = setup()
    await user.type(screen.getByRole('textbox', { name: 'full_name_label' }), 'Budi Santoso')
    await user.type(screen.getByRole('textbox', { name: 'nickname_label' }), 'Budi')
    await user.click(screen.getByRole('button', { name: 'submit_button' }))
    expect(mockCreate).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument()
    })
  })

  it('submit with birth_date in the future shows validation error', async () => {
    const { user } = setup()
    await user.type(screen.getByRole('textbox', { name: 'full_name_label' }), 'Budi Santoso')
    await user.type(screen.getByRole('textbox', { name: 'nickname_label' }), 'Budi')
    const dateInput = screen.getByLabelText('birth_date_label') as HTMLInputElement
    // Set a future date directly
    await act(async () => {
      dateInput.value = '2099-01-01'
      dateInput.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await user.click(screen.getByRole('button', { name: 'submit_button' }))
    expect(mockCreate).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument()
    })
  })

  // ── Parish autocomplete ─────────────────────────────────────────────────────

  it('shows results when parish input is focused with empty query', async () => {
    mockSearch.mockResolvedValue(PARISH_SEARCH)
    const { user } = setup()
    const parishInput = screen.getByRole('combobox', { name: 'origin_parish_label' })
    await act(async () => {
      await user.click(parishInput)
    })
    await waitFor(() => {
      expect(mockSearch).toHaveBeenCalledWith('', { includePending: true })
      expect(screen.getByRole('listbox')).toBeInTheDocument()
      expect(screen.getByText('Paroki Santo Yusuf')).toBeInTheDocument()
    })
  })

  it('debounces searchParishes — only one call after rapid typing', async () => {
    const { user } = setup()
    const parishInput = screen.getByRole('combobox', { name: 'origin_parish_label' })
    // Rapidly type multiple characters
    await act(async () => {
      await user.type(parishInput, 'Santo')
    })
    // After typing finishes, wait for debounce to settle
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300))
    })
    // Should only have been called once for the final value (plus the initial focus call)
    const searchCalls = mockSearch.mock.calls.filter(([q]) => q === 'Santo')
    expect(searchCalls.length).toBe(1)
  })

  it('"Add new parish" affordance appears when typed value has no exact match', async () => {
    mockSearch.mockResolvedValue(EMPTY_SEARCH)
    const { user } = setup()
    const parishInput = screen.getByRole('combobox', { name: 'origin_parish_label' })
    await act(async () => {
      await user.type(parishInput, 'Paroki Baru')
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300))
    })
    await waitFor(() => {
      expect(screen.getByText(/parish_add_new/)).toBeInTheDocument()
    })
  })

  it('selecting a parish populates origin_parish with the name string', async () => {
    mockSearch.mockResolvedValue(PARISH_SEARCH)
    const { user } = setup()
    const parishInput = screen.getByRole('combobox', { name: 'origin_parish_label' })
    await act(async () => {
      await user.click(parishInput)
    })
    await waitFor(() => screen.getByText('Paroki Santo Yusuf'))
    await act(async () => {
      await user.click(screen.getByText('Paroki Santo Yusuf'))
    })
    // After selection the input shows the parish name
    expect(parishInput).toHaveValue('Paroki Santo Yusuf')
  })

  it('pending badge renders for status=pending results', async () => {
    mockSearch.mockResolvedValue(PARISH_SEARCH)
    const { user } = setup()
    const parishInput = screen.getByRole('combobox', { name: 'origin_parish_label' })
    await act(async () => {
      await user.click(parishInput)
    })
    await waitFor(() => {
      // PARISH_RESULTS[1] has status='pending'
      const listbox = screen.getByRole('listbox')
      expect(within(listbox).getByText('parish_pending_badge')).toBeInTheDocument()
    })
  })

  // ── Photo upload ────────────────────────────────────────────────────────────

  it('rejects file larger than 5MB with photo_too_large message', async () => {
    setup()
    const input = document.querySelector('[data-testid="photo-input"]') as HTMLInputElement
    const bigFile = new File([new ArrayBuffer(6 * 1024 * 1024)], 'big.jpg', { type: 'image/jpeg' })
    // Use fireEvent.change to bypass userEvent's accept-attribute filtering
    await act(async () => {
      Object.defineProperty(input, 'files', { value: [bigFile], configurable: true })
      fireEvent.change(input)
    })
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('photo_too_large')
    })
  })

  it('rejects HEIC file with photo_heic_warning message', async () => {
    setup()
    const input = document.querySelector('[data-testid="photo-input"]') as HTMLInputElement
    // HEIC is not in the accept attribute — simulate a user who bypassed the file picker filter
    const heicFile = new File([new ArrayBuffer(100)], 'photo.heic', { type: 'image/heic' })
    await act(async () => {
      Object.defineProperty(input, 'files', { value: [heicFile], configurable: true })
      fireEvent.change(input)
    })
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('photo_heic_warning')
    })
  })

  it('consent toggle defaults to false', () => {
    setup()
    const consent = screen.getByRole('checkbox', { name: /consent_label/i }) as HTMLInputElement
    expect(consent.checked).toBe(false)
  })

  it('valid image selection creates a preview via object URL', async () => {
    const mockObjectUrl = 'blob:http://localhost/mock-url'
    vi.spyOn(URL, 'createObjectURL').mockReturnValue(mockObjectUrl)
    setup()
    const input = document.querySelector('[data-testid="photo-input"]') as HTMLInputElement
    const validFile = new File([new ArrayBuffer(100)], 'photo.jpg', { type: 'image/jpeg' })
    await act(async () => {
      Object.defineProperty(input, 'files', { value: [validFile], configurable: true })
      fireEvent.change(input)
    })
    await waitFor(() => {
      const preview = screen.getByAltText('Preview') as HTMLImageElement
      expect(preview.src).toBe(mockObjectUrl)
    })
    vi.restoreAllMocks()
  })

  // ── Submit flow ─────────────────────────────────────────────────────────────

  it('happy path with photo: createPerson called with consent fields, uploadPhoto called, updatePerson called, onSuccess fired', async () => {
    mockCreate.mockResolvedValue({ status: 'created', person: MOCK_PERSON } satisfies CreateResult)
    mockUpload.mockResolvedValue({ status: 'uploaded', path: 'people-photos/person-001/photo.jpg' } satisfies UploadResult)
    mockUpdate.mockResolvedValue({ status: 'updated', person: MOCK_PERSON })

    const mockObjectUrl = 'blob:http://localhost/mock-url'
    vi.spyOn(URL, 'createObjectURL').mockReturnValue(mockObjectUrl)
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    const { user, onSuccess } = setup()

    await fillRequired(user)

    // Upload a photo and enable consent
    const fileInput = document.querySelector('[data-testid="photo-input"]') as HTMLInputElement
    const validFile = new File([new ArrayBuffer(100)], 'photo.jpg', { type: 'image/jpeg' })
    await act(async () => {
      Object.defineProperty(fileInput, 'files', { value: [validFile], configurable: true })
      fireEvent.change(fileInput)
    })
    const consentCheckbox = screen.getByRole('checkbox', { name: /consent_label/i })
    await user.click(consentCheckbox)

    await act(async () => {
      await user.click(screen.getByRole('button', { name: 'submit_button' }))
    })

    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledOnce()
      const createArg = mockCreate.mock.calls[0][0]
      // photo_consent_at must be set when consent=true
      expect(createArg.photo_publish_consent).toBe(true)
      expect(createArg.photo_consent_at).toBeTruthy()
      expect(typeof createArg.photo_consent_at).toBe('string')

      expect(mockUpload).toHaveBeenCalledOnce()
      expect(mockUpdate).toHaveBeenCalledWith(MOCK_PERSON.id, { photo_url: 'people-photos/person-001/photo.jpg' })
      expect(onSuccess).toHaveBeenCalledWith(MOCK_PERSON)
    })

    vi.restoreAllMocks()
  })

  it('happy path without photo: photo_consent_at is null when consent=false', async () => {
    mockCreate.mockResolvedValue({ status: 'created', person: MOCK_PERSON } satisfies CreateResult)

    const { user, onSuccess } = setup()
    await fillRequired(user)

    await act(async () => {
      await user.click(screen.getByRole('button', { name: 'submit_button' }))
    })

    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledOnce()
      const createArg = mockCreate.mock.calls[0][0]
      expect(createArg.photo_publish_consent).toBe(false)
      expect(createArg.photo_consent_at).toBeNull()
      expect(mockUpload).not.toHaveBeenCalled()
      expect(onSuccess).toHaveBeenCalledWith(MOCK_PERSON)
    })
  })

  it('duplicate_phone: shows error with existing name and Use existing button', async () => {
    mockCreate.mockResolvedValue({
      status: 'duplicate_phone',
      existing: { id: 'existing-001', full_name: 'Maria Santos' },
    } satisfies CreateResult)

    const { user } = setup()
    await fillRequired(user)

    await act(async () => {
      await user.click(screen.getByRole('button', { name: 'submit_button' }))
    })

    await waitFor(() => {
      const alert = screen.getByRole('alert')
      // error_duplicate_phone has {name} replaced with 'Maria Santos'
      expect(alert).toHaveTextContent('Maria Santos')
      expect(screen.getByRole('button', { name: 'use_existing_button' })).toBeInTheDocument()
    })
  })

  it('photo upload failure: person created, onPhotoError called, onSuccess called, error message rendered', async () => {
    mockCreate.mockResolvedValue({ status: 'created', person: MOCK_PERSON } satisfies CreateResult)
    mockUpload.mockResolvedValue({ status: 'error', message: 'network error' } satisfies UploadResult)

    const mockObjectUrl = 'blob:http://localhost/mock-url'
    vi.spyOn(URL, 'createObjectURL').mockReturnValue(mockObjectUrl)
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    const { user, onSuccess, onPhotoError } = setup()
    await fillRequired(user)

    const fileInput = document.querySelector('[data-testid="photo-input"]') as HTMLInputElement
    const validFile = new File([new ArrayBuffer(100)], 'photo.jpg', { type: 'image/jpeg' })
    await act(async () => {
      Object.defineProperty(fileInput, 'files', { value: [validFile], configurable: true })
      fireEvent.change(fileInput)
    })

    await act(async () => {
      await user.click(screen.getByRole('button', { name: 'submit_button' }))
    })

    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledOnce()
      expect(mockUpdate).not.toHaveBeenCalled()
      expect(onPhotoError).toHaveBeenCalledOnce()
      expect(onSuccess).toHaveBeenCalledWith(MOCK_PERSON)
      // error message visible in form (mock onSuccess doesn't unmount in this test)
      expect(screen.getByRole('alert')).toHaveTextContent('error_photo_upload')
    })

    vi.restoreAllMocks()
  })

  it('uploadPhoto returns invalid_extension: person added, onPhotoError called, no crash', async () => {
    mockCreate.mockResolvedValue({ status: 'created', person: MOCK_PERSON } satisfies CreateResult)
    mockUpload.mockResolvedValue({ status: 'invalid_extension' } satisfies UploadResult)

    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    const { user, onSuccess, onPhotoError } = setup()
    await fillRequired(user)

    const fileInput = document.querySelector('[data-testid="photo-input"]') as HTMLInputElement
    await act(async () => {
      Object.defineProperty(fileInput, 'files', {
        value: [new File([new ArrayBuffer(100)], 'photo.jpg', { type: 'image/jpeg' })],
        configurable: true,
      })
      fireEvent.change(fileInput)
    })

    await act(async () => {
      await user.click(screen.getByRole('button', { name: 'submit_button' }))
    })

    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledOnce()
      expect(mockUpdate).not.toHaveBeenCalled()
      expect(onPhotoError).toHaveBeenCalledOnce()
      expect(onSuccess).toHaveBeenCalledWith(MOCK_PERSON)
    })

    vi.restoreAllMocks()
  })

  it('uploadPhoto throws unexpectedly: person added, onPhotoError called, no page crash', async () => {
    mockCreate.mockResolvedValue({ status: 'created', person: MOCK_PERSON } satisfies CreateResult)
    mockUpload.mockRejectedValue(new Error('RSC transport error'))

    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    const { user, onSuccess, onPhotoError } = setup()
    await fillRequired(user)

    const fileInput = document.querySelector('[data-testid="photo-input"]') as HTMLInputElement
    await act(async () => {
      Object.defineProperty(fileInput, 'files', {
        value: [new File([new ArrayBuffer(100)], 'photo.jpg', { type: 'image/jpeg' })],
        configurable: true,
      })
      fireEvent.change(fileInput)
    })

    await act(async () => {
      await user.click(screen.getByRole('button', { name: 'submit_button' }))
    })

    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledOnce()
      expect(mockUpdate).not.toHaveBeenCalled()
      expect(onPhotoError).toHaveBeenCalledOnce()
      expect(onSuccess).toHaveBeenCalledWith(MOCK_PERSON)
    })

    vi.restoreAllMocks()
  })

  it('validation_error from server: field_errors keys apply error styling', async () => {
    mockCreate.mockResolvedValue({
      status: 'validation_error',
      field_errors: { full_name: 'too long' },
    } satisfies CreateResult)

    const { user } = setup()
    await fillRequired(user)

    await act(async () => {
      await user.click(screen.getByRole('button', { name: 'submit_button' }))
    })

    await waitFor(() => {
      const fullNameInput = screen.getByRole('textbox', { name: 'full_name_label' })
      expect(fullNameInput).toHaveAttribute('aria-invalid', 'true')
    })
  })

  // ── Cancel ──────────────────────────────────────────────────────────────────

  it('cancel with no changes collapses without window.confirm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm')
    const { user, onCancel } = setup()
    // The sticky footer Cancel button is the last one; both behave identically — click either
    const cancelButtons = screen.getAllByRole('button', { name: 'cancel_button' })
    await user.click(cancelButtons[0])
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalledOnce()
    confirmSpy.mockRestore()
  })

  it('cancel with dirty fields shows window.confirm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { user, onCancel } = setup()
    await user.type(screen.getByRole('textbox', { name: 'full_name_label' }), 'Budi')
    const cancelButtons = screen.getAllByRole('button', { name: 'cancel_button' })
    await user.click(cancelButtons[0])
    expect(confirmSpy).toHaveBeenCalledOnce()
    expect(onCancel).toHaveBeenCalledOnce()
    confirmSpy.mockRestore()
  })
})
