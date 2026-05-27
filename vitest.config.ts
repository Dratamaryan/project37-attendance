import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
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
  },
})
