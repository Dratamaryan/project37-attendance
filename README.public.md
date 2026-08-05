# Absensi Project 37

Real-time attendance check-in and member management for a ~200-person Indonesian congregation — built to replace a manual Google Form workflow.

![Build](https://img.shields.io/badge/build-passing-brightgreen) ![License](https://img.shields.io/badge/license-MIT-blue)

**Live demo:** [project37-attendance.vercel.app](https://project37-attendance.vercel.app/) — seeded with synthetic demo data (`npm run seed:demo`), no real congregant information.

## Overview

Project 37 is a lay ministry that tracks attendance for a ~200-member congregation across recurring events (bi-weekly worship, monthly communion) and one-off gatherings. Attendance was previously tracked by hand through a Google Form, re-entered into spreadsheets after the fact — slow at check-in time and unreliable as a long-term member record.

This app replaces that with:
- A **volunteer check-in flow**: type a phone number, tap Check In. Target: 50 people checked in within 30 minutes.
- A **persistent member database** keyed on phone number (E.164), so a congregant never re-registers.
- **Admin tooling** for event scheduling, analytics, data import, and team access — all enforced at the database layer, not just in application code.

## Features

- **Real-time check-in** by phone number lookup, no login required for congregants
- **Member database** with soft-delete, consent tracking, and full audit logging on every PII mutation
- **Events & recurrence** — recurring event definitions auto-materialize instances up to 12 months ahead (bi-weekly Friday worship, monthly Sunday communion, and ad-hoc events)
- **Analytics dashboard** — attendance trends, top attendees, parish breakdown, new-vs-returning, powered by dedicated read-only SQL views
- **Excel export** of attendance and roster data
- **Bulk import with dedup** — spreadsheet import against the existing roster, classifying every row (new / duplicate-in-db / duplicate-in-file / duplicate-soft-deleted / error) before anything is committed
- **i18n** — full Indonesian/English UI, Indonesian as default locale
- **Notifications** — daily Telegram digest of today's birthdays (consent-gated), transactional email for organizer invites

## Tech Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router), TypeScript (strict), Turbopack |
| Database, Auth, Storage | Supabase (Postgres, Row-Level Security, Magic Link auth) |
| Hosting | Vercel |
| Styling | Tailwind CSS v4 (CSS-first config, no `tailwind.config.ts`) |
| i18n | next-intl |
| Phone validation | libphonenumber-js |
| Charts | Recharts |
| Spreadsheet export/import | SheetJS |
| Testing | Vitest (unit + integration), scripted Playwright checks for live-environment verification |

## Architecture Highlights

- **RLS as the enforcement layer, not a backstop.** Every table's authorization is expressed in Postgres Row-Level Security policies. A small set of `SECURITY DEFINER` helper functions (e.g. the `app_users` role lookup) intentionally bypass RLS in narrowly-scoped, audited ways so that RLS policies elsewhere can check role/active status without a chicken-and-egg dependency on the table they're protecting.
- **JWT-verified auth via `getClaims()`.** Every server-side auth check resolves the caller through `supabase.auth.getClaims()` (cryptographically verified) rather than `getSession()` (trusts local state). A single `requireActiveAdmin` / `requireActiveRole` helper distinguishes *unauthenticated* from *authenticated-but-denied* so callers can choose the correct response (redirect vs. an explicit "not authorized" page).
- **Keyset pagination** on every list surface that can grow unbounded (people, audit log, exports) — cursor-based rather than offset-based, so pages stay correct and fast as data grows.
- **Server-action `impl`/wrapper split.** Every server action is split into a thin `'use server'` wrapper (constructs the Supabase client, delegates) and an `*.impl.ts` function that takes the client as a parameter. This makes every action's business logic directly unit-testable without mocking module-level Supabase clients, and every action returns a **discriminated union** result type (e.g. `{ status: 'found' } | { status: 'not_found' } | { status: 'invalid_phone' }`) instead of throwing, so calling code exhaustively handles every case at compile time.
- **A five-class import/dedup engine.** Spreadsheet imports run through a pure classification function that assigns every row exactly one of `new`, `dup_in_db`, `dup_in_file`, `dup_soft_deleted`, or `error` — with explicit, tested rules for cross-referencing in-file duplicates against both active and soft-deleted database records before a dry-run is ever shown to the admin.
- **SQL-native analytics.** Five read-only Postgres views (`security_invoker = on`, so each respects the querying user's own RLS) compute attendance trends, parish breakdown, and new-vs-returning cohorts directly in SQL — with explicit, documented decisions about timezone bucketing (Asia/Jakarta, not UTC) and soft-delete visibility per metric.

## Getting Started

### Prerequisites

- Node.js 20+
- A Supabase project (free tier is sufficient for development)
- The [Supabase CLI](https://supabase.com/docs/guides/cli) for running migrations locally

### Setup

```bash
git clone https://github.com/Dratamaryan/project37-attendance.git
cd project37-attendance
npm install
```

Copy the example env file and fill in your own Supabase project's credentials:

```bash
cp .env.local.example .env.local
```

Start Supabase locally and apply migrations:

```bash
supabase start
supabase db reset   # applies migrations + supabase/seed.sql
```

Run the dev server:

```bash
npm run dev
```

Optionally seed realistic (fully synthetic) demo data:

```bash
npm run seed:demo
```

## Project Structure

```
app/                  Next.js App Router routes (admin, check-in, dashboard, auth, API)
lib/
  actions/            Server actions — thin wrapper + *.impl.ts + discriminated-union types
  auth/               Role/session resolution (getClaims-based)
  import/             Spreadsheet import: parse, normalize, classify, dry-run, commit
  events/             Recurrence materialization, attendance summaries, birthday digest
  telegram/           Telegram Bot API client + chat-id resolution
  email/              Notification email transport/config
  supabase/           client.ts / server.ts / admin.ts — scoped Supabase client factories
supabase/
  migrations/         All schema, RLS policies, and SQL views (source of truth)
  seed.sql            Local-dev-only baseline fixture (never applied to prod)
seed/
  demo-data.ts        Synthetic, wipeable demo dataset for the public deployment
i18n/, messages/       next-intl configuration and en/id translation files
tests/                Vitest unit + integration tests
scripts/               One-off and live-environment verification scripts
```

## Testing

```bash
npm run lint         # ESLint
npm run typecheck    # tsc --noEmit
npm test             # Vitest unit + integration suite
```

## Roadmap (Sprints 0–6)

| Sprint | Focus |
|---|---|
| 0 | Foundations — deployable shell with auth |
| 1 | People & check-in core |
| 2 | Events & attendance |
| 3 | Analytics & export |
| 4 | Notifications & invites |
| 5 | Users, settings & polish |
| 6 | UAT & launch |

## License

All rights reserved — see LICENSE

## Acknowledgements

Built for a single congregation's Project 37 ministry team — special thanks to the volunteers who piloted the check-in flow against the old Google Form process it replaces.
