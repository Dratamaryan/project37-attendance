import { NextRequest, NextResponse } from 'next/server'

import { createAdminClient } from '@/lib/supabase/admin'

// Expand this list as Sprint 1+ tables are added. Full monitoring in Sprint 4.
const TRACKED_TABLES = ['app_users', 'system_health'] as const

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  const auth = req.headers.get('authorization')

  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createAdminClient()

  const counts: Record<string, number> = {}
  for (const table of TRACKED_TABLES) {
    const { count, error } = await supabase
      .from(table)
      .select('*', { count: 'exact', head: true })
    if (error) {
      return NextResponse.json(
        { error: `count failed for ${table}: ${error.message}` },
        { status: 500 },
      )
    }
    counts[table] = count ?? 0
  }

  const { data, error } = await supabase
    .from('system_health')
    .insert({ table_row_counts: counts, status: 'ok' })
    .select('id, checked_at, table_row_counts, status')
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, row: data })
}
