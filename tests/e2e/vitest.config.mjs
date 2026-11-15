import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.e2e.mjs"],
    // One app window at a time: the tests share the recent-files store.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 90000,
    hookTimeout: 90000,
  },
});
