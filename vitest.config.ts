import { defineConfig } from 'vitest/config';

// Node-only unit tests for the pure-logic modules in src/core.
// No jsdom needed — anything that touches the DOM or R3F stays out.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
