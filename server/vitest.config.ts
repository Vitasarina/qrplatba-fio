import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Tests use real timers and tiny intervals; keep them isolated.
    pool: "forks",
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
