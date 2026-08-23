import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: ['./vitest.globalSetup.ts'],
    env: {
      KEEL_DATABASE_URL: process.env.KEEL_DATABASE_URL ?? 'postgres://localhost/keel_test',
    },
  },
})
