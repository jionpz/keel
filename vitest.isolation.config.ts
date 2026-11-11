import { defineConfig } from 'vitest/config'
import { BASE_EXCLUDE } from './vitest.shared.js'

export default defineConfig({
  test: {
    include: ['src/execution/isolation/**/*.test.ts'],
    exclude: BASE_EXCLUDE,
    globalSetup: [],
    fileParallelism: false,
  },
})
