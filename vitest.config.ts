import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    hookTimeout: 60000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*'],
      exclude: ['src/index.ts'],
    },
    fileParallelism: false, // Prevents concurrent test files
  },
});
