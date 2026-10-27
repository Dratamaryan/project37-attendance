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

- S8-T6 VERIFIED (2026-10-18): birthday digest one day ahead (H-1) + consent badge fix
  (f61dcd4). The 07:00 WIB cron now greets tomorrow's WIB birthdays; non-leap years fold
  Feb-29 into the Feb-28 cohort; age as of the cohort year; header "Ulang tahun besok — <date>".
  Claim key system_health(birthday-digest, ict_date = cohort date); payload/result carry
  send_date + cohort_date; Run now shares the slot; audit entityId uses the cohort. Badge: the
  boolean is the gate, photo_consent_state only adds ❓ (unknown no longer shown as refused).
  Deploy-day Run now (2026-10-17) sent cohort 10-18 (count 4) to the new supergroup
  (telegram_admin_chat_id switched by SQL); the 2026-10-18 cron sent cohort 10-19. Transition
  10-16/10-17 old-style, 10-18/10-19 new: no gap, no duplicate. Verification rungs (CLAUDE.md
  rule 17): Local Docker ✓ (gate 1219/1219, lint/typecheck/build) / Staging n/a (no cron on
  preview deployments, no Telegram) / Prod ✓ (owner). Open: setPhotoConsent writes only the
  boolean (consent-state drift, tracked separately); no cross-day retry for a missed cohort.

- S8-T10 VERIFIED (2026-10-17): admin "Add person" live (f37fa97, 54309b8). /admin/people/new
  (requireActiveAdmin) — short form phone → full name → nickname → birth date (required) calling
  the existing createPerson (no new insert path; people.create audit and consent 'unknown'
  unchanged), then redirect to /admin/people/[id] for every other field. Duplicate phone blocks
  with "already registered as {name}" + link (none for the empty-id fallback); a soft-deleted
  holder reads "(deleted)" + "Open to restore" — createPerson's duplicate_phone.existing now
  carries deleted_at (23505 path). Similar-name warning: debounced lookupByName on full name +
  first token, deduped, masked phone tails + links; Submit held until "Continue anyway", re-checked
  at submit. "+ Add person" header link; admin.people.add.* en + id. Third local useDebounce copy
  (extraction backlog). Verification rungs (CLAUDE.md rule 17): Local Docker ✓ (gate 1250/1250,
  lint/typecheck/build) / Staging ✓ ([SYNTH] smoke 5/5; 3 people.create audit rows, 0 null actors)
  / Prod ✓ (owner). Tracked prod test residue: 1 people row (+62999 test phone), soft-deleted.
  Open: confirm 2 pre-existing non-+62999 staging people are synthetic.

---

## 9. S9 task log

- S9-R0 VERIFIED (2026-10-22): RSVP schema, admin-only RLS, gated anon RPCs (05c5f86;
  migration 20261020120000_sprint9_r0_rsvp.sql). event_rsvp_links (one active link per
  instance) + event_rsvps (one row per instance+phone); anon has no table privileges and no
  policy, admin-only FOR ALL policy for authenticated. Public path is two SECURITY DEFINER RPCs
  with EXECUTE for anon only: get_rsvp_context (any closed or unknown state returns exactly
  {"open":false}) and submit_rsvp (Vault 'rsvp_gate' checked before any token lookup; the same
  {"ok":true} body for members and newcomers; never writes people, attendance or audit_log).
  rsvp_instance_open is owner-only and is the SQL twin of instanceEndWibDate (now exported from
  lib/events/timezone.ts). Verification rungs (CLAUDE.md rule 17): Local Docker ✓
  verified:vitest (rsvp-rpc 48 tests incl. RLS admin/organizer, gate before token, TS↔SQL
  parity; gate 1298/1298, lint/typecheck/build) / Staging ✓ verified:server-side (catalog SQL)
  + verified:live-staging (s9-r0-staging-smoke 15/15, zero residue) / Prod ✓
  verified:server-side (catalog SQL; rsvp_rows 0→0) + verified:live (s9-r0-prod-verify,
  anon-only no-write, 6/6). Catalog matrix identical on staging and prod: EXECUTE 2/12 (anon on
  the two RPCs only), helper owner-only, owner postgres, search_path public, pg_temp, PG 170006.
  Posture: the open-context and right-gate submit paths are verified on staging only. Prod has
  no RSVP writes until R1/R4 go-live, and the prod gate secret is in Vault only (not on the dev
  machine). Staging smoke audit rows (event.create, people.create, data.wipe) kept on purpose.
  No real PII at any rung. Backlog: shared createAppUser test helper (S11-T15).
- S9-P0 VERIFIED (2026-10-24): event image upload to a public Storage bucket (64c30a7;
  migration 20261022120000_sprint9_p0_event_images.sql). event-images bucket (public, 4 MB,
  jpeg/png/webp) with one policy, event_images_admin_all (FOR ALL TO authenticated, is_admin());
  no organizer or anon policy. uploadInstanceImage / removeInstanceImage server actions (RLS
  server client, requireActiveAdmin) with magic-byte validation, never-overwrite paths
  instances/<instance>/<uuid>.<ext>, 1-year cache-control, event_image.upload /
  event_image.remove audit (instance_id). event_instances.image_url stores the public URL;
  paste-a-URL removed (updateInstance no longer accepts image_url); admin instance-page
  thumbnail; invite email HTML-attribute-escapes the image URL. Verification rungs (CLAUDE.md
  rule 17): Local Docker ✓ verified:vitest (event-images 16 + validator 13 + template/page
  additions; gate 1327/1327, lint/typecheck/build) / Staging ✓ verified:server-side (catalog
  SQL) + verified:live-staging (owner UAT 2026-10-24: upload, thumbnails, public URL in a
  private window, wrong type and > 4 MB rejected, replace/remove, old URL still serves;
  s9-p0-staging-smoke 7/7) / Prod ✓ verified:server-side (catalog SQL) + verified:live (owner
  uploaded a real poster to a real upcoming occurrence; s9-p0-prod-verify, anon-only no-write,
  7/7). Posture: rendering on the anon RSVP page moved to S9-R1; organizer denial proven locally
  (RLS 42501) with the identical policy confirmed by catalog on staging and prod; old objects
  retained by design (sent invites embed the URL); local storage container now v1.80.2
  (matches the linked remote pin). Backlog: escape event names in the invite email (S11-T16).
- S9-R3 VERIFIED (2026-10-24): admin RSVP panel, cross-tab view, export and person history
  (a3ef562 + f291ca5; migration 20261024120000_sprint9_r3_rsvp_crosstab.sql).
  rsvp_checkin_crosstab (security_invoker, rows only when is_admin(); REVOKE ALL from PUBLIC,
  anon and authenticated, then SELECT to authenticated only) resolves each RSVP to a person by
  person_id or a live roster phone match and buckets it against check-ins (7 values incl.
  walk_in); read-time only, never writes attendance. Admin instance page: on-demand RSVP link
  (get/deactivate behind server-only RSVP_PUBLIC_ENABLED; rsvp.link_create /
  rsvp.link_deactivate audit), copy + WhatsApp share (ID default, EN toggle), totals (headcount
  = Σ 1 + children_count), cross-tab, children expected vs checked in, response list with
  junk-delete (rsvp.delete audit). GET /api/admin/export/instance/[id]/rsvp: admin-only xlsx
  (Responses + Summary), full phone only where follow-up consent, sheet-safe, export.create
  audit with full_phone_rows. Person page: RSVP history read from the view. Panel and export
  share one row builder. Verification rungs (CLAUDE.md rule 17): Local Docker ✓ verified:vitest
  (rsvp-admin 35, rsvp-export-route 13, rsvp-person-history 9 + unit/page/component; gate
  1429/1429, lint/typecheck/build) / Staging ✓ verified:server-side (catalog SQL) +
  verified:live-staging (s9-r3-staging-uat 13/13; owner UAT 2026-10-24: totals, buckets and
  list exact, WhatsApp ID+EN text and dates, export phone rule and Summary exact, person
  history, delete, deactivate → new token; cleanup zero residue) / Prod ✓ verified:server-side
  (catalog SQL) + verified:live (owner: not-live note, zero panel, empty export, empty history;
  anon view read 42501). View catalog identical on staging and prod: 1 of 24 privilege cells
  (authenticated SELECT), security_invoker=on, is_admin() filter. Posture: the public page is
  S9-R1 (links 404 until then); prod RSVP_PUBLIC_ENABLED off until go-live; staging behind
  Vercel Deployment Protection; service role reads zero rows from the view by design (every
  reader uses the admin RLS session). Staging UAT audit rows kept on purpose. No real PII at
  any rung. Backlog: StatusBadge i18n + duplicate child-row testid (S11-T17).
- S9-R1 VERIFIED (2026-10-24): public RSVP form /rsvp/[token] (564c2c7 + 533ffec; no
  migration). Anon page + server action through a cookie-less server-only anon client
  (lib/supabase/anon.ts, CLAUDE.md rule 12's 4th client) calling the R0 RPCs; server-only
  RSVP_GATE_SECRET, unset → fail closed ("unavailable"), never logged. Hadir / Mungkin / Tidak
  hadir, phone normalized with region ID ('+' for foreign numbers), optional name, children 1..20
  (hidden when not attending), one follow-up consent box (interim copy until R5) + privacy link.
  The success state carries only the visitor's own status and children, identical for member and
  newcomer (no name or phone echoed). One generic "not available" view for every dead link; 404
  while RSVP_PUBLIC_ENABLED is off. Locale = cookie else id, never the admin default
  (i18n/request.ts now honors an explicit locale override). Metadata noindex/nofollow,
  no-referrer, og:image = poster. Verification rungs (CLAUDE.md rule 17): Local Docker ✓
  verified:vitest (rsvp-public 14 incl. member/newcomer deep-equal, resubmit, closed / flag off /
  missing and wrong gate write no row, limit; parse/format unit, page/metadata, form incl.
  consent-unticked; gate 1570/1570, lint/typecheck/build) / Staging ✓ verified:live-staging
  (owner UAT A–H through the real page 2026-10-24; s9-r1-staging-uat verify: all planned-row
  assertions PASS — member matched with typed name discarded and updated in place, newcomer
  stored without a person, consent withdrawn on resubmit, no people or attendance writes;
  successful submits prove the Preview gate secret; cleanup zero residue) / Prod ✓ verified:live
  (owner: /rsvp/<anything> → 404, admin panel not-live). Deviation: one off-plan manual owner
  submit left a stray synthetic row (v-count 3, v-phones 1), removed by cleanup; not an app
  defect. Posture: prod RSVP_PUBLIC_ENABLED off until go-live; no IP/UA capture; staging UAT
  audit rows kept on purpose. No real PII at any rung. Open (prove later): admin-default-en
  override end-to-end (R4 staging); WhatsApp og:image card + prod gate secret (R6 go-live).
  Backlog: <html lang> follows the admin default on /rsvp (S11-T18).
- S9-R4 VERIFIED to staging (2026-10-25; prod rung pending): public RSVP abuse controls
  (33c7c05 + 93a4c35 + 50bf8b7; no migration, submit_rsvp unchanged). Order in impl_submitRsvp:
  flag → token → parse → honeypot → throttle → Turnstile (if enabled) → gate → RPC; every block
  happens before the gate read. Honeypot 'website' (off-screen aria-hidden, tabIndex -1) → fake
  success, nothing written. Soft per-IP throttle in memory per instance: sha256(ip):token, 20 /
  10 min, 5000-key cap; raw IP never stored/logged/persisted; no IP → skipped. Invisible
  Cloudflare Turnstile via app-side siteverify (not Supabase [auth.captcha], which is GoTrue-only
  and stays commented out): server-only RSVP_TURNSTILE_ENABLED / _SITE_KEY / _SECRET_KEY (no
  NEXT_PUBLIC_; site key passed as a prop), fail closed when enabled, action 'rsvp', no remoteip.
  Widget hand-rolled (no dependency): submit disabled until a token, reset after every
  non-success, inline note when the script is blocked or no token arrives within 15 s (re-armed
  on expiry/error, F1). Throttle / Turnstile failures → existing 'unavailable'. R1 (G) closed: no
  response-time floor (member/newcomer statement-identical; ~0.13–0.14 ms local). Verification
  rungs (CLAUDE.md rule 17): Local Docker ✓ verified:vitest (turnstile / throttle / order /
  fail-closed / form / page tests; live-DB honeypot, throttled and Turnstile-fail write no row;
  gate 1651/1651, lint/typecheck/build) / Staging ✓ verified:live-staging (2026-10-25, git-staging
  deploy of 50bf8b7; Turnstile off: no widget, OFF submit ok, honeypot → thank-you + zero rows,
  tab order skips the honeypot; admin default en → cookie-less /rsvp still Indonesian, restored
  to id; Turnstile on: invisible widget issues a token under no-referrer, ON submit ok, tampered
  token → generic try-later + zero rows; s9-r4-staging-uat verify 9/9 PASS, cleanup zero residue)
  / Prod pending (/rsvp/* → 404 after main fast-forward). Throttle and log-line content are
  verified:vitest only (in-memory state across Fluid instances is not deterministically testable
  live; no runtime log access by design). End state: staging RSVP_TURNSTILE_ENABLED=true;
  Production Turnstile widget + RSVP_TURNSTILE_* not created yet (R6 go-live). No real PII at any
  rung. Detail: docs/sprint-9-task-r4-verify.md (local).
- S9-R2 VERIFIED to staging (2026-10-26; no prod rung, R2 ships no deploy): public RSVP member
  match / newcomer behaviour, verify-only (4e2211c; no app code, no migration). Pinned: newcomer
  → roster add → resubmit keeps the row and links person_id with name NULL; a soft-deleted
  member resubmitting is stored unlinked (typed name kept, blank → NULL); the member's people row
  is never written; resubmit keeps id/created_at, advances updated_at, old token after rotation
  → closed; five phone formats → one row; overseas +61 matches; panel shows roster name for
  members, typed name for newcomers; known limitation pinned (foreign number without '+' is read
  as Indonesian). Verification rungs (CLAUDE.md rule 17): Local Docker ✓ verified:vitest
  (rsvp-match 9/9 + public unit; gate 1665/1665, lint/typecheck/build) / Staging ✓
  verified:live-staging with operator deviation (s9-r2-staging-smoke, owner steps through the
  real page: member matched with typed name dropped, resubmit in the other format overwrote the
  same row, member people row deep-equals snapshot, typed name stored nowhere, no attendance;
  final verify 6/8 PASS — the 2 FAILs are operator typos: NEWCOMER typed as …2433 instead of
  …2796, that row has the correct newcomer shape but the strict check is unmet; a stray …2432
  row was removed via the admin panel between verify runs; cleanup zero residue). Roster-name
  display (step E) not observed live — verified:vitest only (G7), as are the f/g edge cases,
  variants and overseas. No real PII at any rung. Lesson for R6: script a "drive" phase that
  submits via the staging RPC with the gate secret; owner steps visual-only with one-line pass
  criteria. Detail: docs/sprint-9-task-r2-verify.md (local).
- S9-R5 VERIFIED (2026-10-26): RSVP retention + privacy policy v2 (9c4bb9c + 91eba64; migration
  20261026120000_sprint9_r5_rsvp_retention.sql). RSVP phone + name anonymized N = 90 days
  (app_settings.rsvp_retention_days, NOT NULL DEFAULT 90, CHECK > 0) after the instance ends
  (end WIB date, same expression as rsvp_instance_open; all statuses incl. cancelled) by
  run_rsvp_retention_pass (service_role only; own fail-safe guard, separate from
  run_retention_pass): phone/name → NULL, anonymized_at set, person_id / status / children /
  followup_consent / updated_at kept (M1), and the person the crosstab resolves at scrub time is
  frozen in event_rsvps.retained_person_id; one rsvp.anonymize audit row per instance (counts
  only, actor NULL); idempotent. anonymize_person also scrubs the person's RSVPs (own rows +
  newcomer rows on their old phone; frozen only if the person was live; rsvp_rows in the audit).
  rsvp_checkin_crosstab reads COALESCE(person_id, retained_person_id, phone match), so a scrub
  never changes buckets, panel or person history. consent_policy_version → v2, shipped with the
  v2 text (id + en, verbatim from the owner's docs; Cloudflare Turnstile Privacy Addendum
  linked). Cron route runs both passes regardless of the other's result (B1) and reports
  anonymized_count + rsvp_anonymized_count. Panel / export: "Anonymized" replaces only a
  newcomer's typed-name fallback, follow-up label hidden, phone empty, excluded from
  full_phone_rows (D1). Form: consent key renamed (text unchanged), privacy link opens in a new
  tab. PolicyMarkdown renders https:// links only. Verification rungs (CLAUDE.md rule 17): Local
  Docker ✓ verified:vitest (rsvp-retention T1–T7 incl. crosstab/panel/history invariant, WIB
  boundary, grants; cron route unit; export / panel / form / PolicyMarkdown / privacy page;
  gate 1734/1734, lint/typecheck/build) / Staging ✓ verified:live-staging (2026-10-26, run by
  Claude Code under owner delegation: guarded dry-run listed exactly the R5 migration, push,
  post-push catalog — 90/v2, retained_person_id uuid nullable, both functions EXECUTE
  service_role only, crosstab security_invoker=on; git-staging deploy of 91eba64;
  s9-r5-staging-smoke setup / drive returned 4 / verify 8/8 PASS / cleanup zero residue;
  V1 /privacy "Versi: v2", V2 Cloudflare addendum in a new tab, V3 RSVP policy link in a new tab
  with the typed phone kept) / Prod ✓ verified:live (owner checks 1–4 PASS; check 5, a manual
  authorised cron call, not run — cron route verified:vitest, function verified:live-staging).
  Deviation: V3 had no open staging link; with owner approval the S9-R2 smoke setup provided one
  (nothing submitted) and its cleanup removed it with zero residue. Posture: scrubbed phones
  persist in Drive backups up to 370 days; anonymize_person's RSVP scrub and the D1 display are
  verified:vitest only. No real PII at any rung. Open: confirm both counts on the first
  scheduled prod cron run. Backlog: 16 audit actions still unlabeled in the audit-log UI; no
  admin UI for retention settings. Detail: docs/sprint-9-task-r5-verify.md (local).
- S9-R7 VERIFIED (2026-10-27): RSVP analytics on /admin/analytics (0450cc9 + eadc859 + 0d19aa8;
  migration 20261026180000_sprint9_r7_rsvp_instance_metrics.sql). View rsvp_instance_metrics
  (security_invoker=on, own is_admin() filter, REVOKE ALL anon, SELECT authenticated): one row
  per non-cancelled, ended instance with any RSVP link (active or deactivated); RSVP counts from
  rsvp_checkin_crosstab (coming people / headcount Σ1+children, maybe, coming came / no-show,
  walk-ins, newcomer RSVPs, became members as of last submit), actual adults / children = every
  attendance / child_attendance row (soft-deleted kept), funnel from 'sent' invitations
  (responded via a DISTINCT resolved-person CTE, attended via attendance — P1 reshape; local
  EXPLAIN 138 ms at 30 instances × 200 RSVPs × 150 invitations, no per-invitation crosstab).
  impl_getRsvpAnalytics: requireActiveAdmin, paging, from/to on scheduled_at with WIB day
  bounds (to inclusive), eventType; pooled Σ/Σ KPIs, zero denominator → '—'; no-show shown as
  100 − rounded show-up. UI: RSVP section below Top Attendees — 12 KPI cards + RSVP-vs-actual
  ComposedChart (dynamic ssr:false), en + id. Verification rungs (CLAUDE.md rule 17): Local
  Docker ✓ verified:vitest (rsvp-analytics view/impl/access incl. retention-frozen
  became_members, pooling + WIB-bound unit tests, RsvpSection / RsvpVsActualChart component
  tests; gate 1768/1768, lint/typecheck/build) / Staging ✓ verified:live-staging (2026-10-27,
  run by Claude Code under owner delegation: first dry-run refused by the guard — CLI still
  linked to prod from R5; owner relinked; dry-run listed exactly the R7 migration, push,
  post-push security_invoker=on / anon SELECT false / authenticated SELECT true, INSERT false;
  git-staging deploys of eadc859 and 0d19aa8; s9-r7-staging-smoke setup on 2026-10-07 / verify
  6/6 PASS twice / cleanup zero residue; V1 cards 6 · 67% · 33% · 40% · 1 PASS; V2 values PASS
  but legend/tooltip contrast FAIL → fixed in 0d19aa8 → V2 re-run PASS) / Prod ✓ verified:live
  (owner checks 1–3 PASS). Defect: Recharts drew the coming-headcount legend + tooltip text in
  the bar's cream fill; not caught locally because component tests stub the chart. Deviations:
  smoke recomputes pooling (app pooling verified:vitest + V1). Observed pre-existing (R6 item
  18): old KPI cards filter on checked_in_at and Top Attendees ignores dates. No real PII at any
  rung. Detail: docs/sprint-9-task-r7-verify.md (local).
- S9-R6 A1 STAGING VERIFIED (2026-10-27; prod pending): anon-surface hardening (4475b10;
  migration 20261027120000_s9_r6_anon_surface_hardening.sql, decisions D1/D2/D5/D6, AC 5/14/17).
  D1: REVOKE ALL anon + PUBLIC on the five S3 views; authenticated keeps SELECT only. D2: PUBLIC
  EXECUTE revoked on is_admin / is_organizer / is_active_app_user (anon kept on purpose — anon
  still holds the default legacy-table grants, so TO-public policies call them as anon; revoke
  deferred to S11-T12) and PUBLIC + anon on enforce_last_admin. D5: next.config headers on
  '/:path*' — X-Frame-Options DENY, CSP frame-ancestors 'none', nosniff (nothing else). D6:
  setLocale accepts only same-origin redirectTo ('/…', not '//' or '/\'). CLAUDE.md rules 18/19:
  staging delegation + staging release report standard. Verification rungs (rule 17): Local
  Docker ✓ verified:vitest (s9-r6-anon-surface 34/34 — whole-schema anon-EXECUTE allowlist
  incl. a probe-function negative check, helper ACLs, view/RSVP-table privileges,
  people_phone_e164_key indisunique + no predicate, anon RPC / admin + organizer / last-admin
  regression; headers + setLocale unit tests; gate 1810/1810, lint/typecheck/build; T2-Seed-RLS-
  02/09 unchanged) / Staging ✓ (run by Claude Code under delegation: baseline Q1/Q2 matched the
  owner's prod audit; dry-run listed exactly this migration; push; Q1 diff = the 5 views, PUBLIC
  off the 4 functions, anon off enforce_last_admin only, Q2 unchanged — verified:server-side;
  git-staging deploy of 4475b10; s9-r3-staging-uat setup / rsvps 13/13 PASS / cleanup zero
  residue and live headers on /rsvp/<token>, /dashboard, /privacy — verified:live-staging;
  unauthenticated /login headers verified:local-build) / Prod: pending owner push + owner checks.
  No real PII at any rung. Detail: docs/sprint-9-task-r6-a1-verify.md (local).
- S9-R6 A2 STAGING VERIFIED (2026-10-27; prod pending): admin RSVP health check (69fefec; no
  migration; decision D7, AC 12). Settings "RSVP health" card, on-demand only (never on render),
  admin-only (requireActiveAdmin + explicit role check; organizer/anon rejected), read-only, not
  audited. Gate probe: anon submit_rsvp with the env gate and token 'rsvp-health.probe' ('.' never
  occurs in a generated token -> 'closed' before validation/cap/insert): closed -> match,
  unavailable -> mismatch, unset env -> missing-env (no RPC), anything else (incl. ok:true) ->
  unknown. Turnstile: classifyTurnstileSecret posts siteverify with a dummy token (no remoteip,
  5 s timeout, no-store): secret codes -> invalid-secret, success:true -> always-pass (architect
  F1: Cloudflare test secret = bot protection off -> Problem), invalid-input-response -> valid,
  else unknown; runs even when Turnstile is off. Probes in parallel, each capped at 6 s. No secret
  value/length/prefix/hash returned, logged or rendered. en + id copy (N1 mismatch wording).
  Verification rungs (rule 17): Local Docker ✓ verified:vitest (classify + impl unit, render/
  sentinel SENTINELGATE222/SENTINELTSSECRET333/site key absent from action result and DOM,
  integration correct gate -> match / wrong gate -> mismatch with event_rsvps count unchanged,
  authz anon/organizer rejected + admin ok, en/id parity; gate 1862/1862, lint 0 errors,
  typecheck, build) / Staging ✓ verified:live-staging (run by Claude Code under delegation: no db
  push; git push staging; deploy dpl_2QtYWQbTqWr8xRArMNm68iiuRya6 READY; event_rsvps count 0 ->
  Run check as admin on the git-staging alias -> 0, max created/updated_at null both times; card:
  environment preview, Public RSVP On, Gate secret OK (match), Turnstile OK (on, both keys, secret
  valid); staging gate value absent from card text) / Prod: pending owner push + owner checks.
  No real PII at any rung.
- S9-R6 B STAGING VERIFIED (2026-10-27): automated RSVP BDD/UAT on staging (abd9c48; no migration;
  AC 16, R5 vitest-only gaps, R7 chart gap). scripts/s9-r6-staging-uat.ts (tsc->node, pinStaging,
  [SYNTH] + run-id +62999 phones, 0600 state, re-runs refused): setup / drive / anonymize / verify /
  cleanup. Real submit_rsvp over raw HTTP with phones typed local / plain / spaced / dashed /
  paren and normalised by the compiled normalizePhone: D1 member (sent name ignored), D2+D3 one N1
  row updated in place (blank name keeps D2's), D4 maybe, 3 rows on an ended-today instance for the
  chart; negatives wrong gate / unknown token / status 'yes' -> unavailable / closed / invalid with
  0 rows written; member vs newcomer responses byte-identical. anonymize_person scenarios of
  rsvp-retention.test.ts:557-627 mirrored (live member own row + frozen newcomer row; soft-deleted
  person own row + unfrozen newcomer row; updated_at kept; crosstab unchanged; re-run no-op).
  RsvpVsActualChart.render.test.tsx renders the REAL chart (no stub) at a fixed 600x280. Verification
  rungs (rule 17): Local ✓ verified:vitest (gate 1865/1865, lint 0 errors, typecheck, build) /
  Staging ✓ (run by Claude Code under delegation: deploy dpl_D8zjgN9Qgw7R5GDoybbK1Bhoye8X READY;
  drive 11/11, verify 31/31 — verified:server-side; V1 panel pre/post, V2 export, V3 person RSVP
  history, V4 chart (bar 117.2 px = 5 units = KPI), V5 one public-form submit with live Turnstile —
  verified:live-staging; cleanup zero residue). Findings: post-anonymize the panel/export show
  "Removed member" (code rule), not "Anonymized"; chart colours are hex literals equal to the
  globals.css tokens, not var() references. No real PII at any rung. Prod: no change (tests only).
- S9.5-T2 STAGING VERIFIED (2026-10-27): Project Day moves from the 2nd Friday to the 2nd Saturday
  from Nov 2026 via a NEW series (Option B) (7934dd0; migration
  20261027180000_s9_5_t2_saturday_monthly_enum.sql). event_type_enum += saturday_monthly (drift
  guard: labels must be the known 4, or 4 + saturday); preset → FREQ=MONTHLY;BYDAY=2SA; labels
  en+id at all three sites. Invite guard: sendInvites/resendInvite return instance_not_open unless
  instance 'scheduled' AND event active (localized UI). Owner SQL scripts/s9-5/
  t2-retire-friday-series.{staging,prod}.sql + ROLLBACK variants from one template per direction
  (generate-t2-sql.mjs --check): exact-snapshot preflight, idempotent, never DELETE, post-asserts,
  audit log_audit(NULL, ...) + 'trigger' (R5 convention). Verification rungs (rule 17): Local ✓
  verified:vitest (gate 1876/1876, lint 0 errors, typecheck, build; owner-SQL rehearsal 23/23 on
  local Docker: tampered abort zero writes, apply, re-run no-op, mixed-state abort, rollback refused
  while a Saturday series exists, rollback, rollback re-run no-op) / Staging ✓ (run by Claude Code
  under delegation: dry-run = this migration only, db push, deploy FEKbeZ4ivVtbAN8wMTgVoRfwj9si
  success; staging SQL: Friday 9ae8cfb8 inactive, 11/11 Nov+ cancelled, 12 NULL-actor audit rows,
  re-run no-op; OWNER-APPROVED DEVIATION, no browser: Saturday event 8c3385f3 created via
  impl_createEvent under the staging admin session (instances_created 12), all
  verified:server-side — 12 Saturdays 11-14..2027-10-09 dow 6 15:00, materializer inserted 0 /
  pruned 0, picker offers 11-14 and no Friday, RSVP link minted + get_rsvp_context open, page
  formatter "Sabtu, 14 November 2026" (public page behind Vercel protection, not bypassed), invite
  on cancelled Friday instance_not_open with 0 sends). UI not live-verified on staging — owner UI
  checklist in the prod runbook. Staging snapshot has 11 Friday instances (stale horizon, no
  staging cron). Prod: pending owner (db push, main fast-forward, prod SQL, UI create).
- S9.5-T2 PROD VERIFIED (2026-10-27): Fri→Sat Project Day series live on prod (bftifxgdcmisasgvobuf),
  run by the owner 17:45–19:09 WIB with main at 17fcd30. Migration 20261027180000
  (saturday_monthly) pushed; production deploy READY. P7 t2-retire-friday-series.prod.sql: Success —
  Friday Project Day 4f9eb395 inactive, 12 Nov+ instances cancelled with the S9.5 note, 13
  system-actor audit rows (12 event_instance.cancel + 1 event.update). P8 Saturday "Project Day"
  created in the prod UI: saturday_monthly, 2026-11-14 15:00 WIB, 180 min, Hotel Neo Puri Indah →
  "Event created — 12 instances scheduled". P10: Friday 12 cancelled (2026-11-13..2027-10-08, dow 5);
  Saturday 12 scheduled (2026-11-14..2027-10-09, dow 6, 15:00 WIB); Tribe Connect 12 scheduled,
  unchanged. P11: 14 Nov RSVP link minted. The ROLLBACK script now refuses by design
  (a saturday_monthly event exists). Verification rungs (rule 17): Local ✓ / Staging ✓
  (verified:server-side, see the staging entry above) / Prod ✓ verified:live (owner: event form,
  success banner, events list, P10 SELECT, RSVP mint); /checkin and the public RSVP page per owner
  report. No real PII at any rung.
