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
  it('renders Analytics + Admin links for admin role (topbar)', () => {
    render(<AppNavLinks role="admin" variant="topbar" />)
    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(4)
    expect(screen.getByText('analytics').closest('a')).toHaveAttribute('href', '/admin/analytics')
    expect(screen.getByText('admin').closest('a')).toHaveAttribute('href', '/admin')
  })

  it('renders Analytics + Admin links for admin role (bottom-tab)', () => {
    render(<AppNavLinks role="admin" variant="bottom-tab" />)
    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(4)
    expect(screen.getByText('analytics').closest('a')).toHaveAttribute('href', '/admin/analytics')
    expect(screen.getByText('admin').closest('a')).toHaveAttribute('href', '/admin')
  })

  it('renders no admin links for organizer role', () => {
    render(<AppNavLinks role="organizer" variant="topbar" />)
    expect(screen.queryByText('admin')).not.toBeInTheDocument()
    expect(screen.queryByText('analytics')).not.toBeInTheDocument()
    expect(screen.getAllByRole('link')).toHaveLength(2)
  })

  it('renders no admin links for null role', () => {
    render(<AppNavLinks role={null} variant="topbar" />)
    expect(screen.queryByText('admin')).not.toBeInTheDocument()
    expect(screen.queryByText('analytics')).not.toBeInTheDocument()
    expect(screen.getAllByRole('link')).toHaveLength(2)
  })

  it('highlights the Admin link (not Analytics) on a non-analytics /admin/* subpath', () => {
    mockPathname = '/admin/people'
    render(<AppNavLinks role="admin" variant="topbar" />)
    expect(screen.getByText('admin').closest('a')).toHaveClass('text-gold')
    expect(screen.getByText('analytics').closest('a')).not.toHaveClass('text-gold')
    mockPathname = '/dashboard'
  })

  it('highlights only Analytics (not Admin) on /admin/analytics — longest match wins', () => {
    mockPathname = '/admin/analytics'
    render(<AppNavLinks role="admin" variant="topbar" />)
    expect(screen.getByText('analytics').closest('a')).toHaveClass('text-gold')
    expect(screen.getByText('admin').closest('a')).not.toHaveClass('text-gold')
    mockPathname = '/dashboard'
  })
})
