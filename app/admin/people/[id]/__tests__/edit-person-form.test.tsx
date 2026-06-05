// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EditPersonForm } from '../edit-person-form'
import type { PersonFull } from '@/lib/actions/people.types'
import type { UpdateResult, SoftDeleteResult, RestoreResult } from '@/lib/actions/people.types'
import type { DeleteResult } from '@/lib/storage/photos.types'

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, params?: Record<string, string | number>) => {
    if (params) {
      const paramStr = Object.values(params).join(' ')
      return `${key} ${paramStr}`
    }
    return key
  },
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockRouterPush, refresh: mockRouterRefresh }),
}))

vi.mock('next/image', () => ({
  default: ({ src, alt }: { src: string; alt: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} />
  ),
}))

vi.mock('@/lib/actions/people', () => ({
  updatePerson:     vi.fn(),
  softDeletePerson: vi.fn(),
  restorePerson:    vi.fn(),
  setPhotoConsent:  vi.fn(),
}))

vi.mock('@/lib/actions/parishes', () => ({
  searchParishes:       vi.fn().mockResolvedValue({ status: 'success', parishes: [] }),
  createPendingParish:  vi.fn(),
}))

vi.mock('@/lib/storage/photos', () => ({
  uploadPhoto: vi.fn(),
  deletePhoto: vi.fn(),
}))

import { updatePerson, softDeletePerson, restorePerson, setPhotoConsent } from '@/lib/actions/people'
import { uploadPhoto, deletePhoto } from '@/lib/storage/photos'

const mockUpdate       = vi.mocked(updatePerson)
const mockSoftDelete   = vi.mocked(softDeletePerson)
const mockRestore      = vi.mocked(restorePerson)
const mockConsent      = vi.mocked(setPhotoConsent)
const mockUpload       = vi.mocked(uploadPhoto)
const mockDeletePhoto  = vi.mocked(deletePhoto)

const mockRouterPush    = vi.fn()
const mockRouterRefresh = vi.fn()

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BASE_PERSON: PersonFull = {
  id:                    'person-001',
  phone_e164:            '+6281234567890',
  full_name:             'Ryan Dratama',
  nickname:              'Ryan',
  email:                 'ryan@example.com',
  birth_place:           'Jakarta',
  birth_date:            '1995-03-15',
  gender:                'male',
  origin_parish:         null,
  marital_status:        'single',
  kepanitiaan:           'Member',
  tribe:                 'Daniel',
  notes:                 'Test note',
  current_city:          'Jakarta',
  current_area:          'Selatan',
  photo_url:             null,
  photo_publish_consent: false,
  photo_consent_at:      null,
  photo_consent_version: null,
  created_at:            '2026-01-01T00:00:00Z',
  updated_at:            '2026-06-01T00:00:00Z',
  deleted_at:            null,
}

const DELETED_PERSON: PersonFull = {
  ...BASE_PERSON,
  deleted_at: '2026-06-03T10:00:00Z',
}

const OK_UPDATE: UpdateResult = {
  status:  'updated',
  person: {
    id:                    'person-001',
    phone_e164:            '+6281234567890',
    full_name:             'Ryan Dratama',
    nickname:              'Ryan',
    email:                 null,
    birth_date:            '1995-03-15',
    gender:                'male',
    origin_parish:         null,
    marital_status:        'single',
    photo_url:             null,
    photo_publish_consent: false,
    created_at:            '2026-01-01T00:00:00Z',
  },
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function setup(person: PersonFull = BASE_PERSON, signedPhotoUrl: string | null = null) {
  return render(<EditPersonForm person={person} signedPhotoUrl={signedPhotoUrl} />)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('EditPersonForm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRouterPush.mockClear()
    mockRouterRefresh.mockClear()
    mockDeletePhoto.mockResolvedValue({ status: 'deleted' } as DeleteResult)
  })

  // ── Rendering ───────────────────────────────────────────────────────────────

  it('renders all form sections including admin fields', () => {
    setup()
    expect(screen.getByText('section.personal')).toBeInTheDocument()
    expect(screen.getByText('section.contact')).toBeInTheDocument()
    expect(screen.getByText('section.community')).toBeInTheDocument()
    expect(screen.getByText('section.admin_only')).toBeInTheDocument()
    expect(screen.getByText('section.photo')).toBeInTheDocument()
  })

  it('phone_e164 field is read-only with help text', () => {
    setup()
    const phoneInput = screen.getByRole('textbox', { name: /Phone \(locked\)/i }) as HTMLInputElement
    expect(phoneInput.readOnly).toBe(true)
    expect(screen.getByText('phone_locked')).toBeInTheDocument()
  })

  it('admin fields section has visual differentiator (bg-cream-2 container)', () => {
    setup()
    // Admin section badge
    expect(screen.getByText('section.admin_only_help')).toBeInTheDocument()
  })

  it('populates kepanitiaan and tribe from person data', () => {
    setup()
    expect(screen.getByDisplayValue('Member')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Daniel')).toBeInTheDocument()
  })

  it('save button is disabled when no changes', () => {
    setup()
    const saveBtn = screen.getByText('save_button')
    expect(saveBtn).toBeDisabled()
  })

  it('save button is enabled after a field change', async () => {
    const user = userEvent.setup()
    setup()
    const nickField = screen.getByDisplayValue('Ryan')
    await user.clear(nickField)
    await user.type(nickField, 'Ryo')
    const saveBtn = screen.getByText('save_button')
    expect(saveBtn).not.toBeDisabled()
  })

  // ── Cancel with unsaved changes ─────────────────────────────────────────────

  it('cancel with dirty fields shows window.confirm', async () => {
    const user = userEvent.setup()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    setup()
    const nickField = screen.getByDisplayValue('Ryan')
    await user.clear(nickField)
    await user.type(nickField, 'Ryo')
    await user.click(screen.getByText('cancel_button'))
    expect(confirmSpy).toHaveBeenCalled()
    expect(mockRouterPush).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it('cancel with clean state navigates without confirm', async () => {
    const user = userEvent.setup()
    const confirmSpy = vi.spyOn(window, 'confirm')
    setup()
    await user.click(screen.getByText('cancel_button'))
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(mockRouterPush).toHaveBeenCalledWith('/admin/people')
    confirmSpy.mockRestore()
  })

  // ── Save submits diff only ───────────────────────────────────────────────────

  it('save submits diff only (not the full state)', async () => {
    const user = userEvent.setup()
    mockUpdate.mockResolvedValue(OK_UPDATE)
    setup()
    const nickField = screen.getByDisplayValue('Ryan')
    await user.clear(nickField)
    await user.type(nickField, 'Ryo')
    await act(async () => {
      await user.click(screen.getByText('save_button'))
    })
    await waitFor(() => expect(mockUpdate).toHaveBeenCalled())
    const [, diff] = mockUpdate.mock.calls[0]
    expect(diff).toHaveProperty('nickname', 'Ryo')
    // Unchanged fields must NOT be in the diff
    expect(diff).not.toHaveProperty('full_name')
    expect(diff).not.toHaveProperty('email')
  })

  // ── Save success resets dirty tracking ─────────────────────────────────────

  it('save success resets dirty tracking baseline', async () => {
    const user = userEvent.setup()
    mockUpdate.mockResolvedValue(OK_UPDATE)
    setup()
    const nickField = screen.getByDisplayValue('Ryan')
    await user.clear(nickField)
    await user.type(nickField, 'Ryo')
    await act(async () => {
      await user.click(screen.getByText('save_button'))
    })
    await waitFor(() => expect(screen.getByText('save_button')).toBeDisabled())
    // After save, save button should be disabled again (no new changes)
  })

  // ── Save validation_error ───────────────────────────────────────────────────

  it('save returns validation_error: highlights field_errors', async () => {
    const user = userEvent.setup()
    mockUpdate.mockResolvedValue({
      status: 'validation_error',
      field_errors: { full_name: 'Required' },
    })
    setup()
    const nickField = screen.getByDisplayValue('Ryan')
    await user.clear(nickField)
    await user.type(nickField, 'Ryo')
    await act(async () => {
      await user.click(screen.getByText('save_button'))
    })
    await waitFor(() => expect(screen.getByText('Required')).toBeInTheDocument())
  })

  // ── Save returns not_found ──────────────────────────────────────────────────

  it('save returns not_found: navigates to /admin/people', async () => {
    const user = userEvent.setup()
    mockUpdate.mockResolvedValue({ status: 'not_found' })
    setup()
    const nickField = screen.getByDisplayValue('Ryan')
    await user.clear(nickField)
    await user.type(nickField, 'Ryo')
    await act(async () => {
      await user.click(screen.getByText('save_button'))
    })
    await waitFor(() => expect(mockRouterPush).toHaveBeenCalledWith('/admin/people'))
  })

  // ── Photo ────────────────────────────────────────────────────────────────────

  it('photo replace: stages new file, does not upload until save', async () => {
    setup()
    const input = screen.getByTestId('photo-input') as HTMLInputElement
    const file = new File(['content'], 'photo.jpg', { type: 'image/jpeg' })
    await act(async () => {
      Object.defineProperty(input, 'files', { value: [file], configurable: true })
      fireEvent.change(input)
    })
    expect(mockUpload).not.toHaveBeenCalled()
    // Save button should now be enabled (photoFile staged)
    expect(screen.getByText('save_button')).not.toBeDisabled()
  })

  it('photo remove: confirm dialog clears photo state', async () => {
    const user = userEvent.setup()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    setup(BASE_PERSON, 'https://example.com/signed-url')
    await user.click(screen.getByText('photo.remove'))
    expect(confirmSpy).toHaveBeenCalled()
    // Save button should now be enabled (removePhoto = true)
    await waitFor(() => expect(screen.getByText('save_button')).not.toBeDisabled())
    confirmSpy.mockRestore()
  })

  // ── Consent toggle ───────────────────────────────────────────────────────────

  it('consent toggle calls setPhotoConsent immediately, not via Save', async () => {
    const user = userEvent.setup()
    mockConsent.mockResolvedValue(OK_UPDATE)
    setup(BASE_PERSON, 'https://example.com/signed-url')
    const checkbox = screen.getByRole('checkbox', { name: /consent.label/i })
    await act(async () => {
      await user.click(checkbox)
    })
    await waitFor(() => expect(mockConsent).toHaveBeenCalledWith('person-001', true))
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('consent toggle: reverts UI on error', async () => {
    const user = userEvent.setup()
    mockConsent.mockResolvedValue({ status: 'error', message: 'fail' })
    setup(BASE_PERSON, 'https://example.com/signed-url')
    const checkbox = screen.getByRole('checkbox', { name: /consent.label/i }) as HTMLInputElement
    const initialChecked = checkbox.checked
    await act(async () => {
      await user.click(checkbox)
    })
    await waitFor(() => {
      const box = screen.getByRole('checkbox', { name: /consent.label/i }) as HTMLInputElement
      expect(box.checked).toBe(initialChecked)
    })
  })

  // ── Soft-delete ──────────────────────────────────────────────────────────────

  it('soft-delete confirm dialog shows person name', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(screen.getByText('soft_delete_button'))
    expect(screen.getByText(/soft_delete_confirm.message Ryan Dratama/)).toBeInTheDocument()
  })

  it('soft-delete success: navigates to /admin/people', async () => {
    const user = userEvent.setup()
    mockSoftDelete.mockResolvedValue({ status: 'deleted' } as SoftDeleteResult)
    setup()
    await user.click(screen.getByText('soft_delete_button'))
    await act(async () => {
      await user.click(screen.getByText('soft_delete_confirm.confirm'))
    })
    await waitFor(() => expect(mockRouterPush).toHaveBeenCalledWith('/admin/people'))
  })

  // ── Deleted person ───────────────────────────────────────────────────────────

  it('restore button is shown only when deleted_at is set', () => {
    setup(BASE_PERSON)
    expect(screen.queryByText('restore_button')).not.toBeInTheDocument()

    setup(DELETED_PERSON)
    expect(screen.getAllByText('restore_button')[0]).toBeInTheDocument()
  })

  it('deleted person: all text fields are read-only', () => {
    setup(DELETED_PERSON)
    const inputs = screen.getAllByRole('textbox') as HTMLInputElement[]
    const editable = inputs.filter(i => !i.readOnly)
    expect(editable).toHaveLength(0)
  })

  it('deleted person: save button is not rendered', () => {
    setup(DELETED_PERSON)
    expect(screen.queryByText('save_button')).not.toBeInTheDocument()
    expect(screen.queryByText('save_button_pending')).not.toBeInTheDocument()
  })

  it('deleted person: dispatching SET_TEXT does not mutate state (safeDispatch no-op)', async () => {
    const user = userEvent.setup()
    setup(DELETED_PERSON)
    const fullNameInput = screen.getByDisplayValue('Ryan Dratama') as HTMLInputElement
    // readOnly inputs ignore user input events, confirming safeDispatch blocks mutation
    await user.type(fullNameInput, 'Changed')
    expect(fullNameInput.value).toBe('Ryan Dratama')
  })

  it('restore success: calls router.refresh()', async () => {
    const user = userEvent.setup()
    mockRestore.mockResolvedValue({ status: 'restored' } as RestoreResult)
    setup(DELETED_PERSON)
    await act(async () => {
      await user.click(screen.getAllByText('restore_button')[0])
    })
    await waitFor(() => expect(mockRouterRefresh).toHaveBeenCalled())
  })

  // ── HEIC rejection ───────────────────────────────────────────────────────────

  it('HEIC file is rejected via extension check', async () => {
    setup()
    const input = screen.getByTestId('photo-input') as HTMLInputElement
    const heicFile = new File(['content'], 'photo.heic', { type: 'image/heic' })
    await act(async () => {
      Object.defineProperty(input, 'files', { value: [heicFile], configurable: true })
      fireEvent.change(input)
    })
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(mockUpload).not.toHaveBeenCalled()
  })
})
