// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PersonRow } from '../person-row'
import type { PersonListItem } from '@/lib/actions/people.types'

vi.mock('next-intl', () => ({
  useTranslations:
    () =>
    (key: string, params?: Record<string, string>) => {
      if (params) {
        return `${key} ${Object.values(params).join(' ')}`
      }
      return key
    },
}))

vi.mock('next/image', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: (props: any) => <img {...props} />, // eslint-disable-line @next/next/no-img-element, jsx-a11y/alt-text
}))

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: { href: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

const BASE_PERSON: PersonListItem = {
  id: 'person-001',
  phone_e164: '+6281234567890',
  full_name: 'Budi Hartono',
  nickname: 'Budi',
  origin_parish: 'Jakarta Selatan',
  birth_date: '1990-05-15',
  photo_consent_state: 'unknown',
  photo_url: null,
  photo_signed_url: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  deleted_at: null,
}

function renderRow(person: PersonListItem) {
  return render(
    <table>
      <tbody>
        <PersonRow person={person} />
      </tbody>
    </table>
  )
}

describe('PersonRow', () => {
  it('renders name, nickname, formatted phone, birth date, and consent state', () => {
    renderRow(BASE_PERSON)
    expect(screen.getByText('Budi Hartono')).toBeInTheDocument()
    expect(screen.getByText('Budi')).toBeInTheDocument()
    // formatPhoneForDisplay returns "+62 812 3456 7890" — match country code + digits
    expect(screen.getByText(/\+62.*812/)).toBeInTheDocument()
    // birth_date rendered raw YYYY-MM-DD via formatDateOnly — no Date() parsing
    expect(screen.getByText('1990-05-15')).toBeInTheDocument()
    // consent state 'unknown' → i18n key 'row.consent_unknown' (mocked to echo the key)
    expect(screen.getByText('row.consent_unknown')).toBeInTheDocument()
  })

  it('renders each consent state distinctly (unknown must never read as refused)', () => {
    renderRow({ ...BASE_PERSON, photo_consent_state: 'granted' })
    expect(screen.getByText('row.consent_granted')).toBeInTheDocument()
  })

  it('falls back to the no-birth-date label when birth_date is null', () => {
    renderRow({ ...BASE_PERSON, birth_date: null })
    expect(screen.getByText('row.no_birth_date')).toBeInTheDocument()
  })

  it('renders initials fallback when photo_signed_url is null', () => {
    renderRow(BASE_PERSON)
    // Initials: B (Budi) + H (Hartono) = BH
    expect(screen.getByText('BH')).toBeInTheDocument()
    // No img element
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('renders photo when photo_signed_url is provided', () => {
    renderRow({ ...BASE_PERSON, photo_signed_url: 'https://example.com/photo.jpg' })
    const img = screen.getByRole('img')
    expect(img).toHaveAttribute('src', 'https://example.com/photo.jpg')
  })

  it('renders Deleted badge when deleted_at is set', () => {
    renderRow({
      ...BASE_PERSON,
      deleted_at: '2026-05-01T00:00:00Z',
    })
    // The badge key is "row.deleted_badge" — our mock returns "row.deleted_badge <date>"
    expect(screen.getByText(/row\.deleted_badge/)).toBeInTheDocument()
  })

  it('Edit link href points to /admin/people/{id}', () => {
    renderRow(BASE_PERSON)
    const link = screen.getByRole('link', { name: /row\.edit/ })
    expect(link).toHaveAttribute('href', '/admin/people/person-001')
  })

  it('deleted row shows View link (muted style) instead of Edit link', () => {
    renderRow({ ...BASE_PERSON, deleted_at: '2026-05-01T00:00:00Z' })
    // Gold Edit link absent for deleted rows
    expect(screen.queryByRole('link', { name: 'row.edit' })).toBeNull()
    // Muted View link present
    const viewLink = screen.getByRole('link', { name: 'row.edit_deleted' })
    expect(viewLink).toBeInTheDocument()
    expect(viewLink).toHaveAttribute('href', '/admin/people/person-001')
    expect(viewLink).toHaveClass('text-muted')
  })
})
