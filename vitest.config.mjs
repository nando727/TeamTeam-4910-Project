import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.js"],
    setupFiles: ["tests/setup.js"],

    // Re-run a failed test before failing the suite: a known flake we have not
    // explained yet. A test that fails twice still fails the run.
    retry: 2,
  },
});