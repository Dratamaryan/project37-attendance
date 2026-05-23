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

    This separation ensures the service role key never reaches the client bundle, and that the principle of least privilege is enforced at the architectural level — not just trusted to code review.

13. For connectivity smoke tests during development, prefer `auth.getUser()` or a query against an exposed schema table (e.g. `graphql_public.graphql`) rather than RPCing to functions that may not exist on a fresh project (e.g. `public.now` does not exist by default).

## Before Declaring a Task Done

14. Run `npm run lint` and `npm run typecheck` — both must pass cleanly.

## Commit Style

15. Use conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `test:`. Keep the subject line under 72 characters.
