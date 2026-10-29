'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { formatJakarta } from '@/lib/events/timezone'
import { getOrCreateRsvpLink, deactivateRsvpLink, deleteRsvp } from '@/lib/rsvp/admin'
import { RSVP_DISPLAY_BUCKETS, type RsvpPanel as RsvpPanelData, type RsvpPanelRow } from '@/lib/rsvp/admin.types'

type ShareLang = 'id' | 'en'

type Props = {
  instanceId: string
  /** event_instances.status — a new link is only offered for 'scheduled'. */
  instanceStatus: string
  panel: RsvpPanelData
  /**
   * Both share URLs, built server-side by the page (buildWhatsAppShareUrl)
   * independent of the UI locale; null when there's no shareable URL.
   */
  whatsAppUrls: Record<ShareLang, string> | null
}

const TIME = 'yyyy-MM-dd HH:mm'

/**
 * S9-R3: RSVP link lifecycle, totals, RSVP-vs-check-in cross-tab and the
 * response list on the admin instance page. Read data arrives from the page
 * (impl_getInstanceRsvpPanel); after every action the page is re-rendered with
 * router.refresh() — the panel holds no copy of server state beyond the
 * transient notice and confirm targets.
 */
export function RsvpPanel({ instanceId, instanceStatus, panel, whatsAppUrls }: Props) {
  const t = useTranslations('admin.events.instance.rsvp')
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [confirmDeactivate, setConfirmDeactivate] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  // Per-viewer share-language choice — Indonesian by default, not persisted.
  const [shareLang, setShareLang] = useState<ShareLang>('id')
  const [isPending, startTransition] = useTransition()

  const { link, publicEnabled, totals, buckets, children, rows } = panel

  function handleGetLink() {
    setError(null)
    startTransition(async () => {
      const result = await getOrCreateRsvpLink(instanceId)
      if (result.status === 'ok') {
        router.refresh()
        return
      }
      if (result.status === 'closed') setError(t('error_closed'))
      else if (result.status === 'misconfigured') setError(t('error_misconfigured'))
      else if (result.status === 'not_found') setError(t('error_not_found'))
      else if (result.status === 'disabled') setError(t('not_live'))
      else setError(t('error_generic'))
    })
  }

  function handleDeactivate() {
    setError(null)
    startTransition(async () => {
      const result = await deactivateRsvpLink(instanceId)
      setConfirmDeactivate(false)
      if (result.status === 'ok' || result.status === 'no_link') {
        router.refresh()
        return
      }
      setError(t('error_generic'))
    })
  }

  function handleDelete(rsvpId: string) {
    setError(null)
    startTransition(async () => {
      const result = await deleteRsvp(rsvpId)
      setConfirmDeleteId(null)
      if (result.status === 'ok' || result.status === 'not_found') {
        router.refresh()
        return
      }
      setError(t('error_generic'))
    })
  }

  async function handleCopy(url: string) {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard API unavailable/denied — the readonly, selectable URL field
      // is the fallback (NoEmailList pattern), no error UI needed.
    }
  }

  function displayName(row: RsvpPanelRow): string {
    if (row.display_kind === 'removed_member') return t('list.removed_member')
    // Members keep their roster name after an RSVP scrub; only a newcomer's
    // typed name is gone, so only that fallback changes.
    return row.display_name ?? t(row.anonymized ? 'list.anonymized' : 'list.no_name')
  }

  return (
    <section data-testid="rsvp-panel" aria-labelledby="rsvp-panel-title" className="mt-10 pt-6 border-t border-line">
      <h2 id="rsvp-panel-title" className="font-heading text-xl font-semibold text-charcoal mb-4">
        {t('title')}
      </h2>

      {error && (
        <p role="alert" className="text-sm text-red-600 mb-4">{error}</p>
      )}

      {/* Link */}
      <div data-testid="rsvp-link-section" className="mb-8 p-4 bg-white border border-line rounded-[4px]">
        <h3 className="text-xs font-semibold text-muted uppercase tracking-wider mb-3">{t('link_title')}</h3>
        {!publicEnabled ? (
          <p data-testid="rsvp-not-live" className="text-sm text-muted italic">{t('not_live')}</p>
        ) : link.active && link.url ? (
          <div className="space-y-3">
            <label htmlFor="rsvp-link-url" className="block text-sm font-medium text-charcoal">{t('link_label')}</label>
            <input
              id="rsvp-link-url"
              type="text"
              readOnly
              value={link.url}
              onFocus={e => e.currentTarget.select()}
              data-testid="rsvp-link-url"
              className="w-full px-3 py-2 border border-line rounded-[4px] bg-cream text-sm font-mono text-charcoal"
            />
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => handleCopy(link.url!)}
                data-testid="rsvp-copy-button"
                className="text-sm font-medium text-cream bg-gold hover:bg-gold-dark transition-colors rounded-sm px-3 py-1.5"
              >
                {copied ? t('copied') : t('copy_button')}
              </button>
              {whatsAppUrls && (
                <span className="inline-flex items-center gap-1.5">
                  <a
                    href={whatsAppUrls[shareLang]}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="rsvp-whatsapp-link"
                    className="text-sm font-medium text-charcoal border border-line rounded-sm px-3 py-1.5 hover:bg-cream-2 transition-colors"
                  >
                    {t('share_whatsapp')}
                  </a>
                  <span role="group" aria-label={t('whatsapp_lang_label')} className="inline-flex items-center text-xs text-muted">
                    {(['id', 'en'] as const).map((lang, i) => (
                      <span key={lang} className="inline-flex items-center">
                        {i > 0 && <span aria-hidden="true" className="px-0.5">·</span>}
                        <button
                          type="button"
                          onClick={() => setShareLang(lang)}
                          aria-pressed={shareLang === lang}
                          data-testid={`rsvp-whatsapp-lang-${lang}`}
                          className={`px-1 py-0.5 rounded-sm ${shareLang === lang ? 'font-semibold text-charcoal underline' : 'hover:text-charcoal'}`}
                        >
                          {t(`whatsapp_lang_${lang}`)}
                        </button>
                      </span>
                    ))}
                  </span>
                </span>
              )}
              {confirmDeactivate ? (
                <div role="group" aria-label={t('deactivate_confirm.title')} className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-[#A85959]">{t('deactivate_confirm.message')}</span>
                  <button
                    type="button"
                    onClick={handleDeactivate}
                    disabled={isPending}
                    data-testid="rsvp-deactivate-confirm"
                    className="px-3 py-1.5 bg-[#A85959] text-white text-xs font-medium rounded-sm min-h-[36px] disabled:opacity-60"
                  >
                    {t('deactivate_confirm.confirm')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDeactivate(false)}
                    disabled={isPending}
                    className="px-3 py-1.5 border border-line text-xs text-charcoal rounded-sm min-h-[36px]"
                  >
                    {t('deactivate_confirm.cancel')}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDeactivate(true)}
                  disabled={isPending}
                  data-testid="rsvp-deactivate-button"
                  className="text-sm font-medium text-red-700 border border-red-300 bg-red-50 rounded-sm px-3 py-1.5 hover:bg-red-100 transition-colors disabled:opacity-60"
                >
                  {t('deactivate_button')}
                </button>
              )}
            </div>
          </div>
        ) : link.active ? (
          // Active link but no buildable URL — NEXT_PUBLIC_APP_URL is bad.
          <p role="alert" className="text-sm text-red-600">{t('error_misconfigured')}</p>
        ) : instanceStatus !== 'scheduled' ? (
          <p data-testid="rsvp-scheduled-only" className="text-sm text-muted italic">{t('link_scheduled_only')}</p>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted">{t('link_inactive')}</p>
            <button
              type="button"
              onClick={handleGetLink}
              disabled={isPending}
              data-testid="rsvp-get-link-button"
              className="text-sm font-medium text-cream bg-gold hover:bg-gold-dark transition-colors rounded-sm px-3 py-1.5 disabled:opacity-60"
            >
              {isPending ? t('getting_link') : t('get_link_button')}
            </button>
          </div>
        )}
      </div>

      {/* Totals */}
      <div data-testid="rsvp-totals" className="mb-8">
        <h3 className="text-xs font-semibold text-muted uppercase tracking-wider mb-3">{t('totals.title')}</h3>
        <p className="text-sm text-muted">{t('totals.coming_headcount')}</p>
        <p data-testid="rsvp-coming-headcount" className="font-heading text-3xl font-semibold text-charcoal tabular-nums">
          {totals.coming_headcount}
        </p>
        <p data-testid="rsvp-coming-detail" className="text-sm text-muted tabular-nums mt-1">
          {t('totals.coming_detail', { people: totals.coming_people, children: totals.coming_children })}
        </p>
      </div>

      {/* Cross-tab */}
      <div data-testid="rsvp-crosstab" className="mb-8">
        <h3 className="text-xs font-semibold text-muted uppercase tracking-wider mb-3">{t('crosstab.title')}</h3>
        <div className="overflow-x-auto bg-white border border-line rounded-[4px]">
          <table className="min-w-full divide-y divide-line">
            <thead>
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium text-muted">{t('crosstab.bucket')}</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-muted">{t('crosstab.count')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {RSVP_DISPLAY_BUCKETS.map(b => (
                <tr key={b} data-testid={`rsvp-bucket-${b}`}>
                  <td className="px-3 py-1.5 text-sm text-charcoal">{t(`crosstab.buckets.${b}`)}</td>
                  <td className="px-3 py-1.5 text-sm text-charcoal text-right tabular-nums">{buckets[b]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p data-testid="rsvp-children-check" className="text-sm text-muted tabular-nums mt-2">
          {t('crosstab.children', { expected: String(children.expected), checked_in: String(children.checked_in) })}
        </p>
      </div>

      {/* List */}
      <div>
        <div className="flex items-center justify-between gap-3 mb-3">
          <h3 className="text-xs font-semibold text-muted uppercase tracking-wider">
            {t('list.title')} <span className="tabular-nums">· {rows.length}</span>
          </h3>
          <a
            href={`/api/admin/export/instance/${instanceId}/rsvp`}
            data-testid="rsvp-export-link"
            className="text-sm font-medium text-cream bg-gold hover:bg-gold-dark transition-colors rounded-sm px-3 py-1.5 flex-shrink-0"
          >
            {t('export_button')}
          </a>
        </div>
        {rows.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted italic text-center bg-white border border-line rounded-[4px]">
            {t('list.empty')}
          </p>
        ) : (
          <ul className="bg-white border border-line rounded-[4px]">
            {rows.map(row => {
              const updated = new Date(row.updated_at).getTime() !== new Date(row.created_at).getTime()
              return (
                <li
                  key={row.rsvp_id}
                  data-testid="rsvp-row"
                  className="px-4 py-3 flex flex-wrap items-start gap-3 border-b border-line last:border-0"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-ink-2 leading-tight flex items-center gap-1.5 flex-wrap">
                      <span data-testid="rsvp-row-name">{displayName(row)}</span>
                      {row.display_kind === 'member' && (
                        <span className="inline-block px-1.5 py-px bg-cream-2 text-charcoal text-[10px] font-semibold uppercase tracking-wide rounded-sm">
                          {t('list.badge_member')}
                        </span>
                      )}
                      {row.display_kind === 'newcomer' && (
                        <span className="inline-block px-1.5 py-px bg-gold-light text-gold-dark text-[10px] font-semibold uppercase tracking-wide rounded-sm">
                          {t('list.badge_newcomer')}
                        </span>
                      )}
                      {row.attended && (
                        <span data-testid="rsvp-row-attended" className="text-xs text-[#5C8A6B] font-normal">
                          ✓ {t('list.attended')}
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-muted mt-0.5">
                      {t(`list.status.${row.status}`)}
                      {' · '}{t('list.children', { count: row.children_count })}
                      {row.followup_consent && !row.anonymized && <> · {t('list.followup_yes')}</>}
                      {' · '}<span className="font-mono">{row.phone_masked ?? t('list.no_phone')}</span>
                    </p>
                    <p className="text-xs text-muted mt-0.5 tabular-nums">
                      {t('list.submitted', { time: formatJakarta(new Date(row.created_at), TIME) })}
                      {updated && <> · {t('list.updated', { time: formatJakarta(new Date(row.updated_at), TIME) })}</>}
                    </p>
                  </div>

                  {confirmDeleteId === row.rsvp_id ? (
                    <div role="group" aria-label={t('list.delete_confirm.message')} className="flex flex-wrap items-center gap-2">
                      <span className="text-xs text-[#A85959]">{t('list.delete_confirm.message')}</span>
                      <button
                        type="button"
                        onClick={() => handleDelete(row.rsvp_id)}
                        disabled={isPending}
                        data-testid="rsvp-delete-confirm"
                        className="px-3 py-1.5 bg-[#A85959] text-white text-xs font-medium rounded-sm min-h-[36px] disabled:opacity-60"
                      >
                        {t('list.delete_confirm.confirm')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(null)}
                        disabled={isPending}
                        className="px-3 py-1.5 border border-line text-xs text-charcoal rounded-sm min-h-[36px]"
                      >
                        {t('list.delete_confirm.cancel')}
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(row.rsvp_id)}
                      disabled={isPending}
                      data-testid="rsvp-delete-button"
                      className="px-3 py-1.5 border border-line text-xs text-charcoal rounded-sm min-h-[36px] hover:bg-cream-2 transition-colors disabled:opacity-60"
                    >
                      {t('list.delete_button')}
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}
