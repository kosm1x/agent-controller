import { afterAll, afterEach, expect, vi } from "vitest";
import { dropOutsideCallEnv } from "./src/test-utils/outside-call-env.js";
import {
  recordOutsideConnections,
  takeRefusedConnections,
} from "./src/test-utils/outside-connect-record.js";

// 2026-10-30: a pre-commit run from a linked worktree exported GIT_DIR/GIT_INDEX_FILE to the
// suite; a fixture's `git init` inherited them and reinitialized the real repo as bare.
// Every worker drops inherited GIT_* keys before any test file runs.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) delete process.env[key];
}

// The vector-store client switches on when its key is merely present, and every
// in-memory database seeds directives that it syncs: no worker keeps an inherited
// key, so no test can write to the live store. A test that needs the client on
// sets its own dummy key after this file runs (pinned by src/lib/test-env.guard.test.ts).
delete process.env.COMMIT_DB_KEY;

// A test supplies the keys it needs itself; none is inherited from the shell
// that starts the run. Each name in src/test-utils/outside-call-env.ts, set
// alone or together with the others its client needs, switches on a call to
// an outside service from code a test can reach, so an inherited value would
// turn an ordinary test into a real, possibly billed request. Every worker
// drops them and records the count it dropped (the marker shows the drop ran
// in this worker); a test that needs one sets its own value after this file
// runs (pinned by src/lib/test-env.guard.test.ts).
(globalThis as typeof globalThis & { __outsideCallEnvDropped?: number })
  .__outsideCallEnvDropped = dropOutsideCallEnv(process.env);

// No test connects to another machine. An attempt to a host that is not this
// machine (a loopback address in any form, localhost or a name under
// .localhost, the ip6-localhost and ip6-loopback aliases, a local socket path)
// is refused before anything is resolved or dialled: the caller gets an
// ordinary connection error naming the host, the port and the rule. A caller's
// catch can swallow that error, so each attempt is also recorded (one line:
// test file, test name, host, port, in mc-test-outside-connections.jsonl in
// the folder TMPDIR names) and the afterEach below fails the test that made
// it; an attempt made while the file loads or in a beforeAll fails the first
// test, and the afterAll fails the file for one made after its last test. A
// test hands the code a stand-in for the connection or a listener on
// 127.0.0.1; one that wants a refusal empties the record itself. Child
// processes and worker threads are not covered (pinned by
// src/lib/test-env-connect.guard.test.ts).
const connectGuard = recordOutsideConnections(() => {
  const state = expect.getState();
  return { path: state.testPath, name: state.currentTestName };
});

afterEach(() => {
  const failure = takeRefusedConnections(
    connectGuard.hits,
    "in this test (or while the file loaded, or in a hook before it)",
  );
  if (failure) throw new Error(failure);
});

afterAll(() => {
  const failure = takeRefusedConnections(connectGuard.hits, "after the last test");
  if (failure) throw new Error(failure);
});

// No test reaches a real model, whatever the code under test does. Every model
// call in the source ends in the agent SDK's `query`, and the shell that starts
// a run may be signed in, so a real call would succeed and be billed. The
// package is mocked for every test file: its other exports stay real (tool
// objects are built from them at import time) and `query` throws. A caller's
// catch can swallow that throw, so each call is also recorded and the afterEach
// below fails the test that made it; the afterAll fails the file for a call
// made after its last test. A test file's own vi.mock of the package replaces
// this guard for that file; a mock of src/inference/claude-sdk.ts does not
// remove it, since every wrapper export the file leaves real still ends here.
// A test that wants the throw empties the record itself (pinned by
// src/lib/test-env.guard.test.ts). The record is per worker, not per test, so
// two cases are not attributed exactly: a test that skips itself after a call
// is reported as skipped, and with concurrent tests in one file the call fails
// whichever test finishes next.
const modelGuard = vi.hoisted(() => {
  const store = globalThis as typeof globalThis & {
    __modelCallGuardHits?: string[];
  };
  store.__modelCallGuardHits ??= [];
  return {
    hits: store.__modelCallGuardHits,
    message:
      "test guard: @anthropic-ai/claude-agent-sdk query() is blocked under vitest; " +
      "mock the package or src/inference/claude-sdk.ts in the test file",
  };
});

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>()),
  query: function blockedModelQuery() {
    const err = new Error(modelGuard.message);
    modelGuard.hits.push(err.stack ?? err.message);
    throw err;
  },
}));

afterEach(() => {
  const hits = modelGuard.hits.splice(0);
  if (hits.length > 0) {
    throw new Error(
      `${hits.length} model call(s) reached the test guard in this test; first call:\n${hits[0]}`,
    );
  }
});

afterAll(() => {
  const hits = modelGuard.hits.splice(0);
  if (hits.length > 0) {
    throw new Error(
      `${hits.length} model call(s) reached the test guard after the last test; first call:\n${hits[0]}`,
    );
  }
});
