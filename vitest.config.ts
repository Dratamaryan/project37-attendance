import { defineConfig, loadEnv } from 'vite'
import path from 'path'

export default defineConfig(({ mode }) => {
  // Load .env, .env.local, .env.[mode], .env.[mode].local (empty prefix = all vars).
  // In test mode this loads .env.test.local, which overrides .env.local so
  // integration tests hit local Docker instead of production.
  const env = loadEnv(mode, process.cwd(), '')

  return {
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    test: {
      // Per-file environment overrides via // @vitest-environment pragma are used
      // for jsdom tests (app/checkin/__tests__). All other tests run in the
      // default node environment.
      setupFiles: ['./setupTests.ts'],
      globals: true,
      env,
    },
  }
})
