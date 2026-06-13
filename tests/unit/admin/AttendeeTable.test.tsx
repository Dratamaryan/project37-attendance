// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AttendeeTable } from '@/app/admin/events/_components/AttendeeTable'
import type { AttendanceWithPerson } from '@/lib/actions/attendance.types'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}))

vi.mock('next/image', () => ({
  default: (props: React.ImgHTMLAttributes<HTMLImageElement>) =>
    // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
    <img {...props} />,
}))

// date-fns-tz runs for real in node/jsdom — no mock needed.

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeAttendance(overrides: Partial<AttendanceWithPerson> = {}): AttendanceWithPerson {
  return {
    id: 'att-001',
    event_instance_id: 'inst-001',
    checked_in_at: '2026-07-11T03:00:00Z',   // 10:00 Asia/Jakarta
    source: 'volunteer_checkin',
    checked_in_by: 'user-001',
    checked_in_by_email: 'admin@test.invalid',
    person: {
      id: 'person-001',
      full_name: 'Budi Santoso',
      nickname: 'Budi',
      phone_e164: '+6281234567890',
      photo_url: null,
      photo_signed_url: null,
      deleted_at: null,
    },
    ...overrides,
  }
}

const DELETED: AttendanceWithPerson = {
  id: 'att-deleted',
  event_instance_id: 'inst-001',
  checked_in_at: '2026-07-11T04:00:00Z',   // 11:00 Asia/Jakarta
  source: 'volunteer_checkin',
  checked_in_by: 'user-001',
  checked_in_by_email: 'org@test.invalid',
  person: {
    id: 'person-deleted',
    full_name: 'Jane Deleted',
    nickname: null,
    phone_e164: '+6289876543210',
    photo_url: null,
    photo_signed_url: null,
    deleted_at: '2026-06-01T00:00:00Z',
  },
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AttendeeTable', () => {
  it('AT-01: renders all provided attendances with correct columns', () => {
    const att2 = makeAttendance({
      id: 'att-002',
      checked_in_at: '2026-07-11T04:00:00Z',
      person: {
        id: 'person-002',
        full_name: 'Ani Rahayu',
        nickname: 'Ani',
        phone_e164: '+6289000000000',
        photo_url: null,
        photo_signed_url: null,
        deleted_at: null,
      },
    })
    render(<AttendeeTable attendances={[makeAttendance(), att2]} />)

    const rows = screen.getAllByTestId('attendee-row')
    expect(rows).toHaveLength(2)

    // Name present
    expect(screen.getByText('Budi Santoso')).toBeInTheDocument()
    expect(screen.getByText('Ani Rahayu')).toBeInTheDocument()

    // Phone present
    expect(screen.getByText('+6281234567890')).toBeInTheDocument()
    expect(screen.getByText('+6289000000000')).toBeInTheDocument()

    // Checked-in-by email present
    expect(screen.getAllByText('admin@test.invalid').length).toBeGreaterThan(0)
  })

  it('AT-02: soft-deleted attendee gets (deleted) badge + muted row', () => {
    render(<AttendeeTable attendances={[DELETED]} />)

    const badge = screen.getByTestId('deleted-badge')
    expect(badge).toBeInTheDocument()

    // Row has muted opacity class
    const row = screen.getByTestId('attendee-row')
    expect(row.className).toContain('opacity-60')
  })

  it('AT-03: search input filters by name (case-insensitive)', async () => {
    const user = userEvent.setup()
    const att2 = makeAttendance({
      id: 'att-002',
      person: {
        id: 'person-002',
        full_name: 'Ani Rahayu',
        nickname: 'Ani',
        phone_e164: '+6289000000000',
        photo_url: null,
        photo_signed_url: null,
        deleted_at: null,
      },
    })
    render(<AttendeeTable attendances={[makeAttendance(), att2]} />)

    const searchBox = screen.getByRole('textbox')
    await user.type(searchBox, 'ani')

    // Only Ani Rahayu should be visible
    expect(screen.getByText('Ani Rahayu')).toBeInTheDocument()
    expect(screen.queryByText('Budi Santoso')).not.toBeInTheDocument()
  })

  it('AT-04: search by phone substring works', async () => {
    const user = userEvent.setup()
    const att2 = makeAttendance({
      id: 'att-002',
      person: {
        id: 'person-002',
        full_name: 'Ani Rahayu',
        nickname: null,
        phone_e164: '+6289999999999',
        photo_url: null,
        photo_signed_url: null,
        deleted_at: null,
      },
    })
    render(<AttendeeTable attendances={[makeAttendance(), att2]} />)

    const searchBox = screen.getByRole('textbox')
    await user.type(searchBox, '89999')

    expect(screen.getByText('Ani Rahayu')).toBeInTheDocument()
    expect(screen.queryByText('Budi Santoso')).not.toBeInTheDocument()
  })

  it('AT-05: empty state when no attendances', () => {
    render(<AttendeeTable attendances={[]} />)
    expect(screen.getByText('table.empty')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })
})
