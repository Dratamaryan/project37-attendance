# BDD UAT Pilot (Sprint 6, Task 11)

Five Gherkin scenarios covering the launch-critical flows a non-engineer
organizer or stakeholder should be able to read and confirm: roster import
consent mapping, check-in de-duplication, invite send with a no-email
follow-up list, photo-consent-gated publication, and retention anonymize.

**This is not a second correctness suite.** The 897 tests under `npm test`
already prove behavior, including edge cases, error paths, and races. This
pilot's value is the plain-language spec itself — the `.feature` files are
the deliverable; the step-defs behind them are thin glue that drives the
same real `lib/actions`/`lib/import` functions the vitest integration suite
calls, against the same local Docker Supabase.

## Language

The `.feature` files are written in English (each carries a `# Language:
English` header comment). This is a portfolio/CV artifact meant to be read
by a bilingual stakeholder; Indonesian Gherkin (`# language: id`) was
considered but not used. Switching a file to Indonesian is a one-line
change if wanted later — it does not require touching the step-defs, since
Cucumber matches step text independently of the `# language:` pragma
choice for `en`.

## How it runs

```
npm run bdd
```

This runs `cucumber-js` via `ts-node` (CommonJS), loading `.env.test.local`
the same way the integration tests do. It is **not** part of `npm test` —
kept as a separate script so the 897-test suite stays fast and the BDD
pilot can evolve independently.

- `*.feature` — the specs, at the repo root of this directory.
- `features/steps/*.ts` — one step-def file per feature, each importing the
  real impl function(s) it drives (e.g. `impl_createAttendance`,
  `impl_sendInvites`, `runImportCommit`).
- `features/support/world.ts` — the Cucumber `World`: fixture helpers
  (`createAppUser`, `createPerson`, `createEventWithInstance`, …) and the
  same local-Docker-only prod guard `setupTests.ts` uses (duplicated here
  since Cucumber doesn't load that file).
- `features/support/hooks.ts` — per-scenario teardown, reverse-dependency
  order (events cascade instances/attendance/invitations → people → app
  users), mirroring the `afterAll` blocks in `tests/integration/*.test.ts`.
- `cucumber.mjs` / `tsconfig.cucumber.json` — runner config. Notably needs
  `tsconfig-paths/register` alongside `ts-node/register`: several
  `lib/*.impl.ts` files (e.g. `invites.impl.ts`) import via the `@/*`
  alias internally, which ts-node does not resolve on its own. Step-defs
  themselves still use relative imports only, per plan.

## Isolation

Local Docker only — same prod guard as `setupTests.ts`. Every fixture
(people, events, app users) is scoped to phones `+62812000930xxx` or
scenario-local `randomUUID()`s, created via the `World`'s service-role
client, and torn down in an `After` hook. No real email or Telegram send —
`invite_send_no_email_list` uses a stubbed `EmailTransport`. Verified
stable and residue-free across repeated back-to-back runs.

## What this deliberately omits

Error paths, RLS-denial cases, malformed input, race conditions (e.g. the
concurrent-check-in race `ATT-04` proves in vitest), and the invite
daily-cap/resume state machine all stay exclusively in the vitest
integration suite. Each scenario here covers exactly one happy-path
headline behavior — the point is a spec a stakeholder will actually read,
not exhaustive coverage.
