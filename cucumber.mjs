// S6-T11: BDD UAT pilot. Deliberately separate from vitest.config.ts / the
// `npm test` 897 — this is a stakeholder-readable spec artifact, run only via
// `npm run bdd`. See features/README.md for what this is and isn't.
const config = {
  // tsconfig-paths/register resolves the `@/*` alias that several lib/*.impl.ts
  // files use internally (ts-node does not honor tsconfig "paths" on its own).
  requireModule: ['ts-node/register', 'tsconfig-paths/register'],
  require: ['features/support/**/*.ts', 'features/steps/**/*.ts'],
  paths: ['features/**/*.feature'],
  format: ['progress'],
  publishQuiet: true,
}

export default config
