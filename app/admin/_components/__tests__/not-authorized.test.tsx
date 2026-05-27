// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { NotAuthorized } from '../not-authorized'

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}))

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    ...rest
  }: {
    children: React.ReactNode
    href: string
    [key: string]: unknown
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

describe('NotAuthorized', () => {
  it('renders message + back-to-dashboard link', () => {
    render(<NotAuthorized />)
    expect(screen.getByText('title')).toBeInTheDocument()
    expect(screen.getByText('message')).toBeInTheDocument()
    expect(screen.getByRole('link')).toBeInTheDocument()
  })

  it('link href is /dashboard', () => {
    render(<NotAuthorized />)
    const link = screen.getByRole('link')
    expect(link).toHaveAttribute('href', '/dashboard')
  })
})
