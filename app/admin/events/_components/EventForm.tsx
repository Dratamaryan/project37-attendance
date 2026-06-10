'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { createEvent, updateEvent } from '@/lib/actions/events'
import { buildRRule, RRuleInput } from './RRuleBuilder'
import type { EventRow } from '@/lib/actions/events.types'

type Props =
  | { mode: 'create'; initialData?: undefined }
  | { mode: 'edit'; initialData: EventRow }

type FieldErrors = Record<string, string>

const EVENT_TYPES = [
  'friday_monthly',
  'sunday_monthly',
  'adhoc',
  'other_recurring',
] as const

type EventTypeKey = typeof EVENT_TYPES[number]

export function EventForm({ mode, initialData }: Props) {
  const t = useTranslations('admin.events.form')
  const tType = useTranslations('admin.events.type')
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
  const [rawRRule, setRawRRule] = useState(initialRawRRule)

  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)

  function validate(): FieldErrors {
    const errors: FieldErrors = {}
    if (!name.trim()) errors.name = t('field_error_name')
    if (!eventType) errors.event_type = t('field_error_type')
    if (!startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate))
      errors.start_date = t('field_error_date')
    if (!startTime || !/^\d{2}:\d{2}$/.test(startTime))
      errors.start_time = t('field_error_time')
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
        const result = await updateEvent(initialData.id, input)
        if (result.status === 'ok') {
          router.push(`/admin/events?updated=${result.event_id}`)
          return
        }
        if (result.status === 'invalid_input') {
          setFieldErrors({ [result.field]: result.message })
          return
        }
        setFormError(
          result.status === 'forbidden' ? t('forbidden_banner') : t('error_banner'),
        )
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

        {/* Event type */}
        <div>
          <fieldset>
            <legend className="block text-sm font-medium text-charcoal mb-2">
              {t('event_type_label')} <span className="text-red-500">*</span>
            </legend>
            <div className="grid grid-cols-2 gap-2">
              {EVENT_TYPES.map(type => (
                <label
                  key={type}
                  className={`flex items-center gap-2 px-3 py-2 border rounded-lg cursor-pointer text-sm transition-colors ${
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
    </form>
  )
}
