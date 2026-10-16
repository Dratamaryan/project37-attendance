import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import * as XLSX from 'xlsx'

import { createClient } from '@/lib/supabase/server'
import { requireActiveAdmin } from '@/lib/auth/require-admin'
import { AUDIT_ACTIONS, logAudit } from '@/lib/audit'
import { formatJakarta } from '@/lib/events/timezone'
import { impl_getInstanceAttendees } from '@/lib/actions/instance-attendees.impl'
import {
  ADULT_HEADERS,
  CHILD_HEADERS,
  mapAdultToExportRow,
  mapChildToExportRow,
} from '@/lib/actions/instance-attendees-export'
import { sheetSafeRow } from '@/lib/utils/sheet-safe'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ instanceId: string }> }

/**
 * GET /api/admin/export/instance/[instanceId]
 *
 * Admin-only, server-generated 2-sheet .xlsx of one instance's attendees:
 * "Adults" and "Children". Same data function as the organizer attendee page
 * (impl_getInstanceAttendees, RLS server client), so the masking and
 * soft-deleted exclusion are identical; the export only adds checker emails.
 * Phones are last-4 only, every cell goes through sheet-safe. Generated
 * in-memory and streamed — never written to Storage or disk. Writes one
 * export.create audit row (kind + instance id + counts only, no PII).
 */
export async function GET(req: NextRequest, { params }: RouteContext) {
  const { instanceId } = await params
  const supabase = await createClient()

  const guard = await requireActiveAdmin(supabase)
  if (guard.status === 'unauthenticated') {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  if (guard.status === 'denied') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const result = await impl_getInstanceAttendees({ supabase, instanceId, includeCheckerEmail: true })
  if (result.status === 'invalid_input') {
    return NextResponse.json({ error: 'invalid instance id' }, { status: 400 })
  }
  if (result.status === 'not_found') {
    return NextResponse.json({ error: 'instance not found' }, { status: 404 })
  }
  if (result.status === 'error') {
    return NextResponse.json({ error: result.message }, { status: 500 })
  }

  const adults = result.adults.map(mapAdultToExportRow).map(sheetSafeRow)
  const children = result.children.map(mapChildToExportRow).map(sheetSafeRow)

  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(adults, { header: ADULT_HEADERS }), 'Adults')
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(children, { header: CHILD_HEADERS }), 'Children')

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
        export_kind: 'instance_attendees',
        event_instance_id: result.instance.id,
        row_counts: { adults: adults.length, children: children.length },
      },
      ipAddress,
      userAgent,
    },
    supabase,
  )

  const day = formatJakarta(new Date(result.instance.scheduled_at), 'yyyy-MM-dd')
  const filename = `attendees_${day}_${result.instance.id.slice(0, 8)}.xlsx`

  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'X-Export-Id': exportId,
    },
  })
}
