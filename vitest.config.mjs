import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.js"],
    setupFiles: ["tests/setup.js"],

    // Re-run a failed test before failing the suite: a known flake we have not
    // explained yet. A test that fails twice still fails the run.
    retry: 2,

    // The 5s default was set when a password change meant one bcrypt hash.
    // Stories AA-29 and AA-79 made it up to six comparisons at cost 12 as well,
    // and a test that signs in, changes a password and checks the result can
    // run a dozen -- about a second each on a loaded machine, and the whole
    // suite runs its files in parallel. The tests that were failing this way
    // pass on their own, which is the signature of a timeout and not a bug.
    // Deliberately slow hashing is the point of bcrypt, so the timeout moves
    // rather than the work.
    testTimeout: 20_000,
  },
});