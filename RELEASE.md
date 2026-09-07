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
  "branches": { "main": "bftifxgdcmisasgvobuf", "release/*": "bftifxgdcmisasgvobuf" }
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
- **Map extension (S8).** Add staging (`sijfyvaodqkawbeuyrpu`) entries for feature
  branches once staging is adopted, so feature work can target staging instead of
  being denied all remote ops.

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
