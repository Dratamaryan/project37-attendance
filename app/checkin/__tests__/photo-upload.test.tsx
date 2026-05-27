// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import { fireEvent } from '@testing-library/react'
import { PhotoUpload } from '../photo-upload'

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

function setup() {
  const onFileSelect = vi.fn()
  const onClear = vi.fn()
  const onConsentChange = vi.fn()

  render(
    <PhotoUpload
      previewUrl={null}
      consent={false}
      onFileSelect={onFileSelect}
      onClear={onClear}
      onConsentChange={onConsentChange}
    />,
  )

  const input = document.querySelector('[data-testid="photo-input"]') as HTMLInputElement
  return { input, onFileSelect, onClear, onConsentChange }
}

async function uploadFile(input: HTMLInputElement, file: File) {
  await act(async () => {
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    fireEvent.change(input)
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PhotoUpload — extension-first HEIC rejection', () => {
  beforeEach(() => vi.clearAllMocks())

  it('.heic extension → shows heic_warning, onFileSelect not called', async () => {
    const { input, onFileSelect } = setup()
    await uploadFile(input, new File([new ArrayBuffer(100)], 'photo.heic', { type: 'image/heic' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('photo_heic_warning'))
    expect(onFileSelect).not.toHaveBeenCalled()
  })

  it('.HEIC extension (uppercase from iPhone) → shows heic_warning', async () => {
    const { input, onFileSelect } = setup()
    await uploadFile(input, new File([new ArrayBuffer(100)], 'IMG_5954.HEIC', { type: '' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('photo_heic_warning'))
    expect(onFileSelect).not.toHaveBeenCalled()
  })

  it('.heif extension → shows heic_warning', async () => {
    const { input, onFileSelect } = setup()
    await uploadFile(input, new File([new ArrayBuffer(100)], 'photo.heif', { type: 'image/heif' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('photo_heic_warning'))
    expect(onFileSelect).not.toHaveBeenCalled()
  })

  it('mime image/heic + .heic name → shows heic_warning', async () => {
    const { input, onFileSelect } = setup()
    await uploadFile(input, new File([new ArrayBuffer(100)], 'shot.heic', { type: 'image/heic' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('photo_heic_warning'))
    expect(onFileSelect).not.toHaveBeenCalled()
  })

  it('empty mime + .heic name → shows heic_warning (extension check fires first)', async () => {
    const { input, onFileSelect } = setup()
    await uploadFile(input, new File([new ArrayBuffer(100)], 'IMG_0001.heic', { type: '' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('photo_heic_warning'))
    expect(onFileSelect).not.toHaveBeenCalled()
  })

  it('.svg extension → shows photo_invalid_type', async () => {
    const { input, onFileSelect } = setup()
    await uploadFile(input, new File([new ArrayBuffer(100)], 'icon.svg', { type: 'image/svg+xml' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('photo_invalid_type'))
    expect(onFileSelect).not.toHaveBeenCalled()
  })

  it('valid JPEG passes all checks and calls onFileSelect (happy-path regression)', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const { input, onFileSelect } = setup()
    await uploadFile(input, new File([new ArrayBuffer(100)], 'photo.jpg', { type: 'image/jpeg' }))
    await waitFor(() => expect(onFileSelect).toHaveBeenCalledOnce())
    expect(screen.queryByRole('alert')).toBeNull()
    vi.restoreAllMocks()
  })
})
