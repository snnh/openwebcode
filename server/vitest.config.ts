import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Windows hosted runners can be heavily contended: otherwise healthy
    // process/filesystem E2E cases regularly exceed Vitest's 5s default.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
