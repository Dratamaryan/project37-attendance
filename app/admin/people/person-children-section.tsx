'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { createChild, updateChild, softDeleteChild, listChildrenByParentForAdmin } from '@/lib/actions/children'
import { formatDateOnly } from '@/lib/utils/date-display'
import type { AdminChildSummary, UpdateChildInput } from '@/lib/actions/children.types'

type Gender = 'male' | 'female' | null

type Props = {
  parent: { id: string; full_name: string; deleted_at: string | null }
  /** Fetched server-side by page.tsx via listChildrenByParentForAdmin (non-deleted, with notes). */
  initialChildren: AdminChildSummary[]
  /** True when the server-side initial fetch failed. */
  initialLoadFailed?: boolean
}

type Editing = { kind: 'none' } | { kind: 'add' } | { kind: 'edit'; childId: string }

type Notice = { kind: 'success' | 'warning' | 'error'; message: string } | null

type FormValues = { full_name: string; birth_date: string; gender: Gender; notes: string }

const FIELD_BASE = 'w-full px-3 py-2 text-sm bg-white border rounded-sm focus:outline-none focus:border-charcoal placeholder:text-muted transition-colors'
const FIELD_NORMAL = 'border-line'
const FIELD_ERROR = 'border-[#A85959] bg-[#FDF5F5]'

const NOTICE_CLASS: Record<NonNullable<Notice>['kind'], string> = {
  success: 'text-[#5C8A6B] bg-[#F0F6F1] border-[#D8E8DC]',
  warning: 'text-[#8B7635] bg-[#FBF6E8] border-[#F5EFD9]',
  error:   'text-[#A85959] bg-[#FDF5F5] border-[#F5D5D5]',
}

/**
 * S8-T4b: the parent's children on the admin person page — list, add, edit,
 * soft-delete. Rendered by page.tsx UNDER EditPersonForm and deliberately
 * separate from its reducer. Inherits the page's requireActiveAdmin gate; the
 * child actions are RLS-enforced regardless.
 *
 * After every mutation the list is re-fetched with listChildrenByParentForAdmin (not
 * router.refresh(): the list lives in client state seeded from a prop, which a
 * server re-render would not reset).
 *
 * Read-only when the parent is soft-deleted: children still shown, no controls.
 * Birth dates are rendered with formatDateOnly — never through `Date`.
 */
export function PersonChildrenSection({ parent, initialChildren, initialLoadFailed = false }: Props) {
  const t = useTranslations('admin.people.children')
  const [children, setChildren] = useState<AdminChildSummary[]>(initialChildren)
  const [loadFailed, setLoadFailed] = useState(initialLoadFailed)
  const [editing, setEditing] = useState<Editing>({ kind: 'none' })
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, boolean>>({})
  const [notice, setNotice] = useState<Notice>(null)
  const [isPending, startTransition] = useTransition()

  const readOnly = parent.deleted_at !== null

  async function reload() {
    const result = await listChildrenByParentForAdmin(parent.id)
    if (result.status === 'children') {
      setChildren(result.children)
      setLoadFailed(false)
    } else if (result.status === 'none') {
      setChildren([])
      setLoadFailed(false)
    } else {
      console.error('[person-children-section] reload failed:', result)
      setLoadFailed(true)
    }
  }

  function closeForm() {
    setEditing({ kind: 'none' })
    setFieldErrors({})
  }

  function openForm(next: Editing) {
    setEditing(next)
    setConfirmDeleteId(null)
    setFieldErrors({})
    setNotice(null)
  }

  function errorKeys(fieldErrorsFromServer: Record<string, string>): Record<string, boolean> {
    return Object.fromEntries(Object.keys(fieldErrorsFromServer).map((k) => [k, true]))
  }

  // ── Create ────────────────────────────────────────────────────────────────

  function handleCreate(values: FormValues) {
    if (!values.full_name.trim()) {
      setFieldErrors({ full_name: true })
      return
    }
    setNotice(null)
    startTransition(async () => {
      const result = await createChild({
        parentPersonId: parent.id,
        full_name:      values.full_name,
        birth_date:     values.birth_date || null,
        gender:         values.gender,
        notes:          values.notes.trim() || null,
      })
      switch (result.status) {
        case 'created':
          closeForm()
          setNotice({ kind: 'success', message: t('success.created', { name: result.child.full_name }) })
          await reload()
          break
        case 'duplicate_warning':
          // The row WAS created — advisory only, treated as success.
          closeForm()
          setNotice({ kind: 'warning', message: t('duplicate_warning', { name: result.child.full_name }) })
          await reload()
          break
        case 'validation_error':
          setFieldErrors(errorKeys(result.field_errors))
          break
        case 'parent_not_found':
          setNotice({ kind: 'error', message: t('error.parent_not_found') })
          break
        case 'forbidden':
          setNotice({ kind: 'error', message: t('error.forbidden') })
          break
        case 'error':
          console.error('[person-children-section] createChild failed:', result.message)
          setNotice({ kind: 'error', message: t('error.generic') })
          break
      }
    })
  }

  // ── Update ────────────────────────────────────────────────────────────────

  function handleUpdate(child: AdminChildSummary, values: FormValues) {
    const diff: UpdateChildInput = {}
    const name = values.full_name.trim()
    if (!name) {
      setFieldErrors({ full_name: true })
      return
    }
    if (name !== child.full_name)                        diff.full_name  = name
    if ((values.birth_date || null) !== child.birth_date) diff.birth_date = values.birth_date || null
    if (values.gender !== child.gender)                  diff.gender     = values.gender
    // Compare the raw textarea against the stored value so an untouched note is
    // never re-sent; when it did change, send it trimmed (empty → null).
    if (values.notes !== (child.notes ?? ''))            diff.notes      = values.notes.trim() || null

    if (Object.keys(diff).length === 0) {
      closeForm()
      return
    }
    setNotice(null)
    startTransition(async () => {
      const result = await updateChild(child.id, diff)
      switch (result.status) {
        case 'updated':
          closeForm()
          setNotice({ kind: 'success', message: t('success.updated', { name: result.child.full_name }) })
          await reload()
          break
        case 'validation_error':
          setFieldErrors(errorKeys(result.field_errors))
          break
        case 'not_found':
          closeForm()
          setNotice({ kind: 'error', message: t('error.not_found') })
          await reload()
          break
        case 'forbidden':
          setNotice({ kind: 'error', message: t('error.forbidden') })
          break
        case 'error':
          console.error('[person-children-section] updateChild failed:', result.message)
          setNotice({ kind: 'error', message: t('error.generic') })
          break
      }
    })
  }

  // ── Soft-delete ───────────────────────────────────────────────────────────

  function handleDeleteConfirm(child: AdminChildSummary) {
    setConfirmDeleteId(null)
    setNotice(null)
    startTransition(async () => {
      const result = await softDeleteChild(child.id)
      switch (result.status) {
        case 'soft_deleted':
          setNotice({ kind: 'success', message: t('success.deleted', { name: child.full_name }) })
          await reload()
          break
        case 'not_found':
          setNotice({ kind: 'error', message: t('error.not_found') })
          await reload()
          break
        case 'forbidden':
          setNotice({ kind: 'error', message: t('error.forbidden') })
          break
        case 'error':
          console.error('[person-children-section] softDeleteChild failed:', result.message)
          setNotice({ kind: 'error', message: t('error.generic') })
          break
      }
    })
  }

  const genderLabel = (g: Gender) => (g ? t(`gender_${g}`) : '—')

  return (
    <section data-testid="person-children-section" className="mt-10 pt-6 border-t border-line">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="text-xs font-semibold text-muted uppercase tracking-wider">{t('title')}</h2>
        {!readOnly && editing.kind === 'none' && (
          <button
            type="button"
            onClick={() => openForm({ kind: 'add' })}
            disabled={isPending}
            className="px-3 py-1.5 border border-line text-sm text-charcoal rounded-sm hover:bg-white transition-colors min-h-[36px] disabled:opacity-60"
          >
            {t('add_button')}
          </button>
        )}
      </div>

      {readOnly && (
        <p className="mb-3 text-xs text-muted italic">{t('read_only_notice')}</p>
      )}

      {notice && (
        <div role={notice.kind === 'error' ? 'alert' : 'status'} className={`mb-3 text-sm border rounded-sm px-3 py-2 ${NOTICE_CLASS[notice.kind]}`}>
          {notice.message}
        </div>
      )}

      {loadFailed && (
        <p role="alert" className="mb-3 text-sm text-[#A85959]">{t('error.load_failed')}</p>
      )}

      {editing.kind === 'add' && (
        <ChildForm
          idPrefix="add-child"
          initial={{ full_name: '', birth_date: '', gender: null, notes: '' }}
          submitLabel={t('create_button')}
          pendingLabel={t('create_button_pending')}
          pending={isPending}
          fieldErrors={fieldErrors}
          onClearFieldError={(f) => setFieldErrors((fe) => ({ ...fe, [f]: false }))}
          onSubmit={handleCreate}
          onCancel={closeForm}
        />
      )}

      {children.length === 0 && !loadFailed ? (
        <p data-testid="children-empty" className="text-sm text-muted">{t('empty')}</p>
      ) : (
        <ul className="divide-y divide-line border border-line rounded-sm bg-white">
          {children.map((child) => (
            <li key={child.id} data-testid="child-row" className="px-4 py-3">
              {editing.kind === 'edit' && editing.childId === child.id ? (
                <ChildForm
                  idPrefix={`edit-child-${child.id}`}
                  initial={{
                    full_name:  child.full_name,
                    birth_date: child.birth_date ?? '',
                    gender:     child.gender,
                    notes:      child.notes ?? '',
                  }}
                  submitLabel={t('save_button')}
                  pendingLabel={t('save_button_pending')}
                  pending={isPending}
                  fieldErrors={fieldErrors}
                  onClearFieldError={(f) => setFieldErrors((fe) => ({ ...fe, [f]: false }))}
                  onSubmit={(values) => handleUpdate(child, values)}
                  onCancel={closeForm}
                />
              ) : (
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-charcoal">{child.full_name}</p>
                    <p className="text-xs text-muted mt-0.5">
                      {t('birth_date_label')}: {child.birth_date ? formatDateOnly(child.birth_date) : '—'}
                      {' · '}
                      {t('gender_label')}: {genderLabel(child.gender)}
                    </p>
                    {child.notes && (
                      <p
                        data-testid="child-notes"
                        title={child.notes}
                        className="text-xs text-muted italic mt-0.5 truncate"
                      >
                        {t('notes_label')}: {child.notes}
                      </p>
                    )}
                  </div>

                  {!readOnly && editing.kind === 'none' && (
                    confirmDeleteId === child.id ? (
                      <div role="group" aria-label={t('delete_confirm.title')} className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-[#A85959]">
                          {t('delete_confirm.message', { name: child.full_name })}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleDeleteConfirm(child)}
                          disabled={isPending}
                          className="px-3 py-1.5 bg-[#A85959] text-white text-xs font-medium rounded-sm min-h-[36px] disabled:opacity-60"
                        >
                          {t('delete_confirm.confirm')}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          disabled={isPending}
                          className="px-3 py-1.5 border border-line text-xs text-charcoal rounded-sm min-h-[36px]"
                        >
                          {t('delete_confirm.cancel')}
                        </button>
                      </div>
                    ) : (
                      <div className="flex gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => openForm({ kind: 'edit', childId: child.id })}
                          disabled={isPending}
                          aria-label={t('edit_button_for', { name: child.full_name })}
                          className="px-3 py-1.5 border border-line text-xs text-charcoal rounded-sm hover:bg-cream-2 min-h-[36px] disabled:opacity-60"
                        >
                          {t('edit_button')}
                        </button>
                        <button
                          type="button"
                          onClick={() => { setConfirmDeleteId(child.id); setNotice(null) }}
                          disabled={isPending}
                          aria-label={t('delete_button_for', { name: child.full_name })}
                          className="px-3 py-1.5 border border-[#F5D5D5] text-xs text-[#A85959] rounded-sm hover:bg-[#FDF5F5] min-h-[36px] disabled:opacity-60"
                        >
                          {t('delete_button')}
                        </button>
                      </div>
                    )
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// ── Inline add/edit form ──────────────────────────────────────────────────────

type ChildFormProps = {
  idPrefix: string
  initial: FormValues
  submitLabel: string
  pendingLabel: string
  pending: boolean
  fieldErrors: Record<string, boolean>
  onClearFieldError: (field: string) => void
  onSubmit: (values: FormValues) => void
  onCancel: () => void
}

function ChildForm({
  idPrefix,
  initial,
  submitLabel,
  pendingLabel,
  pending,
  fieldErrors,
  onClearFieldError,
  onSubmit,
  onCancel,
}: ChildFormProps) {
  const t = useTranslations('admin.people.children')
  const [values, setValues] = useState<FormValues>(initial)

  const fieldClass = (f: string) => `${FIELD_BASE} ${fieldErrors[f] ? FIELD_ERROR : FIELD_NORMAL}`

  function set<K extends keyof FormValues>(field: K, value: FormValues[K]) {
    setValues((v) => ({ ...v, [field]: value }))
    onClearFieldError(field)
  }

  return (
    <form
      data-testid={`${idPrefix}-form`}
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        if (!pending) onSubmit(values)
      }}
      className="mb-3 p-4 bg-cream-2 border border-line rounded-sm space-y-4"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={`${idPrefix}-full-name`} className="block text-xs font-medium text-charcoal mb-1">
            {t('full_name_label')} <span className="text-[#A85959]">*</span>
          </label>
          <input
            id={`${idPrefix}-full-name`}
            type="text"
            value={values.full_name}
            onChange={(e) => set('full_name', e.target.value)}
            placeholder={t('full_name_placeholder')}
            className={fieldClass('full_name')}
            aria-required="true"
            aria-invalid={!!fieldErrors.full_name}
          />
          {fieldErrors.full_name && <p className="text-xs text-[#A85959] mt-1">{t('field_error.full_name')}</p>}
        </div>
        <div className="min-w-0">
          <label htmlFor={`${idPrefix}-birth-date`} className="block text-xs font-medium text-charcoal mb-1">
            {t('birth_date_label')}
          </label>
          {/* No `max`: the server validates against today in Asia/Jakarta;
              toISOString() here would be the UTC date. */}
          <input
            id={`${idPrefix}-birth-date`}
            type="date"
            value={values.birth_date}
            onChange={(e) => set('birth_date', e.target.value)}
            min="1900-01-01"
            className={fieldClass('birth_date')}
            aria-invalid={!!fieldErrors.birth_date}
          />
          {fieldErrors.birth_date && <p className="text-xs text-[#A85959] mt-1">{t('field_error.birth_date')}</p>}
        </div>
      </div>

      <fieldset>
        <legend className="text-xs font-medium text-charcoal mb-2">{t('gender_label')}</legend>
        <div className="flex flex-wrap gap-3">
          {(['male', 'female', null] as const).map((val) => {
            const id = `${idPrefix}-gender-${val ?? 'null'}`
            return (
              <label key={id} htmlFor={id} className="flex items-center gap-1.5 text-sm text-ink-2 cursor-pointer">
                <input
                  type="radio"
                  name={`${idPrefix}-gender`}
                  id={id}
                  checked={values.gender === val}
                  onChange={() => set('gender', val)}
                  className="accent-charcoal"
                />
                {t(`gender_${val ?? 'unspecified'}`)}
              </label>
            )
          })}
        </div>
        {fieldErrors.gender && <p className="text-xs text-[#A85959] mt-1">{t('field_error.gender')}</p>}
      </fieldset>

      <div>
        <label htmlFor={`${idPrefix}-notes`} className="block text-xs font-medium text-charcoal mb-1">
          {t('notes_label')}
        </label>
        <textarea
          id={`${idPrefix}-notes`}
          value={values.notes}
          onChange={(e) => set('notes', e.target.value)}
          placeholder={t('notes_placeholder')}
          rows={2}
          aria-describedby={`${idPrefix}-notes-help`}
          className={`${FIELD_BASE} ${FIELD_NORMAL}`}
        />
        <p id={`${idPrefix}-notes-help`} className="text-xs text-muted mt-1">{t('notes_help')}</p>
      </div>

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending}
          className="px-4 py-2 bg-charcoal text-cream text-sm font-medium rounded-sm hover:bg-ink-2 transition-colors min-h-[36px] disabled:opacity-60"
        >
          {pending ? pendingLabel : submitLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className="px-4 py-2 border border-line text-sm text-charcoal rounded-sm hover:bg-white transition-colors min-h-[36px] disabled:opacity-60"
        >
          {t('cancel_button')}
        </button>
      </div>
    </form>
  )
}
