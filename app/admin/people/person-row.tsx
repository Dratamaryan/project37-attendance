'use client'

import Link from 'next/link'
import Image from 'next/image'
import { useTranslations } from 'next-intl'
import { formatPhoneForDisplay } from '@/lib/utils/phone'
import type { PersonListItem } from '@/lib/actions/people.types'

// Deterministic color from full_name hash — same person always gets same color.
const AVATAR_COLORS = [
  'bg-amber-200 text-amber-800',
  'bg-blue-200 text-blue-800',
  'bg-green-200 text-green-800',
  'bg-rose-200 text-rose-800',
  'bg-purple-200 text-purple-800',
  'bg-teal-200 text-teal-800',
  'bg-orange-200 text-orange-800',
  'bg-indigo-200 text-indigo-800',
]

function colorForName(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) return (parts[0][0] ?? '?').toUpperCase()
  return ((parts[0][0] ?? '') + (parts[parts.length - 1][0] ?? '')).toUpperCase()
}

type Props = {
  person: PersonListItem
}

export function PersonRow({ person }: Props) {
  const t = useTranslations('admin.people')

  const deletedDate = person.deleted_at
    ? new Date(person.deleted_at).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : null

  const isDeleted = person.deleted_at !== null

  return (
    <tr className={isDeleted ? 'opacity-50' : undefined}>
      {/* Photo + name */}
      <td className="px-4 py-3 whitespace-nowrap">
        <div className="flex items-center gap-3">
          <div className="relative w-10 h-10 rounded-full overflow-hidden flex-shrink-0">
            {person.photo_signed_url ? (
              <Image
                src={person.photo_signed_url}
                alt={person.full_name}
                fill
                className="object-cover"
                sizes="40px"
              />
            ) : (
              <div
                className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold ${colorForName(person.full_name)}`}
                aria-hidden="true"
              >
                {initials(person.full_name)}
              </div>
            )}
          </div>
          <div>
            <div className="text-sm font-medium text-charcoal leading-tight">
              {person.full_name}
            </div>
            <div className="text-xs text-muted leading-tight">{person.nickname}</div>
          </div>
        </div>
      </td>

      {/* Phone */}
      <td className="px-4 py-3 whitespace-nowrap text-sm text-charcoal">
        {formatPhoneForDisplay(person.phone_e164)}
      </td>

      {/* Parish */}
      <td className="px-4 py-3 whitespace-nowrap text-sm text-muted">
        {person.origin_parish ?? t('row.no_parish')}
      </td>

      {/* Status / deleted badge */}
      <td className="px-4 py-3 whitespace-nowrap text-sm">
        {isDeleted && deletedDate ? (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">
            {t('row.deleted_badge', { date: deletedDate })}
          </span>
        ) : null}
      </td>

      {/* Actions */}
      <td className="px-4 py-3 whitespace-nowrap text-right text-sm">
        {isDeleted ? (
          <Link
            href={`/admin/people/${person.id}`}
            className="text-muted hover:text-charcoal transition-colors"
          >
            {t('row.edit_deleted')}
          </Link>
        ) : (
          <Link
            href={`/admin/people/${person.id}`}
            className="text-gold hover:text-gold-dark font-medium transition-colors"
          >
            {t('row.edit')}
          </Link>
        )}
      </td>
    </tr>
  )
}
