// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { BackToLoginLink } from '../BackToLoginLink'

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}))

describe('BackToLoginLink', () => {
  it('renders on /privacy as a link whose href resolves to /login — the way out of the dead-end page', () => {
    render(<BackToLoginLink />)
    const link = screen.getByText('backToLogin').closest('a')
    expect(link).toHaveAttribute('href', '/login')
  })
})
