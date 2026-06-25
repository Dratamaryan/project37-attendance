'use server'

import { createClient } from '../supabase/server'
import {
  impl_getKpiSummary,
  impl_getEventAttendanceTrend,
  impl_getParishBreakdown,
  impl_getTopAttendees,
  impl_getNewVsReturningMonthly,
} from './analytics.impl'
import type {
  AnalyticsFilters,
  GetKpiSummaryResult,
  GetEventAttendanceTrendResult,
  GetParishBreakdownResult,
  GetTopAttendeesResult,
  GetNewVsReturningMonthlyResult,
} from './analytics.types'

export async function getKpiSummary(
  filters: AnalyticsFilters,
): Promise<GetKpiSummaryResult> {
  const supabase = await createClient()
  return impl_getKpiSummary({ supabase, filters })
}

export async function getEventAttendanceTrend(
  filters: AnalyticsFilters,
): Promise<GetEventAttendanceTrendResult> {
  const supabase = await createClient()
  return impl_getEventAttendanceTrend({ supabase, filters })
}

export async function getParishBreakdown(
  filters: AnalyticsFilters,
): Promise<GetParishBreakdownResult> {
  const supabase = await createClient()
  return impl_getParishBreakdown({ supabase, filters })
}

export async function getTopAttendees(
  filters: AnalyticsFilters,
  limit?: number,
): Promise<GetTopAttendeesResult> {
  const supabase = await createClient()
  return impl_getTopAttendees({ supabase, filters, limit })
}

export async function getNewVsReturningMonthly(
  filters: AnalyticsFilters,
): Promise<GetNewVsReturningMonthlyResult> {
  const supabase = await createClient()
  return impl_getNewVsReturningMonthly({ supabase, filters })
}
