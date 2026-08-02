'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { inviteOrganizer, changeRole, deactivateUser, reactivateUser } from '@/lib/actions/admin-users'
import type { AppUserSummary, AppUserRole } from '@/lib/actions/admin-users.types'

type Props = {
  initialUsers: AppUserSummary[]
  currentUserId: string
  loadError: boolean
}

type Message = { type: 'success' | 'error'; text: string }

export function UsersClient({ initialUsers, currentUserId, loadError }: Props) {
  const t = useTranslations('admin.users')
  const router = useRouter()

  const [email, setEmail] = useState('')
  const [inviteMessage, setInviteMessage] = useState<Message | null>(null)
  const [isInviting, startInvite] = useTransition()

  const [rowMessage, setRowMessage] = useState<{ id: string } & Message | null>(null)
  const [pendingRowId, setPendingRowId] = useState<string | null>(null)
  const [isRowPending, startRowAction] = useTransition()

  function handleInvite() {
    const trimmed = email.trim()
    if (!trimmed) return
    setInviteMessage(null)
    startInvite(async () => {
      const result = await inviteOrganizer(trimmed)
      switch (result.status) {
        case 'invited':
          setEmail('')
          setInviteMessage({
            type: 'success',
            text: result.repaired ? t('invite.success_repaired') : t('invite.success'),
          })
          router.refresh()
          break
        case 'already_exists':
          setInviteMessage({
            type: 'error',
            text: t('invite.error.already_exists', { role: t(`table.role_${result.role}`) }),
          })
          break
        case 'invalid_input':
          setInviteMessage({ type: 'error', text: t('invite.error.invalid_input') })
          break
        case 'not_authorized':
          setInviteMessage({ type: 'error', text: t('invite.error.not_authorized') })
          break
        case 'partial_failure':
          setInviteMessage({ type: 'error', text: t('invite.error.partial_failure') })
          break
        case 'error':
          setInviteMessage({ type: 'error', text: t('invite.error.generic') })
          break
      }
    })
  }

  function handleChangeRole(userId: string, newRole: AppUserRole) {
    setRowMessage(null)
    setPendingRowId(userId)
    startRowAction(async () => {
      const result = await changeRole(userId, newRole)
      if (result.status === 'ok') {
        router.refresh()
      } else if (result.status === 'not_allowed') {
        setRowMessage({ id: userId, type: 'error', text: t('row.error.last_admin') })
      } else if (result.status !== 'not_found') {
        setRowMessage({ id: userId, type: 'error', text: t('row.error.generic') })
      }
      setPendingRowId(null)
    })
  }

  function handleDeactivate(userId: string) {
    setRowMessage(null)
    setPendingRowId(userId)
    startRowAction(async () => {
      const result = await deactivateUser(userId)
      if (result.status === 'ok') {
        router.refresh()
      } else if (result.status === 'not_allowed' && result.reason === 'self') {
        setRowMessage({ id: userId, type: 'error', text: t('row.error.self_deactivate') })
      } else if (result.status === 'not_allowed') {
        setRowMessage({ id: userId, type: 'error', text: t('row.error.last_admin') })
      } else if (result.status !== 'not_found') {
        setRowMessage({ id: userId, type: 'error', text: t('row.error.generic') })
      }
      setPendingRowId(null)
    })
  }

  function handleReactivate(userId: string) {
    setRowMessage(null)
    setPendingRowId(userId)
    startRowAction(async () => {
      const result = await reactivateUser(userId)
      if (result.status === 'ok') {
        router.refresh()
      } else if (result.status !== 'not_found') {
        setRowMessage({ id: userId, type: 'error', text: t('row.error.generic') })
      }
      setPendingRowId(null)
    })
  }

  return (
    <div className="space-y-8">
      <div className="bg-cream-2 border border-line rounded-lg p-5">
        <h2 className="font-heading text-lg font-semibold text-charcoal mb-3">
          {t('invite.title')}
        </h2>
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t('invite.email_placeholder')}
            disabled={isInviting}
            className="flex-1 rounded-sm border border-line px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={handleInvite}
            disabled={isInviting || !email.trim()}
            className="inline-flex items-center justify-center rounded-sm bg-gold px-4 py-2 text-sm font-medium text-white hover:bg-gold-dark transition-colors disabled:opacity-50"
          >
            {isInviting ? t('invite.button_pending') : t('invite.button')}
          </button>
        </div>
        {inviteMessage && (
          <p
            role={inviteMessage.type === 'error' ? 'alert' : 'status'}
            className={`text-sm mt-2 ${inviteMessage.type === 'error' ? 'text-red-600' : 'text-green-700'}`}
          >
            {inviteMessage.text}
          </p>
        )}
      </div>

      {loadError && <p className="text-sm text-red-600">{t('load_error')}</p>}

      {!loadError && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="users-table">
            <thead>
              <tr className="text-left text-muted border-b border-line">
                <th className="py-2 pr-4">{t('table.email')}</th>
                <th className="py-2 pr-4">{t('table.role')}</th>
                <th className="py-2 pr-4">{t('table.status')}</th>
                <th className="py-2 pr-4">{t('table.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {initialUsers.map((u) => {
                const isSelf = u.id === currentUserId
                const rowPending = isRowPending && pendingRowId === u.id

                return (
                  <tr key={u.id} className="border-b border-line/50" data-testid={`user-row-${u.id}`}>
                    <td className="py-2 pr-4">
                      {u.email}
                      {isSelf && <span className="ml-2 text-xs text-muted">{t('table.you')}</span>}
                    </td>
                    <td className="py-2 pr-4">{t(`table.role_${u.role}`)}</td>
                    <td className="py-2 pr-4">
                      <span className={u.active ? 'text-green-700' : 'text-muted'}>
                        {u.active ? t('table.active') : t('table.inactive')}
                      </span>
                    </td>
                    <td className="py-2 pr-4">
                      <div className="flex flex-wrap gap-3">
                        <button
                          type="button"
                          disabled={rowPending}
                          onClick={() => handleChangeRole(u.id, u.role === 'admin' ? 'organizer' : 'admin')}
                          className="text-xs font-medium text-gold hover:text-gold-dark disabled:opacity-50"
                        >
                          {u.role === 'admin' ? t('table.make_organizer') : t('table.make_admin')}
                        </button>
                        {u.active ? (
                          <button
                            type="button"
                            disabled={rowPending || isSelf}
                            onClick={() => handleDeactivate(u.id)}
                            className="text-xs font-medium text-red-600 hover:text-red-700 disabled:opacity-50"
                          >
                            {t('table.deactivate')}
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={rowPending}
                            onClick={() => handleReactivate(u.id)}
                            className="text-xs font-medium text-green-700 hover:text-green-800 disabled:opacity-50"
                          >
                            {t('table.reactivate')}
                          </button>
                        )}
                      </div>
                      {rowMessage?.id === u.id && (
                        <p role="alert" className="text-xs text-red-600 mt-1">
                          {rowMessage.text}
                        </p>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
