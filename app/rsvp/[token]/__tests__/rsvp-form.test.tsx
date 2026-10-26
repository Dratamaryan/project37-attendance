// @vitest-environment jsdom
//
// Client behaviour of the public RSVP form (S9-R1): status-dependent children
// section, 1..20 count select, field errors / banners, success recap, and
// "Change my answer" returning to a pre-filled form. S9-R4: honeypot markup and
// the Turnstile widget lifecycle against a fake window.turnstile.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { RsvpFormState } from '@/lib/rsvp/public.types'
import { RsvpForm } from '../rsvp-form'
import { TURNSTILE_SCRIPT_SRC, TURNSTILE_UNAVAILABLE_AFTER_MS, type TurnstileApi } from '../turnstile-widget'

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
    await user.click(screen.getByLabelText('form.consent_label'))
    await user.click(screen.getByRole('button', { name: 'form.submit' }))

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1))
    expect(lastFormData()).toEqual({
      website: '', // S9-R4 honeypot, empty for a person
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
    const consent = screen.getByLabelText('form.consent_label')
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

// ── S9-R4 ────────────────────────────────────────────────────────────────────

describe('RsvpForm — privacy policy link (S9-R5)', () => {
  it('opens /privacy in a new tab, so the filled-in form is never unmounted', async () => {
    const user = userEvent.setup()
    render(<RsvpForm action={action} />)
    await fillValid(user)
    await user.type(screen.getByLabelText(/form\.name_label/), 'Budi')
    await user.click(screen.getByLabelText('form.consent_label'))

    const link = screen.getByRole('link', { name: 'form.privacy_link' })
    expect(link).toHaveAttribute('href', '/privacy')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')

    expect(screen.getByLabelText(/form\.phone_label/)).toHaveValue('081234567890')
    expect(screen.getByLabelText(/form\.name_label/)).toHaveValue('Budi')
    expect(screen.getByLabelText('form.consent_label')).toBeChecked()
  })
})

describe('RsvpForm — honeypot', () => {
  it('off-screen, aria-hidden, untabbable "website" input; not display:none or sr-only', () => {
    const { container } = render(<RsvpForm action={action} />)
    const input = container.querySelector('input[name="website"]') as HTMLInputElement
    expect(input).not.toBeNull()
    expect(input.tabIndex).toBe(-1)
    expect(input.getAttribute('autocomplete')).toBe('off')
    expect(input.type).toBe('text')
    const wrapper = input.parentElement as HTMLElement
    expect(wrapper.getAttribute('aria-hidden')).toBe('true')
    expect(wrapper.className).toContain('absolute')
    expect(wrapper.className).toContain('-left-[10000px]')
    expect(wrapper.className).not.toContain('sr-only')
    expect(wrapper.className).not.toContain('hidden ')
    expect(wrapper.style.display).not.toBe('none')
  })

  it('is submitted empty by a person', async () => {
    action.mockResolvedValue({ kind: 'success', status: 'coming', children: 0 })
    const user = userEvent.setup()
    render(<RsvpForm action={action} />)
    await fillValid(user)
    await user.click(screen.getByRole('button', { name: 'form.submit' }))
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1))
    expect(lastFormData()).toMatchObject({ website: '' })
  })
})

describe('RsvpForm — Turnstile widget', () => {
  type RenderOpts = Parameters<TurnstileApi['render']>[1]
  let renderOpts: RenderOpts[]
  let fake: { render: ReturnType<typeof vi.fn>; reset: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    renderOpts = []
    fake = {
      render: vi.fn((_el: HTMLElement, opts: RenderOpts) => {
        renderOpts.push(opts)
        return 'widget-1'
      }),
      reset: vi.fn(),
      remove: vi.fn(),
    }
    window.turnstile = fake as unknown as TurnstileApi
  })

  afterEach(() => {
    vi.useRealTimers()
    delete window.turnstile
    // jsdom never loads the script: fail any pending load so the module-level
    // loader forgets it and the next test starts clean.
    document.head.querySelectorAll(`script[src="${TURNSTILE_SCRIPT_SRC}"]`).forEach((el) => {
      el.dispatchEvent(new Event('error'))
      el.remove()
    })
  })

  const scriptTag = () => document.head.querySelector(`script[src="${TURNSTILE_SCRIPT_SRC}"]`) as HTMLScriptElement

  const issueToken = (token: string) => act(() => renderOpts.at(-1)?.callback(token))

  it('no site key -> no widget, no script, no token field; submit enabled', () => {
    delete window.turnstile
    const { container } = render(<RsvpForm action={action} turnstileSiteKey={null} />)
    expect(screen.queryByTestId('rsvp-turnstile')).not.toBeInTheDocument()
    expect(document.head.querySelector(`script[src="${TURNSTILE_SCRIPT_SRC}"]`)).toBeNull()
    expect(container.querySelector('input[name="cf-turnstile-response"]')).toBeNull()
    expect(screen.getByRole('button', { name: 'form.submit' })).toBeEnabled()
  })

  it('site key -> renders once with sitekey, action rsvp, auto refresh, own response field off', async () => {
    render(<RsvpForm action={action} turnstileSiteKey="site-key-1" />)
    expect(screen.getByTestId('rsvp-turnstile')).toBeInTheDocument()
    await waitFor(() => expect(fake.render).toHaveBeenCalledTimes(1))
    expect(renderOpts[0]).toMatchObject({
      sitekey: 'site-key-1',
      action: 'rsvp',
      'refresh-expired': 'auto',
      'response-field': false,
    })
  })

  it('loads api.js (explicit render) once when turnstile is not on the page yet', () => {
    delete window.turnstile
    render(<RsvpForm action={action} turnstileSiteKey="site-key-1" />)
    const scripts = document.head.querySelectorAll(`script[src="${TURNSTILE_SCRIPT_SRC}"]`)
    expect(scripts).toHaveLength(1)
    expect(TURNSTILE_SCRIPT_SRC).toBe('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit')
  })

  it('submit is disabled ("verifying") until a token exists, then submits it', async () => {
    action.mockResolvedValue({ kind: 'success', status: 'coming', children: 0 })
    const user = userEvent.setup()
    render(<RsvpForm action={action} turnstileSiteKey="site-key-1" />)
    await fillValid(user)
    expect(screen.getByRole('button', { name: 'form.submit_verifying' })).toBeDisabled()

    await waitFor(() => expect(fake.render).toHaveBeenCalled())
    await issueToken('tok-abc')
    await user.click(screen.getByRole('button', { name: 'form.submit' }))
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1))
    expect(lastFormData()).toMatchObject({ 'cf-turnstile-response': 'tok-abc' })
  })

  it('expired / error callbacks clear the token and disable submit again', async () => {
    render(<RsvpForm action={action} turnstileSiteKey="site-key-1" />)
    await waitFor(() => expect(fake.render).toHaveBeenCalled())
    await issueToken('tok-1')
    expect(screen.getByRole('button', { name: 'form.submit' })).toBeEnabled()
    await act(() => renderOpts[0]['expired-callback']())
    expect(screen.getByRole('button', { name: 'form.submit_verifying' })).toBeDisabled()
    await issueToken('tok-2')
    await act(() => renderOpts[0]['error-callback']())
    expect(screen.getByRole('button', { name: 'form.submit_verifying' })).toBeDisabled()
  })

  it.each<RsvpFormState>([
    { kind: 'unavailable' },
    { kind: 'limit' },
    { kind: 'error' },
    { kind: 'invalid', fieldErrors: { phone: 'too_short' } },
  ])('after a $kind result: widget reset, token cleared, submit disabled', async (result) => {
    action.mockResolvedValue(result)
    const user = userEvent.setup()
    const { container } = render(<RsvpForm action={action} turnstileSiteKey="site-key-1" />)
    await fillValid(user)
    await waitFor(() => expect(fake.render).toHaveBeenCalled())
    await issueToken('tok-used')
    expect(fake.reset).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'form.submit' }))
    await waitFor(() => expect(fake.reset).toHaveBeenCalledWith('widget-1'))
    expect(screen.getByRole('button', { name: 'form.submit_verifying' })).toBeDisabled()
    expect((container.querySelector('input[name="cf-turnstile-response"]') as HTMLInputElement).value).toBe('')
  })

  it('success unmounts the widget (remove); "Ubah jawaban" mounts a fresh one', async () => {
    action.mockResolvedValue({ kind: 'success', status: 'coming', children: 0 })
    const user = userEvent.setup()
    render(<RsvpForm action={action} turnstileSiteKey="site-key-1" />)
    await fillValid(user)
    await waitFor(() => expect(fake.render).toHaveBeenCalledTimes(1))
    await issueToken('tok-1')
    await user.click(screen.getByRole('button', { name: 'form.submit' }))
    await screen.findByTestId('rsvp-success')
    expect(fake.remove).toHaveBeenCalledWith('widget-1')

    await user.click(screen.getByRole('button', { name: 'success.edit' }))
    await waitFor(() => expect(fake.render).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('button', { name: 'form.submit_verifying' })).toBeDisabled()
    expect(fake.reset).not.toHaveBeenCalled()
  })

  // ── R2: blocked-script / no-token fallback (still fail-closed) ──

  it('script load failure -> unavailable note (role=status), submit stays disabled', async () => {
    delete window.turnstile
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<RsvpForm action={action} turnstileSiteKey="site-key-1" />)
    expect(screen.queryByTestId('rsvp-turnstile-unavailable')).not.toBeInTheDocument()

    await act(async () => {
      scriptTag().dispatchEvent(new Event('error'))
    })
    const note = await screen.findByTestId('rsvp-turnstile-unavailable')
    expect(note).toHaveAttribute('role', 'status')
    expect(note).toHaveTextContent('form.turnstile_unavailable')
    expect(screen.getByRole('button', { name: 'form.submit_verifying' })).toBeDisabled()
    expect(err).toHaveBeenCalled()
  })

  it('15s without a token -> note shown; a token then hides it and enables submit', async () => {
    vi.useFakeTimers()
    render(<RsvpForm action={action} turnstileSiteKey="site-key-1" />)
    await act(async () => {}) // let loadTurnstile resolve and render
    expect(fake.render).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(TURNSTILE_UNAVAILABLE_AFTER_MS - 1)
    })
    expect(screen.queryByTestId('rsvp-turnstile-unavailable')).not.toBeInTheDocument()
    await act(async () => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.getByTestId('rsvp-turnstile-unavailable')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'form.submit_verifying' })).toBeDisabled()

    await issueToken('late-token')
    expect(screen.queryByTestId('rsvp-turnstile-unavailable')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'form.submit' })).toBeEnabled()
  })

  it('a token inside 15s clears the timer — no note later', async () => {
    vi.useFakeTimers()
    render(<RsvpForm action={action} turnstileSiteKey="site-key-1" />)
    await act(async () => {})
    await issueToken('tok')
    await act(async () => {
      vi.advanceTimersByTime(TURNSTILE_UNAVAILABLE_AFTER_MS * 2)
    })
    expect(screen.queryByTestId('rsvp-turnstile-unavailable')).not.toBeInTheDocument()
  })

  it('reset after an error re-arms the 15s timer', async () => {
    action.mockResolvedValue({ kind: 'unavailable' })
    const user = userEvent.setup()
    render(<RsvpForm action={action} turnstileSiteKey="site-key-1" />)
    await fillValid(user)
    await waitFor(() => expect(fake.render).toHaveBeenCalled())
    await issueToken('tok-used')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await act(async () => {
      screen.getByRole('button', { name: 'form.submit' }).click()
    })
    await act(async () => {})
    expect(fake.reset).toHaveBeenCalledWith('widget-1')
    await act(async () => {
      vi.advanceTimersByTime(TURNSTILE_UNAVAILABLE_AFTER_MS)
    })
    expect(screen.getByTestId('rsvp-turnstile-unavailable')).toBeInTheDocument()
  })

  it.each([['expired-callback'], ['error-callback']] as const)(
    'token -> %s -> 15s without a new token shows the note; a fresh token hides it',
    async (cb) => {
      vi.useFakeTimers()
      render(<RsvpForm action={action} turnstileSiteKey="site-key-1" />)
      await act(async () => {})
      await issueToken('tok-1')
      await act(async () => {
        vi.advanceTimersByTime(TURNSTILE_UNAVAILABLE_AFTER_MS * 2)
      })
      expect(screen.queryByTestId('rsvp-turnstile-unavailable')).not.toBeInTheDocument()

      await act(async () => renderOpts[0][cb]())
      expect(screen.getByRole('button', { name: 'form.submit_verifying' })).toBeDisabled()
      await act(async () => {
        vi.advanceTimersByTime(TURNSTILE_UNAVAILABLE_AFTER_MS - 1)
      })
      expect(screen.queryByTestId('rsvp-turnstile-unavailable')).not.toBeInTheDocument()
      await act(async () => {
        vi.advanceTimersByTime(1)
      })
      expect(screen.getByTestId('rsvp-turnstile-unavailable')).toBeInTheDocument()

      await issueToken('tok-2')
      expect(screen.queryByTestId('rsvp-turnstile-unavailable')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'form.submit' })).toBeEnabled()
    },
  )

  it('a fresh token after expiry inside 15s cancels the re-armed timer', async () => {
    vi.useFakeTimers()
    render(<RsvpForm action={action} turnstileSiteKey="site-key-1" />)
    await act(async () => {})
    await issueToken('tok-1')
    await act(async () => renderOpts[0]['expired-callback']())
    await issueToken('tok-2')
    await act(async () => {
      vi.advanceTimersByTime(TURNSTILE_UNAVAILABLE_AFTER_MS * 2)
    })
    expect(screen.queryByTestId('rsvp-turnstile-unavailable')).not.toBeInTheDocument()
  })

  it('timer is cleared on unmount', () => {
    vi.useFakeTimers()
    const { unmount } = render(<RsvpForm action={action} turnstileSiteKey="site-key-1" />)
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
