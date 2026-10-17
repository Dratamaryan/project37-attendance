# Release & Database-Operations Runbook

This document defines the branch model and the safeguards that stand between a
local working copy and the **live** Supabase databases. It exists because more
than one live project ref is now reachable from a single machine, so "which
database am I about to touch?" is no longer answerable by habit.

Read this before running any remote migration, push, or write script.

---

## 1. Branch model

- **`main` is production.** Remote database operations from `main` target the
  production project ref (`bftifxgdcmisasgvobuf`).
- **Feature work** branches off `main` (`feature/<name>`), is authored and tested
  against **local Docker only** (`supabase start`, `supabase db reset`,
  `supabase migration up --local`), then merges back via **PR → `main`**.
- **`release/<x>`** branches are cut per go-live. In S7 they also map to
  production.
- Feature branches **cannot** run remote DB operations — the preflight guard
  denies any branch not in the map (see §3). Author migrations on a feature
  branch, merge, then apply from `main` / `release/*`.

**Git remote.** `origin` =
`https://github.com/Dratamaryan/project37-attendance.git` is the canonical public
repository. Push there. (The repo is public — never `git add -f` anything under
`scripts/.local-dumps/`, and keep real member PII out of committed code, fixtures,
and comments.)

---

## 2. The one rule for remote DB operations

**Never call `supabase db push` or `supabase migration up` directly.** Always go
through the npm scripts below, so the preflight guard runs *first* and aborts on a
branch/ref mismatch before the real command executes.

| Script | What it does |
| --- | --- |
| `npm run preflight` | Runs the guard standalone (diagnostic). |
| `npm run db:push` | Guard → `supabase db push`. |
| `npm run migrate:up` | Guard → `supabase migration up --linked`. |
| `npm run preflight:selftest` | Runs the guard's abort-matrix selftest. |

The `&&` between the guard and the real command means a non-zero guard exit
**blocks** the downstream command — it never runs. This is proven: a deliberate
wrong-ref `migrate:up` aborts with the downstream `supabase migration up` never
executing.

> The guard cannot stop a raw `supabase …` command typed directly at the shell.
> That residual is covered by this rule plus the in-process guard call inside
> Node write-scripts (e.g. the S7-T3 roster apply calls the guard as a library
> before constructing any client).

---

## 3. What the preflight guard does

Files:

- `supabase/preflight.branch-ref.json` — the branch → expected-ref map.
- `scripts/preflight/resolve-ref.mjs` — resolves the ref the operation will hit.
- `scripts/preflight/guard.mjs` — pure `evaluate()` + CLI entry point.
- `scripts/preflight/selftest.mjs` — abort-matrix proof.

All are plain Node ESM and run on bare `node` — no TypeScript transpile, no `tsx`,
no app imports. The guard must run even when the app build is broken, so it
depends on nothing that a broken build could disable.

**The map** (deny-by-default):

```json
{
  "version": 1,
  "prodRef": "bftifxgdcmisasgvobuf",
  "denyByDefault": true,
  "branches": {
    "main": "bftifxgdcmisasgvobuf",
    "release/*": "bftifxgdcmisasgvobuf",
    "staging": "sijfyvaodqkawbeuyrpu"
  }
}
```

**Ref resolution is per op-class:**

- **CLI ops** (`db-push`, `migrate-up`) — authoritative source is
  `supabase/.temp/project-ref` (what the `supabase` CLI actually targets).
- **Node write-ops** (everything else) — authoritative source is the process
  env: `NEXT_PUBLIC_SUPABASE_URL` (and `SUPABASE_DB_URL` if set).

The ref is parsed from the hostname; `localhost` / `127.0.0.1` are classified as
local. Every present source is collected, and **more than one distinct non-local
ref triggers a disagreement abort** (ambiguity is treated as dangerous).

**Abort conditions** (guard exits non-zero, downstream command blocked):

1. Detached / empty branch.
2. Map missing or unparseable.
3. Branch not in the map under deny-by-default.
4. Remote-write op with no resolvable ref (refuses to guess an unlinked target).
5. Ref sources disagree.
6. Resolved ref ≠ branch-expected ref.

The **only** path to proceeding is a single consistent ref that equals the
branch-expected ref, at which point the guard prints a one-line confirmation
banner (branch / op / ref) and exits 0.

---

## 4. How this complements the Vitest guard

`setupTests.ts` throws if `NEXT_PUBLIC_SUPABASE_URL` resolves to the production
ref — it keeps **integration tests** pointed at local Docker. That guard covers
the *test* runtime only. The preflight guard covers the *CLI / script* path. Two
layers, opposite directions: one refuses prod for tests, the other requires the
branch-expected ref for remote ops.

---

## 5. Verifying the guard

- `npm run preflight:selftest` — exercises the full abort matrix (the ok-path plus
  all six abort reasons) against injected fixtures. Must be green.
- Manual wrong-ref proof: write a wrong ref into `supabase/.temp/project-ref` on
  `main`, run `npm run migrate:up`, confirm the abort and that `supabase migration
  up` never runs, then restore the file. Use a nonexistent ref for a double net —
  it also dies at the Supabase layer if the guard ever had a hole.

---

## 6. Known limitations & S8 follow-ups

- **Local-target exemption is wired in S7-T3.1 (469eee9).** `evaluate()` now returns
  `{ ok: true, reason: null }` for any `resolved.local === true` target
  (`localhost` / `127.0.0.1`), checked immediately after the map-missing check
  and before branch-deny/mismatch logic — a local target can never be the
  wrong *remote*, which is what the guard exists to prevent. Proven by the
  `branch=feature/x, op=roster-apply, resolved=local(127.0.0.1) => ok` case in
  `selftest.mjs`.
- **`SUPABASE_DB_URL` host parse is imprecise.** A direct connection string parses
  to `db`, a pooler string to `aws-0-<region>` (the ref lives in the username).
  This is fail-safe — it can only ever produce a spurious abort, never a false
  allow — and `SUPABASE_DB_URL` is not currently in use. Fix the parser before it
  enters real use.
- **Disagreement tripwire is dormant on plain `db:push` / `migrate:up`,** because
  the guard process does not load `.env.local`, so only `.temp/project-ref`
  contributes and there is nothing to cross-check. The AC-required authoritative
  check is unaffected. Optional hardening: invoke the guard with
  `node --env-file=.env.local`.
- **Catch-all glob ordering (S8).** `matchBranchRef` returns the first matching
  entry in map order. When S8 adds a `*` staging catch-all, order specific globs
  before the catch-all, or switch to longest-prefix matching.
- **Map extension (S8) — partially done.** `staging` (`sijfyvaodqkawbeuyrpu`) is now
  in the map as an exact-match branch key (S8-T7, see §8). Feature branches are
  still deny-by-default — routing feature work to staging (e.g. via a `*`
  catch-all) is not yet wired; see the catch-all-ordering note below when it lands.
- **Bare `npm run preflight` doesn't resolve.** With no `--op`, ref resolution
  takes the Node-write-op path (authoritative on `NEXT_PUBLIC_SUPABASE_URL` in
  `process.env`), which plain `node` never populates from `.env.local` — so the
  standalone diagnostic aborts with `remote-write-op-no-resolvable-ref` even
  though `supabase/.temp/project-ref` already agrees with the branch-expected
  ref. `db:push` / `migrate:up` are unaffected (they pass `--op=`). Consider
  defaulting the bare script to `--op=migrate-up` for a true one-command sanity.

---

## 7. S7 task log

- S7-T2 PII fixture cleanup: verified live on fd14a7c — preflight OK, gitleaks baseline-only,
  grep 0 fixture hits, 897/897, preflight:selftest 8/8, Vercel dpl_EHBjbks7… READY sin1.
  Forward-fix only; history residual accepted (revisit post-S11). See docs/sprint-7-task-2-verify.md.
- S7-T4 mobile check-in layout verified live + real-device (iOS) on f33f619 — dpl_3qmhJYa…,
  sin1. Native date-input empty-height accepted as known issue (backlog).
- S7-T5 check-in by name verified live + real-device (iOS) on c3dfe78 — dpl_7xfMHdvM…, sin1.
  Confirm step (select→PersonCard→explicit Check in) added; no-undo gap logged to backlog.
- S7-T6 hide parish/city/area + admin birthdate/consent verified live + real-device (iOS) on
  d426ae3 — dpl_8RqHSpez…, sin1. Sprint 7 complete.

---

## 8. S8 task log

- S8-T7 guard map: staging (`sijfyvaodqkawbeuyrpu`) added to preflight branch→ref
  map as an exact key; deny-by-default and main/release→prod unchanged. selftest
  extended to 10 cases (added staging positive + staging→prod mismatch). Verified:
  full gate green (930/930); real-machine resolve OK for main under db-push/
  migrate-up. Behavior-neutral for the deployed app (map not in build output).
  Backlog: bare `npm run preflight` (no --op) aborts no-resolvable-ref — consider
  defaulting to --op=migrate-up for a true one-command sanity. Live verify pending.

- S8-T7 (staging identity seed): scripts/s8-t7-seed-staging-identities.ts run
  against staging (sijfyvaodqkawbeuyrpu). Created 2 synthetic login-capable
  identities — admin@example.com (admin) + organizer@example.com (organizer),
  email_confirmed, active. Guard + staging-pin enforced at run. Idempotent
  (stale-by-email reconcile). No real PII.

- S8-T7 COMPLETE: staging Supabase project live end-to-end. 21 migrations applied;
  schema parity with prod verified via information_schema digests (columns/enums/
  RLS all identical). Preview env isolated — every prod secret Production-scoped,
  every staging secret Preview-scoped (D2 closed, no All-Environments leak).
  Vercel git auto-deploy for `staging` enabled; stable alias
  project37-attendance-git-staging-*.vercel.app; NEXT_PUBLIC_APP_URL pinned.
  App boots and authenticates: magic-link login as staging admin → /dashboard.
  Backlog: (a) /auth/confirm doesn't validate `type` before verifyOtp (input-trust,
  minor); (b) redundant manual alias project37-staging.vercel.app can be dropped.

  - S8-T1 (children + child_attendance schema): migration 20261005120000 applied to
  prod (bftifxgdcmisasgvobuf) and staging (sijfyvaodqkawbeuyrpu). Two tables —
  children (people-shaped: soft-delete, app-managed updated_at no trigger,
  parent_person_id → people NO ACTION) + child_attendance (attendance-shaped append
  log, child_id → children NO ACTION, event_instance_id CASCADE, checked_in_by →
  app_users, UNIQUE(event_instance_id, child_id)). SEPARATE from adult attendance —
  verified no FK coupling (full FK list references only people/children/
  event_instances/app_users). RLS: children mirrors people (7 policies, per-command,
  is_organizer, soft-delete-filtered, no organizer delete); child_attendance mirrors
  attendance (3 policies, is_active_app_user, checked_in_by=auth.uid). S4-T3-style
  prod-drift abort guard. Validated local → staging → prod; constraints + RLS +
  no-coupling live-verified on both remotes. Age derived at read time (not stored).

  - S8-T2 (child check-in flow): two-pass. Data layer — impl_createChildAttendance
  (mirrors adult, writes ONLY to child_attendance, INSERT-catch-23505 dedup on
  uniq_child_attendance, admin-client disambiguation, audit CHILD_ATTENDANCE_CREATE)
  + organizer-safe lookups (listChildrenByParent, lookupChildByName). UI — child
  LookupMode, parent-first (D1) + child-name search (D2), ChildMatchList + ChildCard,
  select≠commit confirm guard (F2), disambiguator = parent name + formatDayMonth
  (14 Mar / —, no year). No adult-attendance coupling; not in Recent panel (D3).
  i18n en+id incl. month arrays. Tests: CATT-01..12 integration (race + adult-
  isolation) + CC-16..23 jsdom; gate 985/985. Verified on-device (staging): full
  flow incl. live commit + duplicate path; real-device tab/sub-selector fit OK.
  Op note filed on T4: child creation must not stay SQL-only (non-engineer operator).

  - S8-T4 (children free-text parse): parser run against prod (bftifxgdcmisasgvobuf),
  run_id f11c7299. 49 'ya' rows → 41 parsed-full / 7 parsed-partial-notes / 1
  unparseable-skipped; 0 parent-not-found/deleted/anonymized. Inserted 77 children
  across 48 parents (74 dated, 3 null-date, 13 with notes). Option-A idempotency
  (parent-skip), post-write re-verify all 5 assertions passed, surrogate-keyed audit
  (77 child.create). Rehearsed on local prod-restore before apply; backup
  prod-data-only-20261006T095151Z.sql taken first. Row 55 unparseable (needs manual
  entry); rows 28/69/101 flagged for admin review. Admin add-child UI → T4b.

  - S8-T4b (manual add/edit child UI): admin PersonChildrenSection (list/add/edit/
  soft-delete, notes view+edit for parse-cleanup, read-only for soft-deleted parent)
  + check-in create-only affordance (NewChildForm → createChild → ChildCard, never
  auto-attends). Duplicate=warn-not-block. Audit IDs-only for minors. notes split to
  admin-only path (type-enforced; check-in never selects it). Two-pass build, +64
  tests, gate 1092/1092. Prod-verified on-device: child search, add-child, idempotent
  check-in all live. Admin-review cleanup (rows 55/13/15/25/28/45/69/99/101) now
  doable via the admin UI. Opened T10 (admin add-person — separate gap).

  - S8-T3 (anniversary/spouse): migration c63c658 (20261007120000) applied to
  staging + prod — people.wedding_anniversary (date), spouse_name (text),
  anniversary_consent_state (consent_state_enum NOT NULL DEFAULT 'unknown'),
  anniversary_consent_at (timestamptz); anonymize_person() CREATE OR REPLACE adds
  the 4-column scrub (signature, SECURITY DEFINER, search_path, service_role-only
  ACL unchanged; def_md5 identical on both remotes). Script 81d01a7
  (s8-t3-anniversary-spouse-enrich, fill-empty, SQL IS NULL guard) live-verified on
  prod 2026-10-13, importId 94d4c4ae…: 60 rows filled (58 anniversaries / 60
  spouses), 1 anniversary quarantined (string cell), 0 conflicts, 0 race-skipped;
  idempotent re-run 0 writes; consent untouched (all 222 'unknown'); audit 60
  people.update rows, field names only. Rehearsed on local prod-restore first;
  owner calendar-day spot-check 3/3; backup prod-data-only-20261013T054224Z.sql
  taken first. Follow-ups: F2 (P1) anonymize_person() must scrub the anonymized
  parent's children; admin UI/export for the new columns; T6 anniversary consent
  gate. Practice: restart dev REST (PostgREST) after any `supabase db reset`,
  before the full-suite gate (stale REST → transient 502s seen once).

- S8-T8 (scheduled prod backup): .github/workflows/db-backup.yml — 3rd Sunday monthly
  15:00 UTC (cron 15-21 + Sunday gate job) + workflow_dispatch; environment backup-prod
  (main only). Supabase CLI 2.101.0 via --db-url (Session pooler): roles.sql
  (--role-only), schema.sql, data.sql (--data-only --use-copy, public + auth;
  transient/token auth tables excluded, auth.users + auth.identities kept).
  scripts/backup/manifest.mjs (plain ESM, no deps): per-table COPY row counts, per-file
  sha256, latest migration, git SHA, UTC timestamp; fails on empty files, truncated
  COPY blocks, or missing/empty public.people / auth.users. tar.gz → rclone v1.75.1
  (sha256-pinned, drive.file) → md5+size re-verified via lsf → prune >370d. Public job
  summary is minimal (no per-table counts). DB password masked raw + decoded. Not
  encrypted (owner decision). Photos (people-photos) out of scope — backlog. Restore
  procedure: docs/backups/RUNBOOK.md §0/§3a. Live verify pending (first manual run +
  restore drill).

- S8-T8 VERIFIED (2026-10-16): scheduled backup live — 3rd Sunday monthly 22:00 WIB
  (15:00 UTC) plus manual "Run workflow" on main. First green run after two fixes (owner's
  PROD_DB_URL password; rclone RCLONE_* env collision → P37_*, c80a170). First archive
  project37-prod-backup-20261016T051754Z.tar.gz, sha256 f3ecd5…333c, 28 tables, migration
  20261007120000. Restore drill PASS on a local scratch stack: counts 28/28 == manifest;
  schema pre-check 28/28 tables, 309/309 columns; FKs 0 dangling; sequences OK; identities
  OK (every active app_user has an auth user, 11/11; every app_user without one is inactive,
  19/19 — the known S6-T2 @test.invalid rows). Restore requires pinning the scratch stack's
  gotrue to prod's Auth version (CLI default image is older); RUNBOOK §3a updated with the
  pin, a schema pre-check, and TRUNCATE without RESTART IDENTITY. Next scheduled run
  2026-10-18.

- S8-T5 VERIFIED (2026-10-16): per-instance attendee list + admin export live. Commits
  217d5d3…2ef66bc (7). /checkin/[instanceId]/attendees for any active app user (RLS server
  client, phones masked to last 4 server-side, soft-deleted excluded for every role, adults +
  children sections, first-timer badge); admin instance page renders the same shared list.
  GET /api/admin/export/instance/[instanceId] admin-only: Adults + Children sheets, WIB times,
  one export.create audit row (kind + instance id + row counts). All xlsx exports now
  neutralise formula-leading cells (strict E.164 exempt). Verification rungs (CLAUDE.md rule
  17): Local Docker ✓ (gate 1206/1206, lint/typecheck/build) / Staging ✓ (guarded [SYNTH] seed
  cefb449, 17 audit rows; owner smoke PASS) / Prod ✓ (owner: admin page + export, organizer
  masked view + export 403). Open: P1 card — listRecentAttendanceForInstance is an unguarded
  service-role server action (fenced out of S8-T5; only caller now the check-in RecentPanel).

- S8-T9 VERIFIED (2026-10-17): event instances complete only after their WIB end day is over
  (d4db5dd). flipCompletedInstances now flips scheduled → completed iff the WIB date of
  scheduled_at + events.duration_min is before today's WIB date (was: scheduled_at < now, which
  completed an instance as soon as it started and could drop it from the /checkin picker on an
  off-schedule fire). cancelled/completed never touched; idempotent. The nightly run now
  completes the previous day's events. Verification rungs (CLAUDE.md rule 17): Local Docker ✓
  (attendance-summary + digest-triggers integration; full gate since, 1206/1206) / Staging n/a
  (no cron on preview deployments, no Telegram) / Prod ✓ (owner check A clean before and after
  the first nightly run: completed/true only, no scheduled/true, no completed/false).
