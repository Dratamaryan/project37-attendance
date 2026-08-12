import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import * as XLSX from 'xlsx'

import { createClient } from '@/lib/supabase/server'
import { requireActiveAdmin } from '@/lib/auth/require-admin'
import { AUDIT_ACTIONS, logAudit } from '@/lib/audit'
import { impl_getRosterRows, mapRosterRowToExportRow } from '@/lib/actions/people-export.impl'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/export/people
 *
 * Admin-only, server-generated single-sheet .xlsx of the people roster — a
 * human-readable roster convenience artifact for admins. Explicitly NOT the
 * importer's inverse and NOT a backup (disaster-recovery is a separate pg_dump
 * drill): plain readable headers/values, not Absensi headers or Ya/Tidak
 * tokens. Scope: active + soft-deleted, excludes anonymized rows (see
 * lib/actions/people-export.impl.ts). Generated in-memory and streamed
 * directly to the response — never written to Supabase Storage or disk.
 * Writes one export.create audit row (kind + row count only, no PII).
 */
export async function GET(req: NextRequest) {
  const supabase = await createClient()

  const guard = await requireActiveAdmin(supabase)
  if (guard.status === 'unauthenticated') {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  if (guard.status === 'denied') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const result = await impl_getRosterRows({ supabase })
  if (result.status === 'error') {
    return NextResponse.json({ error: result.message }, { status: 500 })
  }

  const exportRows = result.data.map(mapRosterRowToExportRow)

  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(exportRows), 'People Roster')

  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer
  const body = new Uint8Array(buffer)

  const exportId = randomUUID()
  const ipAddress = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
  const userAgent = req.headers.get('user-agent')

  await logAudit(
    {
      actorUserId: guard.actorId,
      action: AUDIT_ACTIONS.EXPORT_CREATE,
      entityType: 'export',
      entityId: exportId,
      detailsJson: {
        export_kind: 'people_roster',
        row_count: exportRows.length,
      },
      ipAddress,
      userAgent,
    },
    supabase,
  )

  const todayLabel = new Date().toISOString().slice(0, 10)
  const filename = `people_roster_export_${todayLabel}.xlsx`

  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'X-Export-Id': exportId,
    },
  })
}
