'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { createEvent, previewScheduleChange, updateEvent } from '@/lib/actions/events'
import { buildRRule, RRuleInput } from './RRuleBuilder'
import type {
  EventRow,
  ScheduleChangeRefusal,
  ScheduleChangeShape,
  UpdateEventInput,
} from '@/lib/actions/events.types'

type Props =
  | { mode: 'create'; initialData?: undefined; scheduleLocked?: undefined; isAdmin?: undefined }
  | {
      mode: 'edit'
      initialData: EventRow
      /** S9.5-T5.5: upcoming occurrences exist — start date/time/type/RRULE are read-only. */
      scheduleLocked?: boolean
      /**
       * S9.5-T5.5 P2: admins may still move the schedule of a locked event —
       * recurring: start time only; adhoc: start date + time — after a confirm
       * step. Organizers keep the Phase 1 lock.
       */
      isAdmin?: boolean
    }

type PendingScheduleChange = {
  input: UpdateEventInput
  shape: ScheduleChangeShape
  moved: number
  cancelledMoved: number
  toDate: string
  toTime: string
}

// Same cap as events_schedule_note(_id)_len (char_length = code points).
const SCHEDULE_NOTE_MAX = 160
const codePoints = (v: string) => [...v.trim()].length

type FieldErrors = Record<string, string>

const EVENT_TYPES = [
  'friday_monthly',
  'saturday_monthly',
  'sunday_monthly',
  'adhoc',
  'other_recurring',
] as const

type EventTypeKey = typeof EVENT_TYPES[number]

export function EventForm({ mode, initialData, scheduleLocked = false, isAdmin = false }: Props) {
  const t = useTranslations('admin.events.form')
  const tType = useTranslations('admin.events.type')
  const tSc = useTranslations('admin.events.form.schedule_change')
  const locale = useLocale()
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  // Derive initial raw RRULE for 'other_recurring' edits
  const initialRawRRule =
    mode === 'edit' && initialData.event_type === 'other_recurring'
      ? (initialData.recurrence_rule ?? '')
      : ''

  const [name, setName] = useState(mode === 'edit' ? initialData.name : '')
  const [nameId, setNameId] = useState(mode === 'edit' ? (initialData.name_id ?? '') : '')
  const [eventType, setEventType] = useState<string>(
    mode === 'edit' ? initialData.event_type : '',
  )
  const [startDate, setStartDate] = useState(mode === 'edit' ? initialData.start_date : '')
  const [startTime, setStartTime] = useState(
    mode === 'edit' ? initialData.start_time.slice(0, 5) : '',
  )
  const [durationMin, setDurationMin] = useState(
    mode === 'edit' ? String(initialData.duration_min) : '120',
  )
  const [location, setLocation] = useState(mode === 'edit' ? (initialData.location ?? '') : '')
  const [description, setDescription] = useState(
    mode === 'edit' ? (initialData.description ?? '') : '',
  )
  const [active, setActive] = useState(mode === 'edit' ? initialData.active : true)
  const [scheduleNote, setScheduleNote] = useState(
    mode === 'edit' ? (initialData.schedule_note ?? '') : '',
  )
  const [scheduleNoteId, setScheduleNoteId] = useState(
    mode === 'edit' ? (initialData.schedule_note_id ?? '') : '',
  )
  // Locked only applies to edits; create never has occurrences yet.
  const locked = mode === 'edit' && scheduleLocked
  // S9.5-T5.5 P2 editable-field matrix (locked event): admin + recurring →
  // start time; admin + adhoc → start date + time; organizer → nothing.
  const storedRecurring =
    mode === 'edit' && initialData.event_type !== 'adhoc' && initialData.recurrence_rule !== null
  const storedAdhoc =
    mode === 'edit' && initialData.event_type === 'adhoc' && initialData.recurrence_rule === null
  const adminMove: ScheduleChangeShape | null =
    locked && isAdmin ? (storedRecurring ? 'R' : storedAdhoc ? 'A' : null) : null
  const dateDisabled = locked && adminMove !== 'A'
  const timeDisabled = locked && adminMove === null
  const [rawRRule, setRawRRule] = useState(initialRawRRule)
  const [pending, setPending] = useState<PendingScheduleChange | null>(null)

  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)

  const refusalMessage = (reason: ScheduleChangeRefusal) => tSc(`errors.${reason}`)

  function formatWibDate(ymd: string): string {
    const [y, m, d] = ymd.split('-').map(Number)
    return new Intl.DateTimeFormat(locale === 'id' ? 'id-ID' : 'en-US', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
    }).format(new Date(Date.UTC(y, m - 1, d, 12)))
  }

  /** Save an edit; confirmScheduleChange only after the admin confirmed the move. */
  function saveEdit(updateInput: UpdateEventInput, confirmScheduleChange: boolean) {
    if (mode !== 'edit') return
    startTransition(async () => {
      const result = await updateEvent(
        initialData.id,
        updateInput,
        confirmScheduleChange ? { confirmScheduleChange: true } : undefined,
      )
      setPending(null)
      if (result.status === 'ok') {
        router.push(`/admin/events?updated=${result.event_id}`)
        return
      }
      if (result.status === 'invalid_input') {
        setFieldErrors({ [result.field]: result.message })
        return
      }
      setFormError(
        result.status === 'schedule_change_refused'
          ? refusalMessage(result.reason)
          : result.status === 'partial'
            ? tSc('partial')
            : result.status === 'schedule_locked'
              ? t('schedule_locked_banner')
              : result.status === 'forbidden'
                ? t('forbidden_banner')
                : t('error_banner'),
      )
    })
  }

  function validate(): FieldErrors {
    const errors: FieldErrors = {}
    if (!name.trim()) errors.name = t('field_error_name')
    if (!eventType) errors.event_type = t('field_error_type')
    if (!startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate))
      errors.start_date = t('field_error_date')
    if (!startTime || !/^\d{2}:\d{2}$/.test(startTime))
      errors.start_time = t('field_error_time')
    if (codePoints(scheduleNote) > SCHEDULE_NOTE_MAX)
      errors.schedule_note = t('field_error_note_too_long', { max: SCHEDULE_NOTE_MAX })
    if (codePoints(scheduleNoteId) > SCHEDULE_NOTE_MAX)
      errors.schedule_note_id = t('field_error_note_too_long', { max: SCHEDULE_NOTE_MAX })
    return errors
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const errors = validate()
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors)
      return
    }
    setFieldErrors({})
    setFormError(null)

    const recurrence_rule = buildRRule(eventType, rawRRule)

    const input = {
      name: name.trim(),
      name_id: nameId.trim() || null,
      event_type: eventType as EventTypeKey,
      start_date: startDate,
      start_time: startTime,
      duration_min: Number(durationMin) || 120,
      location: location.trim() || null,
      description: description.trim() || null,
      recurrence_rule,
      active,
      schedule_note: scheduleNote.trim() || null,
      schedule_note_id: scheduleNoteId.trim() || null,
    }

    startTransition(async () => {
      if (mode === 'create') {
        const result = await createEvent(input)
        if (result.status === 'ok') {
          router.push(
            `/admin/events?created=${result.event_id}&instances=${result.instances_created}`,
          )
          return
        }
        if (result.status === 'invalid_input') {
          setFieldErrors({ [result.field]: result.message })
          return
        }
        setFormError(
          result.status === 'forbidden' ? t('forbidden_banner') : t('error_banner'),
        )
      } else {
        // Locked: never send the four schedule fields, so a save can't trip
        // trg_events_schedule_lock even if a stored value isn't in the
        // canonical form the inputs would re-send (belt and braces — an
        // unchanged save re-sends identical values anyway).
        const updateInput: UpdateEventInput = { ...input }
        if (locked) {
          delete updateInput.event_type
          delete updateInput.start_date
          delete updateInput.start_time
          delete updateInput.recurrence_rule
        }

        // S9.5-T5.5 P2: admin moved the schedule of a locked event → preview,
        // then a confirm step; the save itself re-plans server-side.
        const timeChanged = startTime !== initialData.start_time.slice(0, 5)
        const dateChanged = startDate !== initialData.start_date
        const moving =
          (adminMove === 'R' && timeChanged) || (adminMove === 'A' && (timeChanged || dateChanged))
        if (!moving) {
          const result = await updateEvent(initialData.id, updateInput)
          if (result.status === 'ok') {
            router.push(`/admin/events?updated=${result.event_id}`)
            return
          }
          if (result.status === 'invalid_input') {
            setFieldErrors({ [result.field]: result.message })
            return
          }
          setFormError(
            result.status === 'schedule_locked'
              ? t('schedule_locked_banner')
              : result.status === 'forbidden'
                ? t('forbidden_banner')
                : t('error_banner'),
          )
          return
        }

        const scheduleInput: UpdateEventInput = {
          ...updateInput,
          start_time: startTime,
          ...(adminMove === 'A' && { start_date: startDate }),
        }
        const preview = await previewScheduleChange(initialData.id, {
          start_date: adminMove === 'A' ? startDate : initialData.start_date,
          start_time: startTime,
        })
        if (preview.status === 'ok') {
          setPending({
            input: scheduleInput,
            shape: preview.shape,
            moved: preview.moved,
            cancelledMoved: preview.cancelled_moved,
            toDate: preview.to_date,
            toTime: preview.to_time,
          })
          return
        }
        if (preview.status === 'refused') {
          setFormError(refusalMessage(preview.reason))
          return
        }
        if (preview.status === 'no_future_rows' || preview.status === 'unchanged') {
          // Nothing to move any more (e.g. the last session just started):
          // a plain save applies; the trigger stays the judge.
          saveEdit(scheduleInput, false)
          return
        }
        setFormError(t('error_banner'))
      }
    })
  }

  const isSubmitting = isPending

  return (
    <form onSubmit={handleSubmit} noValidate>
      {/* Top-of-form error banner */}
      {formError && (
        <div
          role="alert"
          className="mb-6 px-4 py-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700"
        >
          {formError}
        </div>
      )}

      <div className="space-y-5">
        {/* Name (EN) */}
        <div>
          <label htmlFor="name" className="block text-sm font-medium text-charcoal mb-1">
            {t('name_label')} <span className="text-red-500">*</span>
          </label>
          <input
            id="name"
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder={t('name_placeholder')}
            className={`w-full px-3 py-2 border rounded-lg text-sm text-charcoal bg-cream focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold transition-colors ${fieldErrors.name ? 'border-red-400' : 'border-line'}`}
            required
          />
          {fieldErrors.name && (
            <p className="mt-1 text-xs text-red-600" role="alert">
              {fieldErrors.name}
            </p>
          )}
        </div>

        {/* Name (ID) */}
        <div>
          <label htmlFor="name_id" className="block text-sm font-medium text-charcoal mb-1">
            {t('name_id_label')}
          </label>
          <input
            id="name_id"
            type="text"
            value={nameId}
            onChange={e => setNameId(e.target.value)}
            placeholder={t('name_id_placeholder')}
            className="w-full px-3 py-2 border border-line rounded-lg text-sm text-charcoal bg-cream focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold transition-colors"
          />
        </div>

        {/* S9.5-T5.5: schedule lock hint (P2: admin variants) */}
        {locked && (
          <div
            className="px-4 py-3 rounded-lg bg-cream-2 border border-line text-sm text-ink-2"
            data-testid="schedule-locked-hint"
          >
            <p>
              {adminMove === 'R'
                ? t('schedule_locked_hint_admin_recurring')
                : adminMove === 'A'
                  ? t('schedule_locked_hint_admin_adhoc')
                  : t('schedule_locked_hint')}
            </p>
            {!isAdmin && (
              <p className="mt-1 font-medium" data-testid="schedule-locked-contact-admin">
                {t('schedule_locked_contact_admin')}
              </p>
            )}
          </div>
        )}

        {/* Event type */}
        <div>
          <fieldset disabled={locked}>
            <legend className="block text-sm font-medium text-charcoal mb-2">
              {t('event_type_label')} <span className="text-red-500">*</span>
            </legend>
            <div className="grid grid-cols-2 gap-2">
              {EVENT_TYPES.map(type => (
                <label
                  key={type}
                  className={`flex items-center gap-2 px-3 py-2 border rounded-lg text-sm transition-colors ${locked ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'} ${
                    eventType === type
                      ? 'border-gold bg-gold/5 text-charcoal'
                      : 'border-line bg-cream text-charcoal hover:border-gold/50'
                  }`}
                >
                  <input
                    type="radio"
                    name="event_type"
                    value={type}
                    checked={eventType === type}
                    onChange={() => {
                      setEventType(type)
                      if (type !== 'other_recurring') setRawRRule('')
                    }}
                    className="accent-gold"
                  />
                  {tType(type)}
                </label>
              ))}
            </div>
            {fieldErrors.event_type && (
              <p className="mt-1 text-xs text-red-600" role="alert">
                {fieldErrors.event_type}
              </p>
            )}
          </fieldset>
        </div>

        {/* RRULE preview for non-adhoc preset types */}
        {eventType && eventType !== 'adhoc' && eventType !== 'other_recurring' && (
          <p className="text-xs text-muted bg-cream-2 border border-line rounded px-3 py-2 font-mono">
            {t('rrule_preview', { rule: buildRRule(eventType) ?? '' })}
          </p>
        )}

        {/* Raw RRULE input for other_recurring */}
        {eventType === 'other_recurring' && (
          <RRuleInput
            value={rawRRule}
            onChange={setRawRRule}
            error={fieldErrors.recurrence_rule}
            disabled={locked}
          />
        )}

        {/* Start date + time row */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="start_date" className="block text-sm font-medium text-charcoal mb-1">
              {t('start_date_label')} <span className="text-red-500">*</span>
            </label>
            <input
              id="start_date"
              type="date"
              value={startDate}
              onChange={e => setStartDate(e.target.value)}
              disabled={dateDisabled}
              className={`w-full px-3 py-2 border rounded-lg text-sm text-charcoal bg-cream focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold transition-colors ${fieldErrors.start_date ? 'border-red-400' : 'border-line'}`}
              required
            />
            {fieldErrors.start_date && (
              <p className="mt-1 text-xs text-red-600" role="alert">
                {fieldErrors.start_date}
              </p>
            )}
          </div>
          <div>
            <label htmlFor="start_time" className="block text-sm font-medium text-charcoal mb-1">
              {t('start_time_label')} <span className="text-red-500">*</span>
            </label>
            <input
              id="start_time"
              type="time"
              value={startTime}
              onChange={e => setStartTime(e.target.value)}
              disabled={timeDisabled}
              className={`w-full px-3 py-2 border rounded-lg text-sm text-charcoal bg-cream focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold transition-colors ${fieldErrors.start_time ? 'border-red-400' : 'border-line'}`}
              required
            />
            {fieldErrors.start_time && (
              <p className="mt-1 text-xs text-red-600" role="alert">
                {fieldErrors.start_time}
              </p>
            )}
          </div>
        </div>

        {/* Schedule notes (S9.5-T5.5) — public, always editable */}
        {([
          ['schedule_note', t('schedule_note_label'), scheduleNote, setScheduleNote],
          ['schedule_note_id', t('schedule_note_id_label'), scheduleNoteId, setScheduleNoteId],
        ] as const).map(([field, label, value, setValue]) => (
          <div key={field}>
            <div className="flex items-baseline justify-between mb-1">
              <label htmlFor={field} className="block text-sm font-medium text-charcoal">
                {label}
              </label>
              <span
                className={`text-xs ${codePoints(value) > SCHEDULE_NOTE_MAX ? 'text-red-600' : 'text-muted'}`}
                data-testid={`${field}-counter`}
                aria-live="polite"
              >
                {t('schedule_note_counter', { count: codePoints(value), max: SCHEDULE_NOTE_MAX })}
              </span>
            </div>
            <textarea
              id={field}
              rows={2}
              value={value}
              onChange={e => setValue(e.target.value)}
              aria-describedby={`${field}-help`}
              className={`w-full px-3 py-2 border rounded-lg text-sm text-charcoal bg-cream focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold transition-colors resize-none ${fieldErrors[field] ? 'border-red-400' : 'border-line'}`}
            />
            <p id={`${field}-help`} className="mt-1 text-xs text-muted">
              {t('schedule_note_help')}
            </p>
            {fieldErrors[field] && (
              <p className="mt-1 text-xs text-red-600" role="alert">
                {fieldErrors[field]}
              </p>
            )}
          </div>
        ))}

        {/* Duration */}
        <div>
          <label htmlFor="duration_min" className="block text-sm font-medium text-charcoal mb-1">
            {t('duration_label')}
          </label>
          <input
            id="duration_min"
            type="number"
            min="1"
            max="1440"
            value={durationMin}
            onChange={e => setDurationMin(e.target.value)}
            className="w-full px-3 py-2 border border-line rounded-lg text-sm text-charcoal bg-cream focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold transition-colors"
          />
        </div>

        {/* Location */}
        <div>
          <label htmlFor="location" className="block text-sm font-medium text-charcoal mb-1">
            {t('location_label')}
          </label>
          <input
            id="location"
            type="text"
            value={location}
            onChange={e => setLocation(e.target.value)}
            placeholder={t('location_placeholder')}
            className="w-full px-3 py-2 border border-line rounded-lg text-sm text-charcoal bg-cream focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold transition-colors"
          />
        </div>

        {/* Description */}
        <div>
          <label htmlFor="description" className="block text-sm font-medium text-charcoal mb-1">
            {t('description_label')}
          </label>
          <textarea
            id="description"
            rows={3}
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder={t('description_placeholder')}
            className="w-full px-3 py-2 border border-line rounded-lg text-sm text-charcoal bg-cream focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold transition-colors resize-none"
          />
        </div>

        {/* Active toggle */}
        <label className="flex items-center gap-3 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={active}
            onChange={e => setActive(e.target.checked)}
            className="rounded border-line accent-gold w-4 h-4"
          />
          <span className="text-sm font-medium text-charcoal">{t('active_label')}</span>
        </label>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3 mt-8">
        <button
          type="submit"
          disabled={isSubmitting}
          className="px-5 py-2.5 bg-gold text-cream rounded-lg text-sm font-semibold hover:bg-gold-dark transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {isSubmitting
            ? mode === 'create'
              ? t('submit_create_pending')
              : t('submit_update_pending')
            : mode === 'create'
              ? t('submit_create')
              : t('submit_update')}
        </button>
        <button
          type="button"
          onClick={() => router.push('/admin/events')}
          disabled={isSubmitting}
          className="px-5 py-2.5 border border-line text-charcoal rounded-lg text-sm font-medium hover:bg-cream-2 transition-colors disabled:opacity-60"
        >
          {t('cancel')}
        </button>
      </div>

      {/* S9.5-T5.5 P2: schedule-change confirm step */}
      {pending && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="schedule-change-title"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
        >
          <div className="bg-cream rounded-xl border border-line shadow-lg max-w-md w-full p-6">
            <h2
              id="schedule-change-title"
              className="font-heading text-xl font-semibold text-charcoal mb-3"
            >
              {tSc('confirm_title')}
            </h2>
            <p className="text-sm text-ink-2 mb-6" data-testid="schedule-change-confirm-body">
              {pending.shape === 'R'
                ? tSc('confirm_body_recurring', {
                    count: pending.moved,
                    time: pending.toTime,
                    cancelled: pending.cancelledMoved,
                  })
                : tSc('confirm_body_adhoc', {
                    date: formatWibDate(pending.toDate),
                    time: pending.toTime,
                  })}
            </p>
            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setPending(null)}
                disabled={isSubmitting}
                className="px-4 py-2 border border-line text-charcoal rounded-lg text-sm font-medium hover:bg-cream-2 transition-colors disabled:opacity-60"
              >
                {tSc('back')}
              </button>
              <button
                type="button"
                onClick={() => saveEdit(pending.input, true)}
                disabled={isSubmitting}
                className="px-4 py-2 bg-gold text-cream rounded-lg text-sm font-semibold hover:bg-gold-dark transition-colors disabled:opacity-60"
              >
                {isSubmitting ? t('submit_update_pending') : tSc('confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </form>
  )
}
