import { defineConfig } from 'vitest/config';

// Native modules (SQLite, sodium) use N-API, so main-process tests run under plain Node.
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
  },
});
