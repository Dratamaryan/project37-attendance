// @vitest-environment jsdom
//
// Client behaviour of the public RSVP form (S9-R1): status-dependent children
// section, 1..20 count select, field errors / banners, success recap, and
// "Change my answer" returning to a pre-filled form.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { RsvpFormState } from '@/lib/rsvp/public.types'
import { RsvpForm } from '../rsvp-form'

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, params?: Record<string, string | number>) =>
    params ? `${key} ${Object.values(params).join(' ')}` : key,
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string; [key: string]: unknown }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}))

const action = vi.fn<(prev: RsvpFormState, formData: FormData) => Promise<RsvpFormState>>()

function lastFormData(): Record<string, string> {
  const fd = action.mock.calls.at(-1)?.[1]
  if (!fd) throw new Error('action not called')
  return Object.fromEntries([...fd.entries()].map(([k, v]) => [k, String(v)]))
}

async function fillValid(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByLabelText('form.status_coming'))
  await user.type(screen.getByLabelText(/form\.phone_label/), '081234567890')
}

beforeEach(() => {
  action.mockReset()
})

describe('RsvpForm — children section', () => {
  it('visible by default; hidden for Tidak hadir; back for Hadir / Mungkin', async () => {
    const user = userEvent.setup()
    render(<RsvpForm action={action} />)
    expect(screen.getByTestId('rsvp-children')).toBeInTheDocument()

    await user.click(screen.getByLabelText('form.status_not_coming'))
    expect(screen.queryByTestId('rsvp-children')).not.toBeInTheDocument()

    await user.click(screen.getByLabelText('form.status_maybe'))
    expect(screen.getByTestId('rsvp-children')).toBeInTheDocument()

    await user.click(screen.getByLabelText('form.status_coming'))
    expect(screen.getByTestId('rsvp-children')).toBeInTheDocument()
  })

  it('Tidak is the default; Ya reveals a 1..20 select', async () => {
    const user = userEvent.setup()
    render(<RsvpForm action={action} />)
    expect(screen.getByLabelText('form.children_no')).toBeChecked()
    expect(screen.queryByLabelText('form.children_count_label')).not.toBeInTheDocument()

    await user.click(screen.getByLabelText('form.children_yes'))
    const select = screen.getByLabelText('form.children_count_label') as HTMLSelectElement
    expect([...select.options].map((o) => o.value)).toEqual(
      Array.from({ length: 20 }, (_, i) => String(i + 1)),
    )
    expect(select.value).toBe('1')

    await user.click(screen.getByLabelText('form.children_no'))
    expect(screen.queryByLabelText('form.children_count_label')).not.toBeInTheDocument()
  })
})

describe('RsvpForm — submission', () => {
  it('submits the field names the server parses', async () => {
    action.mockResolvedValue({ kind: 'success', status: 'coming', children: 3 })
    const user = userEvent.setup()
    render(<RsvpForm action={action} />)
    await fillValid(user)
    await user.type(screen.getByLabelText(/form\.name_label/), 'Budi')
    await user.click(screen.getByLabelText('form.children_yes'))
    await user.selectOptions(screen.getByLabelText('form.children_count_label'), '3')
    await user.click(screen.getByLabelText('form.consent_label_interim'))
    await user.click(screen.getByRole('button', { name: 'form.submit' }))

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1))
    expect(lastFormData()).toEqual({
      status: 'coming',
      phone: '081234567890',
      name: 'Budi',
      bringing_children: 'yes',
      children_count: '3',
      followup_consent: 'on',
    })
  })

  it('Tidak hadir sends no children fields', async () => {
    action.mockResolvedValue({ kind: 'success', status: 'not_coming', children: 0 })
    const user = userEvent.setup()
    render(<RsvpForm action={action} />)
    await user.click(screen.getByLabelText('form.children_yes'))
    await user.click(screen.getByLabelText('form.status_not_coming'))
    await user.type(screen.getByLabelText(/form\.phone_label/), '081234567890')
    await user.click(screen.getByRole('button', { name: 'form.submit' }))

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1))
    const sent = lastFormData()
    expect(sent.status).toBe('not_coming')
    expect(sent).not.toHaveProperty('bringing_children')
    expect(sent).not.toHaveProperty('children_count')
    // Consent never ticked -> the checkbox is not submitted at all.
    expect(sent).not.toHaveProperty('followup_consent')
  })

  it('consent ticked then unticked is not submitted', async () => {
    action.mockResolvedValue({ kind: 'success', status: 'coming', children: 0 })
    const user = userEvent.setup()
    render(<RsvpForm action={action} />)
    await fillValid(user)
    const consent = screen.getByLabelText('form.consent_label_interim')
    await user.click(consent)
    await user.click(consent)
    expect(consent).not.toBeChecked()
    await user.click(screen.getByRole('button', { name: 'form.submit' }))

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1))
    expect(lastFormData()).not.toHaveProperty('followup_consent')
  })

  it('shows the pending label while the action runs', async () => {
    let resolve: (s: RsvpFormState) => void = () => {}
    action.mockImplementation(() => new Promise((r) => { resolve = r }))
    const user = userEvent.setup()
    render(<RsvpForm action={action} />)
    await fillValid(user)
    await user.click(screen.getByRole('button', { name: 'form.submit' }))
    expect(await screen.findByRole('button', { name: 'form.submit_pending' })).toBeDisabled()
    resolve({ kind: 'success', status: 'coming', children: 0 })
    expect(await screen.findByTestId('rsvp-success')).toBeInTheDocument()
  })

  it('field errors render inline with role=alert, and the answers are kept', async () => {
    action.mockResolvedValue({ kind: 'invalid', fieldErrors: { phone: 'too_short', status: 'required' } })
    const user = userEvent.setup()
    render(<RsvpForm action={action} />)
    await user.type(screen.getByLabelText(/form\.phone_label/), '0812')
    await user.click(screen.getByRole('button', { name: 'form.submit' }))

    expect(await screen.findByText('errors.phone_too_short')).toHaveAttribute('role', 'alert')
    expect(screen.getByText('errors.status_required')).toHaveAttribute('role', 'alert')
    expect(screen.getByText('errors.invalid_summary')).toBeInTheDocument()
    expect(screen.getByLabelText(/form\.phone_label/)).toHaveValue('0812')
    expect(screen.getByLabelText(/form\.phone_label/)).toHaveAttribute('aria-invalid', 'true')
  })

  it.each([
    [{ kind: 'limit' } as const, 'errors.limit'],
    [{ kind: 'unavailable' } as const, 'errors.unavailable'],
    [{ kind: 'error' } as const, 'errors.generic'],
  ])('%j -> banner %s, form stays', async (result, text) => {
    action.mockResolvedValue(result)
    const user = userEvent.setup()
    render(<RsvpForm action={action} />)
    await fillValid(user)
    await user.click(screen.getByRole('button', { name: 'form.submit' }))
    expect(await screen.findByText(text)).toHaveAttribute('role', 'alert')
    expect(screen.getByTestId('rsvp-form')).toBeInTheDocument()
  })

  it('closed -> swaps to the not-available view', async () => {
    action.mockResolvedValue({ kind: 'closed' })
    const user = userEvent.setup()
    render(<RsvpForm action={action} />)
    await fillValid(user)
    await user.click(screen.getByRole('button', { name: 'form.submit' }))
    expect(await screen.findByTestId('rsvp-not-available')).toHaveTextContent('closed.title')
    // h2: the page's event <h1> is still above this swap.
    expect(screen.getByRole('heading', { level: 2, name: 'closed.title' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument()
    expect(screen.queryByTestId('rsvp-form')).not.toBeInTheDocument()
  })
})

describe('RsvpForm — success', () => {
  it('recaps the visitor’s own status and children', async () => {
    action.mockResolvedValue({ kind: 'success', status: 'coming', children: 2 })
    const user = userEvent.setup()
    render(<RsvpForm action={action} />)
    await fillValid(user)
    await user.click(screen.getByRole('button', { name: 'form.submit' }))

    const success = await screen.findByTestId('rsvp-success')
    expect(success).toHaveTextContent('success.title')
    expect(success).toHaveTextContent('success.recap_status form.status_coming')
    expect(success).toHaveTextContent('success.recap_children 2')
    expect(screen.queryByTestId('rsvp-form')).not.toBeInTheDocument()
  })

  it('no children -> "none" line; not attending -> no children line', async () => {
    action.mockResolvedValueOnce({ kind: 'success', status: 'maybe', children: 0 })
    const user = userEvent.setup()
    const { unmount } = render(<RsvpForm action={action} />)
    await fillValid(user)
    await user.click(screen.getByRole('button', { name: 'form.submit' }))
    expect(await screen.findByTestId('rsvp-success')).toHaveTextContent('success.recap_no_children')
    unmount()

    action.mockResolvedValueOnce({ kind: 'success', status: 'not_coming', children: 0 })
    render(<RsvpForm action={action} />)
    await fillValid(user)
    await user.click(screen.getByRole('button', { name: 'form.submit' }))
    const success = await screen.findByTestId('rsvp-success')
    expect(success).toHaveTextContent('success.recap_status form.status_not_coming')
    expect(success).not.toHaveTextContent('success.recap_children')
    expect(success).not.toHaveTextContent('success.recap_no_children')
  })

  it('"Ubah jawaban" returns to the pre-filled form; resubmitting shows success again', async () => {
    action
      .mockResolvedValueOnce({ kind: 'success', status: 'coming', children: 0 })
      .mockResolvedValueOnce({ kind: 'success', status: 'maybe', children: 0 })
    const user = userEvent.setup()
    render(<RsvpForm action={action} />)
    await fillValid(user)
    await user.click(screen.getByRole('button', { name: 'form.submit' }))
    await user.click(await screen.findByRole('button', { name: 'success.edit' }))

    expect(screen.getByTestId('rsvp-form')).toBeInTheDocument()
    expect(screen.getByLabelText(/form\.phone_label/)).toHaveValue('081234567890')
    expect(screen.getByLabelText('form.status_coming')).toBeChecked()

    await user.click(screen.getByLabelText('form.status_maybe'))
    await user.click(screen.getByRole('button', { name: 'form.submit' }))
    expect(await screen.findByTestId('rsvp-success')).toHaveTextContent('success.recap_status form.status_maybe')
    expect(action).toHaveBeenCalledTimes(2)
    expect(lastFormData()).toMatchObject({ status: 'maybe', phone: '081234567890' })
  })
})
