// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DashboardLanding } from '../dashboard-landing'

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, params?: Record<string, string>) => {
    if (params) {
      const paramStr = Object.values(params).join(' ')
      return `${key} ${paramStr}`
    }
    return key
  },
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

describe('DashboardLanding', () => {
  it('renders Check In card for organizer role', () => {
    render(<DashboardLanding role="organizer" fullName="Test User" email="test@example.com" />)
    expect(screen.getByText('cards.checkin_title')).toBeInTheDocument()
  })

  it('does NOT render Manage People card for organizer', () => {
    render(<DashboardLanding role="organizer" fullName="Test User" email="test@example.com" />)
    expect(screen.queryByText('cards.people_title')).not.toBeInTheDocument()
  })

  it('does NOT render Settings card for organizer', () => {
    render(<DashboardLanding role="organizer" fullName="Test User" email="test@example.com" />)
    expect(screen.queryByText('cards.settings_title')).not.toBeInTheDocument()
  })

  it('renders all three cards for admin role', () => {
    render(<DashboardLanding role="admin" fullName="Admin User" email="admin@example.com" />)
    expect(screen.getByText('cards.checkin_title')).toBeInTheDocument()
    expect(screen.getByText('cards.people_title')).toBeInTheDocument()
    expect(screen.getByText('cards.settings_title')).toBeInTheDocument()
  })

  it('Settings card shows "Coming Soon" badge', () => {
    render(<DashboardLanding role="admin" fullName="Admin User" email="admin@example.com" />)
    expect(screen.getByText('cards.coming_soon')).toBeInTheDocument()
  })

  it('greeting uses full_name when present', () => {
    render(
      <DashboardLanding role="organizer" fullName="Maria Santos" email="maria@example.com" />
    )
    expect(screen.getByText(/Maria Santos/)).toBeInTheDocument()
  })

  it('greeting falls back to email when full_name is null', () => {
    render(<DashboardLanding role="organizer" fullName={null} email="maria@example.com" />)
    expect(screen.getByText(/maria@example.com/)).toBeInTheDocument()
  })
})
