import { describe, it, expect } from "vitest";
import { isPgvectorEnabled } from "../db/pgvector.js";

// Rule: no test reaches the live vector store, whatever the shell that starts
// the run exports. The store's client switches itself on when its key variable
// is merely present, and every in-memory database seeds directives that it
// syncs, so an inherited key would send real writes from ordinary tests. The
// per-worker setup file (vitest.setup-env.ts) deletes the key before any test
// file loads; a test that needs the client on sets its own dummy key.
describe("test worker environment", () => {
  it("carries no vector-store key, so the store client stays off", () => {
    expect(process.env.COMMIT_DB_KEY).toBeUndefined();
    expect(isPgvectorEnabled()).toBe(false);
  });
});
