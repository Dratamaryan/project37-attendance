// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PersonChildrenSection } from '../person-children-section'
import type { AdminChildSummary } from '@/lib/actions/children.types'

// ── Mocks ──────────────────────────────────────────────────────────────────────

// Keys render as themselves; params are appended (edit-person-form.test pattern).
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, params?: Record<string, string | number>) =>
    params ? `${key} ${Object.values(params).join(' ')}` : key,
}))

vi.mock('@/lib/actions/children', () => ({
  createChild:          vi.fn(),
  updateChild:          vi.fn(),
  softDeleteChild:      vi.fn(),
  listChildrenByParentForAdmin: vi.fn(),
}))

import { createChild, updateChild, softDeleteChild, listChildrenByParentForAdmin } from '@/lib/actions/children'

const mockCreate     = vi.mocked(createChild)
const mockUpdate     = vi.mocked(updateChild)
const mockSoftDelete = vi.mocked(softDeleteChild)
const mockList       = vi.mocked(listChildrenByParentForAdmin)

// ── Fixtures (synthetic) ───────────────────────────────────────────────────────

type Parent = { id: string; full_name: string; deleted_at: string | null }
const PARENT: Parent = { id: '11111111-2222-4333-8444-555555555555', full_name: 'Test Parent', deleted_at: null }
const DELETED_PARENT: Parent = { ...PARENT, deleted_at: '2026-09-01T00:00:00Z' }

const CHILD_A: AdminChildSummary = {
  id: 'child-a', parent_person_id: PARENT.id, full_name: 'Test Child A', birth_date: '2018-03-01', gender: 'female',
  notes: 'Existing note A',
}
const CHILD_B: AdminChildSummary = {
  id: 'child-b', parent_person_id: PARENT.id, full_name: 'Test Child B', birth_date: null, gender: null,
  notes: null,
}

function setup(parent = PARENT, children: AdminChildSummary[] = [CHILD_A, CHILD_B]) {
  const user = userEvent.setup({ delay: null })
  render(<PersonChildrenSection parent={parent} initialChildren={children} />)
  return { user }
}

function rowFor(name: string): HTMLElement {
  return screen.getByText(name).closest('[data-testid="child-row"]') as HTMLElement
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('PersonChildrenSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockList.mockResolvedValue({ status: 'children', children: [CHILD_A, CHILD_B] })
  })

  it('renders the list with date-only birth date (no Date shift) and gender labels', () => {
    setup()
    expect(screen.getAllByTestId('child-row')).toHaveLength(2)
    const a = rowFor('Test Child A')
    expect(a).toHaveTextContent('2018-03-01')
    expect(a).toHaveTextContent('gender_female')
    expect(rowFor('Test Child B')).toHaveTextContent('—')
  })

  it('empty state when there are no children', () => {
    setup(PARENT, [])
    expect(screen.getByTestId('children-empty')).toHaveTextContent('empty')
  })

  it('add: calls createChild with the parent id + form values, then re-fetches the list', async () => {
    const created = { ...CHILD_B, id: 'child-new', full_name: 'Test Child New' }
    mockCreate.mockResolvedValue({ status: 'created', child: created })
    mockList.mockResolvedValue({ status: 'children', children: [CHILD_A, CHILD_B, created] })
    const { user } = setup()

    await user.click(screen.getByRole('button', { name: 'add_button' }))
    const form = screen.getByTestId('add-child-form')
    await user.type(within(form).getByRole('textbox', { name: /full_name_label/ }), 'Test Child New')
    await user.click(within(form).getByLabelText('gender_male'))
    await user.type(within(form).getByRole('textbox', { name: 'notes_label' }), 'note')
    await user.click(within(form).getByRole('button', { name: 'create_button' }))

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1))
    expect(mockCreate).toHaveBeenCalledWith({
      parentPersonId: PARENT.id,
      full_name: 'Test Child New',
      birth_date: null,
      gender: 'male',
      notes: 'note',
    })
    await waitFor(() => expect(mockList).toHaveBeenCalledWith(PARENT.id))
    expect(await screen.findByText('Test Child New')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('success.created Test Child New')
  })

  it('add: duplicate_warning is non-blocking — form closes, warning shown, list refreshed', async () => {
    mockCreate.mockResolvedValue({ status: 'duplicate_warning', child: { ...CHILD_A, id: 'child-dup' }, existing: [CHILD_A] })
    const { user } = setup()
    await user.click(screen.getByRole('button', { name: 'add_button' }))
    const form = screen.getByTestId('add-child-form')
    await user.type(within(form).getByRole('textbox', { name: /full_name_label/ }), 'Test Child A')
    await user.click(within(form).getByRole('button', { name: 'create_button' }))

    expect(await screen.findByRole('status')).toHaveTextContent('duplicate_warning Test Child A')
    expect(screen.queryByTestId('add-child-form')).not.toBeInTheDocument()
    expect(mockList).toHaveBeenCalledTimes(1)
  })

  it('add: validation_error shows field errors and keeps the form open', async () => {
    mockCreate.mockResolvedValue({ status: 'validation_error', field_errors: { birth_date: 'Birth date cannot be in the future' } })
    const { user } = setup()
    await user.click(screen.getByRole('button', { name: 'add_button' }))
    const form = screen.getByTestId('add-child-form')
    await user.type(within(form).getByRole('textbox', { name: /full_name_label/ }), 'X')
    await user.click(within(form).getByRole('button', { name: 'create_button' }))

    expect(await within(form).findByText('field_error.birth_date')).toBeInTheDocument()
    expect(mockList).not.toHaveBeenCalled()
  })

  it('edit: updateChild is called with ONLY the changed fields', async () => {
    mockUpdate.mockResolvedValue({ status: 'updated', child: { ...CHILD_A, full_name: 'Test Child A2' } })
    const { user } = setup()

    await user.click(within(rowFor('Test Child A')).getByRole('button', { name: 'edit_button_for Test Child A' }))
    const form = screen.getByTestId(`edit-child-${CHILD_A.id}-form`)
    const name = within(form).getByRole('textbox', { name: /full_name_label/ })
    expect(name).toHaveValue('Test Child A')
    await user.clear(name)
    await user.type(name, 'Test Child A2')
    await user.click(within(form).getByRole('button', { name: 'save_button' }))

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1))
    expect(mockUpdate).toHaveBeenCalledWith(CHILD_A.id, { full_name: 'Test Child A2' })
    await waitFor(() => expect(mockList).toHaveBeenCalledWith(PARENT.id))
  })

  it('row shows a compact notes snippet only when notes exist', () => {
    setup()
    expect(within(rowFor('Test Child A')).getByTestId('child-notes')).toHaveTextContent('notes_label: Existing note A')
    expect(within(rowFor('Test Child B')).queryByTestId('child-notes')).not.toBeInTheDocument()
  })

  it('edit: the notes textarea is prefilled with the existing notes', async () => {
    const { user } = setup()
    await user.click(within(rowFor('Test Child A')).getByRole('button', { name: 'edit_button_for Test Child A' }))
    const form = screen.getByTestId(`edit-child-${CHILD_A.id}-form`)
    expect(within(form).getByRole('textbox', { name: 'notes_label' })).toHaveValue('Existing note A')
  })

  it('edit: changing notes sends ONLY { notes } (trimmed)', async () => {
    mockUpdate.mockResolvedValue({ status: 'updated', child: { ...CHILD_A } })
    const { user } = setup()
    await user.click(within(rowFor('Test Child A')).getByRole('button', { name: 'edit_button_for Test Child A' }))
    const form = screen.getByTestId(`edit-child-${CHILD_A.id}-form`)
    const notes = within(form).getByRole('textbox', { name: 'notes_label' })
    await user.clear(notes)
    await user.type(notes, '  New note  ')
    await user.click(within(form).getByRole('button', { name: 'save_button' }))

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1))
    expect(mockUpdate).toHaveBeenCalledWith(CHILD_A.id, { notes: 'New note' })
    // Notes come back via the admin list refetch, not the notes-free update result.
    await waitFor(() => expect(mockList).toHaveBeenCalledWith(PARENT.id))
  })

  it('edit: clearing notes sends { notes: null }', async () => {
    mockUpdate.mockResolvedValue({ status: 'updated', child: { ...CHILD_A } })
    const { user } = setup()
    await user.click(within(rowFor('Test Child A')).getByRole('button', { name: 'edit_button_for Test Child A' }))
    const form = screen.getByTestId(`edit-child-${CHILD_A.id}-form`)
    await user.clear(within(form).getByRole('textbox', { name: 'notes_label' }))
    await user.click(within(form).getByRole('button', { name: 'save_button' }))

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1))
    expect(mockUpdate).toHaveBeenCalledWith(CHILD_A.id, { notes: null })
  })

  it('edit: a child with no notes, left untouched, sends no notes key', async () => {
    mockUpdate.mockResolvedValue({ status: 'updated', child: { ...CHILD_B, full_name: 'Test Child B2' } })
    const { user } = setup()
    await user.click(within(rowFor('Test Child B')).getByRole('button', { name: 'edit_button_for Test Child B' }))
    const form = screen.getByTestId(`edit-child-${CHILD_B.id}-form`)
    const name = within(form).getByRole('textbox', { name: /full_name_label/ })
    await user.clear(name)
    await user.type(name, 'Test Child B2')
    await user.click(within(form).getByRole('button', { name: 'save_button' }))

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1))
    expect(mockUpdate).toHaveBeenCalledWith(CHILD_B.id, { full_name: 'Test Child B2' })
  })

  it('edit: no changes → no updateChild call, form closes', async () => {
    const { user } = setup()
    await user.click(within(rowFor('Test Child A')).getByRole('button', { name: 'edit_button_for Test Child A' }))
    await user.click(within(screen.getByTestId(`edit-child-${CHILD_A.id}-form`)).getByRole('button', { name: 'save_button' }))
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(screen.queryByTestId(`edit-child-${CHILD_A.id}-form`)).not.toBeInTheDocument()
  })

  it('soft-delete: requires a confirm step, then calls softDeleteChild and re-fetches', async () => {
    mockSoftDelete.mockResolvedValue({ status: 'soft_deleted', id: CHILD_B.id })
    mockList.mockResolvedValue({ status: 'children', children: [CHILD_A] })
    const { user } = setup()

    await user.click(within(rowFor('Test Child B')).getByRole('button', { name: 'delete_button_for Test Child B' }))
    expect(mockSoftDelete).not.toHaveBeenCalled()
    const confirm = screen.getByRole('group', { name: 'delete_confirm.title' })
    expect(confirm).toHaveTextContent('delete_confirm.message Test Child B')
    await user.click(within(confirm).getByRole('button', { name: 'delete_confirm.confirm' }))

    await waitFor(() => expect(mockSoftDelete).toHaveBeenCalledWith(CHILD_B.id))
    await waitFor(() => expect(screen.queryByText('Test Child B')).not.toBeInTheDocument())
  })

  it('soft-delete: cancel in the confirm step does not delete', async () => {
    const { user } = setup()
    await user.click(within(rowFor('Test Child B')).getByRole('button', { name: 'delete_button_for Test Child B' }))
    await user.click(screen.getByRole('button', { name: 'delete_confirm.cancel' }))
    expect(mockSoftDelete).not.toHaveBeenCalled()
    expect(screen.queryByRole('group', { name: 'delete_confirm.title' })).not.toBeInTheDocument()
  })

  it('read-only when the parent is soft-deleted: children shown, no add/edit/delete controls', () => {
    setup(DELETED_PARENT)
    expect(screen.getAllByTestId('child-row')).toHaveLength(2)
    expect(screen.getByText('read_only_notice')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
