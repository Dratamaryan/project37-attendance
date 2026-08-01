// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AppNavLinks } from '../AppNavLinks'

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}))

let mockPathname = '/dashboard'
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string; [key: string]: unknown }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}))

describe('AppNavLinks', () => {
  it('renders a single Admin link for admin role (topbar)', () => {
    render(<AppNavLinks role="admin" variant="topbar" />)
    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(3)
    expect(screen.getByText('admin').closest('a')).toHaveAttribute('href', '/admin')
  })

  it('renders a single Admin link for admin role (bottom-tab)', () => {
    render(<AppNavLinks role="admin" variant="bottom-tab" />)
    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(3)
    expect(screen.getByText('admin').closest('a')).toHaveAttribute('href', '/admin')
  })

  it('renders no Admin link for organizer role', () => {
    render(<AppNavLinks role="organizer" variant="topbar" />)
    expect(screen.queryByText('admin')).not.toBeInTheDocument()
    expect(screen.getAllByRole('link')).toHaveLength(2)
  })

  it('renders no Admin link for null role', () => {
    render(<AppNavLinks role={null} variant="topbar" />)
    expect(screen.queryByText('admin')).not.toBeInTheDocument()
    expect(screen.getAllByRole('link')).toHaveLength(2)
  })

  it('highlights the Admin link when on any /admin/* subpath', () => {
    mockPathname = '/admin/people'
    render(<AppNavLinks role="admin" variant="topbar" />)
    expect(screen.getByText('admin').closest('a')).toHaveClass('text-gold')
    mockPathname = '/dashboard'
  })
})
