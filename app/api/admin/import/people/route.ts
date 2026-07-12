import { NextRequest, NextResponse } from 'next/server'

import { createClient } from '@/lib/supabase/server'
import { validateUpload, MAX_FILE_BYTES } from '@/lib/import/validate'
import { runImportDryRun } from '@/lib/import/dry-run.impl'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/import/people
 *
 * Admin-only, multipart, 5MiB cap. `mode` form field is a discriminator —
 * this route implements `mode=dry_run` only (T7). `mode=commit` is T8's seam;
 * anything other than exactly 'dry_run' is rejected so future callers must be
 * explicit rather than relying on a silent default.
 *
 * Dry-run writes NOTHING to `people` — the only DB write is one
 * `import.dry_run` audit row (see lib/import/dry-run.impl.ts).
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient()

  const { data: claimsResult } = await supabase.auth.getClaims()
  if (!claimsResult) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { data: appUser } = await supabase
    .from('app_users')
    .select('role')
    .eq('id', claimsResult.claims.sub)
    .single()

  if (appUser?.role !== 'admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  // Reject oversized uploads before buffering the multipart body at all.
  const contentLength = req.headers.get('content-length')
  if (contentLength && Number(contentLength) > MAX_FILE_BYTES) {
    return NextResponse.json(
      { error: 'file_too_large', maxBytes: MAX_FILE_BYTES, actualBytes: Number(contentLength) },
      { status: 413 },
    )
  }

  const formData = await req.formData()

  const mode = formData.get('mode')
  if (mode !== 'dry_run') {
    return NextResponse.json(
      { error: 'unsupported_mode', message: `Only 'dry_run' is implemented. Received: ${String(mode)}` },
      { status: 400 },
    )
  }

  const file = formData.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'missing_file' }, { status: 400 })
  }

  // Second guard: catches chunked-encoding uploads with no Content-Length,
  // and re-checks extension. Still strictly before the SheetJS parse call.
  const validation = validateUpload({ name: file.name, size: file.size })
  if (!validation.ok) {
    const status = validation.error === 'file_too_large' ? 413 : 400
    return NextResponse.json(validation, { status })
  }

  const arrayBuffer = await file.arrayBuffer()
  const fileBuffer = Buffer.from(arrayBuffer)

  const ipAddress = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
  const userAgent = req.headers.get('user-agent')

  const outcome = await runImportDryRun(
    {
      fileBuffer,
      filename: file.name,
      actorUserId: claimsResult.claims.sub,
      ipAddress,
      userAgent,
    },
    supabase,
  )

  if (!outcome.ok) {
    return NextResponse.json(outcome, { status: 400 })
  }

  return NextResponse.json(
    {
      importId: outcome.importId,
      ...outcome.result,
    },
    { status: 200 },
  )
}
