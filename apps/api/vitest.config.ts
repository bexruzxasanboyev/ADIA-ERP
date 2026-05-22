import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    globals: false,
    testTimeout: 15000,
    // Each integration suite owns its own schema; running suites serially
    // keeps the shared app pool / config singletons unambiguous.
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      // Integration tests run inside an isolated schema in this database.
      // Override with a real TEST_DATABASE_URL when adia_erp_dev exists.
      TEST_DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        'postgres:///personal_ai?host=/var/run/postgresql',
    },
  },
});
