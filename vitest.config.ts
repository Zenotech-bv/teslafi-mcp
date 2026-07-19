import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Every test mocks axios at the module boundary; nothing may ever reach
    // the real teslafi.com. Keep the suite fast and deterministic.
    testTimeout: 15000
  }
});
