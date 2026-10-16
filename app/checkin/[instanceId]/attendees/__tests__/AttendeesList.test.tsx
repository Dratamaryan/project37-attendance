// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AttendeesList } from '../_components/AttendeesList'
import type { InstanceAdultAttendee, InstanceChildAttendee } from '@/lib/actions/instance-attendees.types'

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, params?: Record<string, string>) =>
    params ? `${key} ${Object.values(params).join(' ')}` : key,
}))

const adult = (over: Partial<InstanceAdultAttendee>): InstanceAdultAttendee => ({
  attendance_id: 'att-x',
  full_name: 'X',
  nickname: null,
  phone_masked: '•••• 0000',
  checked_in_at: '2026-06-01T11:05:00Z',
  is_first_timer: false,
  checker_email: null,
  ...over,
})

const ADULTS: InstanceAdultAttendee[] = [
  adult({ attendance_id: 'a1', full_name: 'Budi Santoso', nickname: 'Budi', phone_masked: '•••• 1234', is_first_timer: true }),
  adult({ attendance_id: 'a2', full_name: 'Maria Lestari', nickname: 'Ria', phone_masked: '•••• 5678', checked_in_at: '2026-06-01T11:30:00Z' }),
]

const CHILDREN: InstanceChildAttendee[] = [
  { child_attendance_id: 'c1', child_name: 'Yosef', parent_name: 'Budi Santoso', parent_phone_masked: '•••• 1234', checked_in_at: '2026-06-01T11:20:00Z' },
  { child_attendance_id: 'c2', child_name: 'Theresia', parent_name: null, parent_phone_masked: null, checked_in_at: '2026-06-01T11:21:00Z' },
]

const adultNames = () => screen.queryAllByTestId('adult-row').map(r => within(r).getByText(/Santoso|Lestari/).textContent)
const childNames = () => screen.queryAllByTestId('child-row').map(r => r.textContent ?? '')

describe('AttendeesList', () => {
  it('renders adults with masked phone + WIB time, and a first-timer badge only for first-timers', () => {
    render(<AttendeesList adults={ADULTS} childAttendees={CHILDREN} />)
    const rows = screen.getAllByTestId('adult-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('•••• 1234')
    expect(rows[0]).toHaveTextContent('18:05') // 11:05Z → 18:05 WIB
    expect(within(rows[0]!).getByTestId('first-timer-badge')).toBeInTheDocument()
    expect(within(rows[1]!).queryByTestId('first-timer-badge')).not.toBeInTheDocument()
  })

  it('renders the children section with parent name + masked phone, and a placeholder when the parent is hidden', () => {
    render(<AttendeesList adults={ADULTS} childAttendees={CHILDREN} />)
    const rows = screen.getAllByTestId('child-row')
    expect(rows[0]).toHaveTextContent('Yosef')
    expect(rows[0]).toHaveTextContent('parent_label Budi Santoso')
    expect(rows[0]).toHaveTextContent('•••• 1234')
    expect(rows[1]).toHaveTextContent('parent_unknown')
  })

  it('search by name and by nickname', async () => {
    const user = userEvent.setup({ delay: null })
    render(<AttendeesList adults={ADULTS} childAttendees={CHILDREN} />)
    const box = screen.getByRole('searchbox')

    await user.type(box, 'lestari')
    expect(adultNames()).toEqual(['Maria Lestari'])

    await user.clear(box)
    await user.type(box, 'ria')
    expect(adultNames()).toEqual(['Maria Lestari'])
  })

  it('search by last-4 digits matches adults and children (via parent phone)', async () => {
    const user = userEvent.setup({ delay: null })
    render(<AttendeesList adults={ADULTS} childAttendees={CHILDREN} />)
    await user.type(screen.getByRole('searchbox'), '1234')
    expect(adultNames()).toEqual(['Budi Santoso'])
    expect(childNames()).toHaveLength(1)
    expect(childNames()[0]).toContain('Yosef')
  })

  it('child search by child name and by parent name', async () => {
    const user = userEvent.setup({ delay: null })
    render(<AttendeesList adults={ADULTS} childAttendees={CHILDREN} />)
    const box = screen.getByRole('searchbox')

    await user.type(box, 'theresia')
    expect(childNames()).toHaveLength(1)
    expect(childNames()[0]).toContain('Theresia')

    await user.clear(box)
    await user.type(box, 'santoso')
    expect(childNames()).toHaveLength(1)
    expect(childNames()[0]).toContain('Yosef')
  })

  it('no-results message when nothing matches', async () => {
    const user = userEvent.setup({ delay: null })
    render(<AttendeesList adults={ADULTS} childAttendees={CHILDREN} />)
    await user.type(screen.getByRole('searchbox'), 'zzz')
    expect(screen.getByText('search_no_results')).toBeInTheDocument()
  })

  it('empty states for both sections', () => {
    render(<AttendeesList adults={[]} childAttendees={[]} />)
    expect(screen.getByText('empty_adults')).toBeInTheDocument()
    expect(screen.getByText('empty_children')).toBeInTheDocument()
  })
})
