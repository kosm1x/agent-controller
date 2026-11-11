/**
 * LOCK: the nanoclaw worker judges the TARGET_NOT_IN_SANDBOX sentinel on the
 * goals' RAW answers (sandboxStopEmitted over the exec results), never on the
 * extracted <deliverable> text, which can drop a sentinel written outside the
 * block. The worker self-invokes main() on import, so its wiring is pinned by
 * source.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "nanoclaw-worker.ts"),
  "utf8",
);

describe("nanoclaw-worker sandbox-sentinel wiring", () => {
  it("calls sandboxStopEmitted with the summary and the raw exec results", () => {
    expect(SRC).toMatch(
      /const targetMissing = sandboxStopEmitted\(\s*summary,\s*result\.executionResults,?\s*\)/,
    );
  });

  it("never runs the sentinel check on the extracted finalAnswer", () => {
    expect(SRC).not.toContain("emittedTargetNotInSandbox(finalAnswer");
    expect(SRC).not.toMatch(/sandboxStopEmitted\([^)]*finalAnswer/);
  });
});

describe("nanoclaw-worker clone directory", () => {
  // The protected-path rules cover the worker's clone only because WORKSPACE
  // is derived from immutable-core.ts MC_CONTAINER_ROOT (the worker
  // self-invokes main() on import, so this is pinned by source).
  it("derives WORKSPACE from MC_CONTAINER_ROOT", () => {
    expect(SRC).toMatch(
      /import \{ MC_CONTAINER_ROOT \} from "\.\.\/tools\/builtin\/immutable-core\.js";/,
    );
    expect(SRC).toMatch(/const WORKSPACE = MC_CONTAINER_ROOT\.replace\(\/\\\/\$\/, ""\);/);
    expect(SRC.match(/const WORKSPACE =/g)).toHaveLength(1);
  });
});

describe("nanoclaw-worker GitHub identity", () => {
  // GitHub children run under the agent's own account; nothing falls back to a
  // login stored on the host. The worker self-invokes main() on import, so the
  // clone's credential wiring is pinned by source.
  it("the clone resets every credential helper, then answers github.com from the agent's token; no gh login is wired", () => {
    expect(SRC).not.toMatch(/setup-git/);
    expect(SRC).toMatch(/config\("credential\.helper", ""\);\s*config\(AGENT_CREDENTIAL_HELPER_KEY, AGENT_CREDENTIAL_HELPER\);/);
  });

  it("commits carry the agent's identity", () => {
    expect(SRC).toMatch(/const \{ name, email \} = agentCommitIdentity\(\);/);
    expect(SRC).toMatch(/config\("user\.email", email\);\s*config\("user\.name", name\);/);
  });

  it("the environment note is told whether the agent's token is configured", () => {
    expect(SRC).toMatch(
      /const envNote = buildEnvironmentNote\(workspace, agentGithubConfigured\(\)\);/,
    );
  });
});
