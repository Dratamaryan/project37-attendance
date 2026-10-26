'use client'

import { useActionState, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import {
  RSVP_CHILDREN_MAX,
  RSVP_CHILDREN_MIN,
  RSVP_INITIAL_STATE,
  RSVP_PUBLIC_STATUSES,
  type RsvpFieldErrors,
  type RsvpFormState,
  type RsvpPublicStatus,
} from '@/lib/rsvp/public.types'
import { RsvpNotAvailable } from './rsvp-not-available'
import { TurnstileWidget } from './turnstile-widget'

type Props = {
  /** submitRsvp with the token bound by the page. */
  action: (prevState: RsvpFormState, formData: FormData) => Promise<RsvpFormState>
  /** S9-R4: the Turnstile site key when RSVP_TURNSTILE_ENABLED is on, else null (no widget). */
  turnstileSiteKey?: string | null
}

const STATUS_LABEL_KEY: Record<RsvpPublicStatus, string> = {
  coming: 'form.status_coming',
  maybe: 'form.status_maybe',
  not_coming: 'form.status_not_coming',
}

const CHILDREN_OPTIONS = Array.from(
  { length: RSVP_CHILDREN_MAX - RSVP_CHILDREN_MIN + 1 },
  (_, i) => String(RSVP_CHILDREN_MIN + i),
)

const FIELD_CLASSES =
  'w-full min-h-[44px] px-3 py-2 text-base bg-white border rounded-sm focus:outline-none focus:border-charcoal placeholder:text-muted'
const FIELD_NORMAL = 'border-line'
const FIELD_ERROR = 'border-[#A85959] bg-[#FDF5F5]'
const BANNER_CLASSES =
  'text-sm text-[#A85959] bg-[#FDF5F5] border border-[#F5D5D5] rounded-sm px-3 py-2'
const CHOICE_CLASSES =
  'flex items-center gap-2 min-h-[44px] px-3 border rounded-sm text-sm text-ink-2 cursor-pointer has-[:checked]:border-charcoal has-[:checked]:bg-white'

function FieldError({ id, message }: { id: string; message: string | null }) {
  if (!message) return null
  return (
    <p id={id} role="alert" className="text-xs text-[#A85959] mt-1">
      {message}
    </p>
  )
}

export function RsvpForm({ action, turnstileSiteKey = null }: Props) {
  const t = useTranslations('rsvp')
  const [state, formAction, isPending] = useActionState(action, RSVP_INITIAL_STATE)

  // Controlled fields: React's post-action form reset only clears uncontrolled
  // inputs, so the visitor's answers survive an error and "Change my answer".
  const [status, setStatus] = useState<RsvpPublicStatus | null>(null)
  const [phone, setPhone] = useState('')
  const [name, setName] = useState('')
  const [bringing, setBringing] = useState<'no' | 'yes'>('no')
  const [childrenCount, setChildrenCount] = useState(CHILDREN_OPTIONS[0])
  const [consent, setConsent] = useState(false)
  // The success state the visitor chose to edit — a NEW success (a fresh
  // object from the next submit) shows the thank-you view again.
  const [dismissedSuccess, setDismissedSuccess] = useState<RsvpFormState | null>(null)
  // Single-use Turnstile token; the widget clears it on expiry/error and when
  // `state` changes (every non-success result — success unmounts the form).
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)
  const awaitingTurnstile = turnstileSiteKey !== null && turnstileToken === null
  const [turnstileUnavailable, setTurnstileUnavailable] = useState(false)

  if (state.kind === 'closed') {
    return <RsvpNotAvailable title={t('closed.title')} body={t('closed.body')} headingLevel={2} />
  }

  if (state.kind === 'success' && state !== dismissedSuccess) {
    return (
      <div className="rounded-2xl bg-cream-2 border border-line p-6" data-testid="rsvp-success">
        <h2 className="font-heading text-2xl font-semibold text-charcoal mb-2">{t('success.title')}</h2>
        <p className="text-sm text-ink-2 mb-4">{t('success.body')}</p>
        <ul className="text-sm text-charcoal space-y-1 mb-6">
          <li>{t('success.recap_status', { status: t(STATUS_LABEL_KEY[state.status]) })}</li>
          {state.status !== 'not_coming' && (
            <li>
              {state.children > 0
                ? t('success.recap_children', { count: state.children })
                : t('success.recap_no_children')}
            </li>
          )}
        </ul>
        <button
          type="button"
          onClick={() => {
            setDismissedSuccess(state)
            // The token behind this success is spent; the remounted widget issues a new one.
            setTurnstileToken(null)
          }}
          className="w-full min-h-[44px] py-3 border border-line text-sm text-charcoal rounded-sm hover:bg-white transition-colors"
        >
          {t('success.edit')}
        </button>
      </div>
    )
  }

  const errors: RsvpFieldErrors = state.kind === 'invalid' ? state.fieldErrors : {}
  const fieldClass = (hasError: boolean) => `${FIELD_CLASSES} ${hasError ? FIELD_ERROR : FIELD_NORMAL}`

  return (
    <form action={formAction} noValidate className="space-y-6" data-testid="rsvp-form">
      <h2 className="font-heading text-2xl font-semibold text-charcoal">{t('form.title')}</h2>

      {state.kind === 'invalid' && (
        <div role="alert" className={BANNER_CLASSES}>{t('errors.invalid_summary')}</div>
      )}
      {state.kind === 'limit' && <div role="alert" className={BANNER_CLASSES}>{t('errors.limit')}</div>}
      {state.kind === 'unavailable' && (
        <div role="alert" className={BANNER_CLASSES}>{t('errors.unavailable')}</div>
      )}
      {state.kind === 'error' && <div role="alert" className={BANNER_CLASSES}>{t('errors.generic')}</div>}

      {/* Honeypot (S9-R4): off-screen rather than display:none or sr-only, so
          naive bots still fill it while people and screen readers never meet it. */}
      <div aria-hidden="true" className="absolute -left-[10000px] top-auto w-px h-px overflow-hidden">
        <input type="text" name="website" tabIndex={-1} autoComplete="off" />
      </div>

      {/* Status */}
      <fieldset aria-describedby={errors.status ? 'rsvp-status-error' : undefined}>
        <legend className="block text-xs font-medium text-charcoal mb-2">
          {t('form.status_label')}
          <span className="text-[#A85959] ml-0.5">*</span>
        </legend>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {RSVP_PUBLIC_STATUSES.map((value) => (
            <label
              key={value}
              className={`${CHOICE_CLASSES} ${errors.status ? 'border-[#A85959]' : 'border-line'}`}
            >
              <input
                type="radio"
                name="status"
                value={value}
                checked={status === value}
                onChange={() => setStatus(value)}
                className="accent-charcoal"
              />
              {t(STATUS_LABEL_KEY[value])}
            </label>
          ))}
        </div>
        <FieldError id="rsvp-status-error" message={errors.status ? t('errors.status_required') : null} />
      </fieldset>

      {/* Phone */}
      <div>
        <label htmlFor="rsvp-phone" className="block text-xs font-medium text-charcoal mb-1">
          {t('form.phone_label')}
          <span className="text-[#A85959] ml-0.5">*</span>
        </label>
        <input
          id="rsvp-phone"
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder={t('form.phone_placeholder')}
          aria-required="true"
          aria-invalid={!!errors.phone}
          aria-describedby={errors.phone ? 'rsvp-phone-help rsvp-phone-error' : 'rsvp-phone-help'}
          className={fieldClass(!!errors.phone)}
        />
        <p id="rsvp-phone-help" className="text-xs text-muted mt-1">{t('form.phone_help')}</p>
        <FieldError id="rsvp-phone-error" message={errors.phone ? t(`errors.phone_${errors.phone}`) : null} />
      </div>

      {/* Name — same field and wording for everyone (no roster echo). */}
      <div>
        <label htmlFor="rsvp-name" className="block text-xs font-medium text-charcoal mb-1">
          {t('form.name_label')} <span className="text-muted font-normal">{t('form.name_optional')}</span>
        </label>
        <input
          id="rsvp-name"
          name="name"
          type="text"
          autoComplete="name"
          maxLength={200}
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={!!errors.name}
          aria-describedby={errors.name ? 'rsvp-name-help rsvp-name-error' : 'rsvp-name-help'}
          className={fieldClass(!!errors.name)}
        />
        <p id="rsvp-name-help" className="text-xs text-muted mt-1">{t('form.name_help')}</p>
        <FieldError id="rsvp-name-error" message={errors.name ? t('errors.name_too_long') : null} />
      </div>

      {/* Children — irrelevant (and not submitted) when not attending. */}
      {status !== 'not_coming' && (
        <fieldset data-testid="rsvp-children">
          <legend className="block text-xs font-medium text-charcoal mb-2">{t('form.children_label')}</legend>
          <div className="grid grid-cols-2 gap-2">
            {(['no', 'yes'] as const).map((value) => (
              <label key={value} className={`${CHOICE_CLASSES} border-line`}>
                <input
                  type="radio"
                  name="bringing_children"
                  value={value}
                  checked={bringing === value}
                  onChange={() => setBringing(value)}
                  className="accent-charcoal"
                />
                {value === 'yes' ? t('form.children_yes') : t('form.children_no')}
              </label>
            ))}
          </div>
          {bringing === 'yes' && (
            <div className="mt-3">
              <label htmlFor="rsvp-children-count" className="block text-xs font-medium text-charcoal mb-1">
                {t('form.children_count_label')}
              </label>
              <select
                id="rsvp-children-count"
                name="children_count"
                value={childrenCount}
                onChange={(e) => setChildrenCount(e.target.value)}
                aria-invalid={!!errors.children}
                aria-describedby={errors.children ? 'rsvp-children-error' : undefined}
                className={`${fieldClass(!!errors.children)} sm:w-32`}
              >
                {CHILDREN_OPTIONS.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </div>
          )}
          <FieldError
            id="rsvp-children-error"
            message={errors.children ? t(`errors.children_${errors.children}`) : null}
          />
        </fieldset>
      )}

      {/* Follow-up consent — per-submission only. The policy link opens in a
          new tab: the form is controlled state, so navigating away would lose it. */}
      <div className="flex items-start gap-3">
        <input
          id="rsvp-consent"
          name="followup_consent"
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          className="mt-1 h-5 w-5 flex-shrink-0 rounded border-line accent-charcoal"
        />
        <div>
          <label htmlFor="rsvp-consent" className="text-sm text-ink-2 cursor-pointer leading-snug">
            {t('form.consent_label')}
          </label>
          <p className="text-xs mt-1">
            <Link
              href="/privacy"
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted underline underline-offset-2 hover:text-charcoal"
            >
              {t('form.privacy_link')}
            </Link>
          </p>
        </div>
      </div>

      {turnstileSiteKey !== null && (
        <>
          <TurnstileWidget
            siteKey={turnstileSiteKey}
            onToken={setTurnstileToken}
            resetSignal={state}
            onUnavailable={setTurnstileUnavailable}
          />
          <input type="hidden" name="cf-turnstile-response" value={turnstileToken ?? ''} />
        </>
      )}

      <button
        type="submit"
        disabled={isPending || awaitingTurnstile}
        className="w-full min-h-[44px] py-3 bg-charcoal text-cream text-sm font-medium rounded-sm hover:bg-ink-2 active:translate-y-px transition-all disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {isPending ? t('form.submit_pending') : awaitingTurnstile ? t('form.submit_verifying') : t('form.submit')}
      </button>
      {/* Still fail-closed: the note only explains why submit stays disabled. */}
      {turnstileSiteKey !== null && turnstileUnavailable && (
        <p role="status" className="text-xs text-[#A85959] -mt-3" data-testid="rsvp-turnstile-unavailable">
          {t('form.turnstile_unavailable')}
        </p>
      )}
    </form>
  )
}
