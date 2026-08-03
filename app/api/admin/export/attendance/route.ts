import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import * as XLSX from 'xlsx'

import { createClient } from '@/lib/supabase/server'
import { requireActiveAdmin } from '@/lib/auth/require-admin'
import { AUDIT_ACTIONS, logAudit } from '@/lib/audit'
import { parseAnalyticsFilters } from '@/lib/actions/analytics.types'
import {
  impl_getRawAttendanceRows,
  getPersonAttendanceSummary,
  getEventAttendanceSummary,
} from '@/lib/actions/export.impl'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/export/attendance?from&to&eventType&parish
 *
 * Admin-only, server-generated 3-sheet .xlsx export: Raw Attendance, Person Summary,
 * Event Summary — all three derived from ONE filtered attendance_summary query
 * (see lib/actions/export.impl.ts). Writes one export.create audit row.
 *
 * Route Handler (not a Server Action) so SheetJS never reaches the client bundle,
 * and so the response can carry file download headers directly.
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

  const searchParams = req.nextUrl.searchParams
  const filters = parseAnalyticsFilters({
    from:      searchParams.get('from')      ?? undefined,
    to:        searchParams.get('to')        ?? undefined,
    eventType: searchParams.get('eventType') ?? undefined,
    parish:    searchParams.get('parish')    ?? undefined,
  })

  const rawResult = await impl_getRawAttendanceRows({ supabase, filters })

  if (rawResult.status === 'invalid_filter') {
    return NextResponse.json({ error: rawResult.message }, { status: 400 })
  }
  if (rawResult.status === 'error') {
    return NextResponse.json({ error: rawResult.message }, { status: 500 })
  }

  const rawRows = rawResult.data
  const personSummary = getPersonAttendanceSummary(rawRows)
  const eventSummary = getEventAttendanceSummary(rawRows)

  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rawRows), 'Raw Attendance')
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(personSummary), 'Person Summary')
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(eventSummary), 'Event Summary')

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
        filters,
        sheet_row_counts: {
          raw: rawRows.length,
          person_summary: personSummary.length,
          event_summary: eventSummary.length,
        },
      },
      ipAddress,
      userAgent,
    },
    supabase,
  )

  const fromLabel = filters.from ?? 'all'
  const toLabel = filters.to ?? 'all'
  const filename = `attendance_export_${fromLabel}_to_${toLabel}.xlsx`

  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'X-Export-Id': exportId,
    },
  })
}
