# CLAUDE.md — Rules for Every Session

## Before Starting Any Task

1. Read `project_overview.md` at the project root before beginning a new task.
2. Full design specs are in `./docs/` — refer to them for details. Always read `4. Database Schema.md` before any database work.

## What Never to Do

3. Never commit `.env.local` or any file containing real credentials.
4. Never use `any` types in TypeScript except as an absolute last resort — strict mode is on.
5. Never use the Supabase service role key in user-facing code. RLS policies must be the enforcement layer, not application-layer bypasses.

## Database & Data Rules

6. Every mutation to PII (`people` create/update/delete, consent changes) must write a row to `audit_log` with actor, action, entity, and details.
7. Phone numbers are always stored in E.164 format. Always normalize via `libphonenumber-js` before any DB read or write involving a phone.

## UI & Internationalization

8. UI strings must be added to both the `en` and `id` locale files. Never hardcode user-facing text in components.

## How We Work Together

9. Stop after each Sprint Tracker task and wait for the user to verify before moving to the next one.
10. When in doubt about scope, ask before expanding. Prefer small, focused commits over large ones.

## Dev Server

11. After changing `proxy.ts`, any `.env*` file, `next.config.ts`, or `package.json`, restart the dev server (Ctrl+C then `npm run dev`). HMR does not reliably pick up infrastructure-level changes.

12. Supabase client selection:
    - `lib/supabase/client.ts` — Client Components only.
    - `lib/supabase/server.ts` — Server Components, Server Actions, Route Handlers.
    - `lib/supabase/admin.ts` — server contexts that must bypass RLS only (API routes, scheduled functions). Never import in pages or components.
    - `lib/supabase/anon.ts` — `createAnonServerClient()`: cookie-less, session-less anon client (server-only). Only for the anon-granted RPCs `get_default_language`, `get_rsvp_context`, `submit_rsvp`. Never for table reads/writes.

    This separation ensures the service role key never reaches the client bundle, and that the principle of least privilege is enforced at the architectural level — not just trusted to code review.

13. For connectivity smoke tests during development, prefer `auth.getUser()` or a query against an exposed schema table (e.g. `graphql_public.graphql`) rather than RPCing to functions that may not exist on a fresh project (e.g. `public.now` does not exist by default).

## Supabase Free Tier

14. The project runs on Supabase Free tier during the pitch phase. Free projects pause after 7 days of inactivity — do not assume Pro features (no pg_cron, no point-in-time recovery). The heartbeat cron (`/api/cron/heartbeat`) keeps the project alive. Switch to Pro before production launch.

## Before Declaring a Task Done

15. Run `npm run lint` and `npm run typecheck` — both must pass cleanly.

## Commit Style

16. Use conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `test:`. Keep the subject line under 72 characters. Run `git branch --show-current` before every commit and every push, and confirm it is the intended branch.

## Verification Ladder

17. Verification ladder. Every task's verify report states which rungs were run:
    - **Local Docker:** all automated tests (unit + integration). Destructive fixtures live only here.
    - **Staging deploy:** every user-facing or route change is smoke-tested on the staging branch's Vercel deployment against staging Supabase, using synthetic data and staging accounts only, before main is fast-forwarded.
    - **Prod:** live verification after deploy.

    Real PII never enters staging. Data-mutation rehearsals on real data use a local restore of a prod dump (docs/backups/RUNBOOK.md §3).

## Staging Release (standing rules, confirmed in S9-R6)

18. Staging delegation. Claude Code runs staging releases itself — preflight + staging pin, `supabase db push --dry-run`, `supabase db push`, `git push origin staging`, staging smoke scripts, and visual checks — under the explicit stop conditions of the task prompt. On any stop: no fix-forward on staging; report and wait. Prod (db push, main fast-forward, prod checks) is owner-run; Claude Code never touches prod.

19. Staging release report standard. Every staging release report contains:
    1. Summary in plain English (3–5 lines): what shipped, overall PASS/FAIL, anything the owner must do next.
    2. Context: branch, SHA(s), Supabase ref, deploy URL, timestamp (WIB).
    3. Steps table: # | action | exact command | expected | actual | PASS/FAIL.
    4. Evidence: raw output per step (trimmed, never paraphrased); synthetic data only, surrogate keys.
    5. Verification level per claim (verified:vitest | verified:local-build | verified:server-side | verified:live-staging | unverified).
    6. Deviations from the prompt, and every stop condition hit.
    7. Residue: the cleanup result plus the zero-residue assertion output.
    8. Owner checks: numbered one-liners, each with an explicit PASS criterion.
