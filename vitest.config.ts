import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 10_000,
    // Cap worker fan-out (2026-07-05 hardening sweep). A bare `vitest run` across
    // all 389 files spawns one worker per core, each holding the heavy module
    // graph (better-sqlite3, the full tool registry, playwright) — peak RSS OOMs
    // this VPS, which is why the pre-commit hook (the only local gate) is fragile
    // and `--no-verify` becomes the fallback. Bounding concurrency trades wall-clock
    // for a survivable memory ceiling. CI sharding (.github/workflows/ci.yml) is the
    // reproducible gate; this keeps the local run from crashing.
    pool: "forks",
    maxWorkers: 4,
    minWorkers: 1,
  },
});
