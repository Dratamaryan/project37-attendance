# Project 37 — Absensi Project 37

A church event attendance web app for a single Indonesian congregation, replacing manual Google Form (`PEMBARUAN DATA UMAT`) tracking with a real-time check-in tool and long-term member database.

## What It Does

- **Volunteer check-in** at events: type a phone number → tap Check In. Target: 50 people in 30 minutes.
- **Admin event management**: recurring events (bi-weekly Friday worship, monthly Sunday communion) auto-generate instances 12 months ahead.
- **Birthday notifications**: daily Telegram digest to the admin listing today's birthdays (consent-gated).
- **Analytics & Excel export**: attendance trends, top attendees, parish breakdown, new vs. returning.
- **Team access**: admin invites organizers with scoped permissions.

## Stack

| Layer | Choice |
|---|---|
| Frontend + API | Next.js 16.2+ (App Router, TypeScript, Tailwind v4) on Vercel |
| Database + Auth + Storage | Supabase Free → Pro (Postgres 15, RLS, Magic Link) |
| Admin notifications | Telegram Bot API |
| Email (Phase 1) | Gmail SMTP via Nodemailer |
| Email (Phase 2) | Resend |
| i18n | next-intl (Indonesian / English) |
| Phone validation | libphonenumber-js |
| Excel export | SheetJS |
| Charts | Recharts |

**Cost: $0/month during pitch (Supabase Free) — upgrade to Pro ($25/mo) on approval + $15/year domain.**

## Key Design Decisions

- Phone number (`phone_e164`) is the unique identifier for members — no login required for congregants.
- All authorization enforced at the database layer via Postgres RLS — not just application code.
- Every PII mutation writes to `audit_log`.
- Soft-delete only (`deleted_at`); data is never hard-deleted except by scheduled retention job.
- Supabase Free tier keep-alive: daily Vercel Cron writes to `system_health` to prevent project auto-pause (7-day inactivity limit). Remove when migrating to Pro.
- Single-tenant, single-codebase, single deployment.
- Tailwind v4 CSS-first configuration: styles defined in `globals.css` via `@theme`, no `tailwind.config.ts`.
- Three Supabase clients (`lib/supabase/client.ts`, `server.ts`, `admin.ts`) isolate concerns: anon key for RLS-respecting access, service role for bypass-RLS server operations only, never mixed.
- Schema additions from real-data analysis (May 24, 2026): `gender`, `kepanitiaan`, `tribe` added to `people` table. Wedding/spouse/children/couple-photo fields deferred to Sprint 5 admin UI. See `docs/4. Database Schema.md` "Real Data" section for full data quality findings and import plan.

**Visual design reference:** `docs/design-demo.html` is a self-contained 
HTML demo of the full UI that the team approved during the design phase. 
Use this as the source of truth for color, typography, spacing, and 
component patterns when implementing UI features.

## Sprint Plan (high level)

| Sprint | Focus |
|---|---|
| 0 | Foundations — deployable shell with auth |
| 1 | People & Check-In Core |
| 2 | Events & Attendance |
| 3 | Analytics & Export |
| 4 | Notifications & Invites |
| 5 | Users, Settings & Polish |
| 6 | UAT & Launch |

Full specs: `./docs/`

## Branding

- App name: **Absensi Project 37**
- Colors: gold `#A8924A`, charcoal `#0F0F0F`
- Default language: Indonesian (`id`)
- Admin email: admin-example@example.test
