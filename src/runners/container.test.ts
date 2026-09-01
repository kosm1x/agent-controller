/**
 * Container helpers unit tests.
 * Tests name generation and sentinel output parsing.
 */

import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateContainerName,
  parsePayload,
  buildDockerRunArgs,
  volumeRefusal,
  RUNTIME_CODE_MOUNTS,
  assertRuntimeCodeMounts,
  MC_ROOT,
  imageLockDrift,
  hostLockfileSha256,
  missingHostDistAssets,
  HOST_DIST_REQUIRED_ASSETS,
  OUTPUT_START_MARKER,
  OUTPUT_END_MARKER,
} from "./container.js";

describe("generateContainerName", () => {
  it("should generate mc- prefixed names", () => {
    const name = generateContainerName("test");
    expect(name).toMatch(/^mc-test-\d+$/);
  });

  it("should sanitize special characters", () => {
    const name = generateContainerName("My Task!@#$");
    expect(name).toMatch(/^mc-my-task--\d+$/);
  });

  it("should truncate long prefixes", () => {
    const name = generateContainerName("a".repeat(100));
    // mc- + 30 chars max + - + timestamp
    expect(name.startsWith("mc-")).toBe(true);
    const parts = name.split("-");
    expect(parts[1].length).toBeLessThanOrEqual(30);
  });

  it("should use default prefix", () => {
    const name = generateContainerName();
    expect(name).toMatch(/^mc-task-\d+$/);
  });
});

describe("sentinel markers", () => {
  it("should have distinct start and end markers", () => {
    expect(OUTPUT_START_MARKER).not.toBe(OUTPUT_END_MARKER);
    expect(OUTPUT_START_MARKER).toContain("START");
    expect(OUTPUT_END_MARKER).toContain("END");
  });
});

// -------------------------------------------------------------------------
// parsePayload — host-side discrimination of worker heartbeat vs final result.
// Extracted from spawnContainer() closure 2026-05-23 (qa-audit W1 fold) so
// the progress branch can be exercised without standing up a docker
// subprocess. The closure now delegates and applies the imperative state
// updates (resetTimer / lastOutput); behavior preserved.
// -------------------------------------------------------------------------

describe("parsePayload", () => {
  it("returns progress kind for type:'progress' payload, no output", () => {
    const result = parsePayload(
      JSON.stringify({ type: "progress", elapsedMs: 120000 }),
    );
    expect(result.kind).toBe("progress");
    expect(result.output).toBeUndefined();
  });

  it("treats type:'progress' as progress even when elapsedMs is absent (qa-r2 W3 fold)", () => {
    // The discriminator is `type === "progress"` alone — payload SHAPE
    // beyond that is advisory. A future heartbeat variant that omits
    // elapsedMs (or any other field) must still be recognized so it
    // resets the activity timer rather than being treated as a final
    // result. Without this assertion, a worker change that drops the
    // field could silently flip behavior at the closure level.
    const result = parsePayload(JSON.stringify({ type: "progress" }));
    expect(result.kind).toBe("progress");
    expect(result.output).toBeUndefined();
  });

  it("returns result kind with success output for type:'result' payload", () => {
    const result = parsePayload(
      JSON.stringify({
        type: "result",
        success: true,
        content: "done",
        durationMs: 5000,
      }),
    );
    expect(result.kind).toBe("result");
    expect(result.output?.status).toBe("success");
    expect(result.output?.error).toBeUndefined();
  });

  it("returns result kind with error output when payload has error field", () => {
    const result = parsePayload(
      JSON.stringify({ type: "result", error: "Orchestration crashed" }),
    );
    expect(result.kind).toBe("result");
    expect(result.output?.status).toBe("error");
    expect(result.output?.error).toBe("Orchestration crashed");
  });

  it("treats untyped payload as result (backward compat for older workers)", () => {
    // A future worker (or older one) that forgets the discriminator should
    // still resolve as a final result, not be silently discarded.
    const result = parsePayload(
      JSON.stringify({ success: true, content: "legacy" }),
    );
    expect(result.kind).toBe("result");
    expect(result.output?.status).toBe("success");
  });

  it("treats near-miss type values as result (not progress)", () => {
    // qa-audit W3 boundary case — substring matching on 'progress' must
    // NOT happen; only the literal `type === "progress"` opens the branch.
    expect(parsePayload(JSON.stringify({ type: "progressing" })).kind).toBe(
      "result",
    );
    expect(parsePayload(JSON.stringify({ type: "result" })).kind).toBe(
      "result",
    );
    expect(parsePayload(JSON.stringify({ type: "PROGRESS" })).kind).toBe(
      "result",
    );
  });

  it("falls back to raw-string success output for malformed JSON", () => {
    // The closure's pre-extraction behavior preserved: anything that
    // can't parse as JSON becomes a success result with the raw text.
    const result = parsePayload("not json at all");
    expect(result.kind).toBe("result");
    expect(result.output?.status).toBe("success");
    expect(result.output?.result).toBe("not json at all");
  });
});

// -------------------------------------------------------------------------
// buildDockerRunArgs — H5 safe-set hardening + control-plane env neutralization.
// -------------------------------------------------------------------------

describe("buildDockerRunArgs — H5 hardening", () => {
  const base = { image: "mission-control:latest", name: "mc-test-123" };

  it("adds the safe-set resource + capability limits", () => {
    const args = buildDockerRunArgs(base);
    expect(args).toContain("--cap-drop=ALL");
    expect(args).toContain("--security-opt=no-new-privileges");
    // --memory 4g, --cpus 2, --pids-limit 512 (flag + value pairs)
    expect(args).toContain("--memory");
    expect(args[args.indexOf("--memory") + 1]).toBe("4g");
    expect(args).toContain("--cpus");
    expect(args[args.indexOf("--cpus") + 1]).toBe("2");
    expect(args).toContain("--pids-limit");
    expect(args[args.indexOf("--pids-limit") + 1]).toBe("512");
  });

  it("does NOT add --network none or --read-only (would break nanoclaw)", () => {
    const joined = buildDockerRunArgs(base).join(" ");
    expect(joined).not.toContain("--read-only");
    expect(joined).not.toContain("--network");
  });

  it("neutralizes MC_API_KEY but passes INFERENCE_PRIMARY_KEY through", () => {
    const args = buildDockerRunArgs({
      ...base,
      envVars: {
        MC_API_KEY: "REAL-control-plane-secret",
        INFERENCE_PRIMARY_KEY: "sk-inference-value",
        MC_DB_PATH: "/tmp/mc.db",
      },
    });
    const joined = args.join(" ");
    // Real control-plane key never reaches the container.
    expect(joined).not.toContain("REAL-control-plane-secret");
    expect(joined).toContain("MC_API_KEY=sandbox-no-control-plane-access");
    // The inference key the SDK needs inside is preserved verbatim.
    expect(joined).toContain("INFERENCE_PRIMARY_KEY=sk-inference-value");
    expect(joined).toContain("MC_DB_PATH=/tmp/mc.db");
  });

  it("still enforces the volume host-path allowlist (and, since 2026-09-01, read-only)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const args = buildDockerRunArgs({
      ...base,
      volumes: [
        "/tmp/ok:/work:ro", // allowed
        "/tmp/ok:/work:rw", // blocked — writable mounts are refused
        "/etc/passwd:/x:ro", // blocked — outside allowlist
      ],
    });
    const joined = args.join(" ");
    expect(joined).toContain("/tmp/ok:/work:ro");
    expect(joined).not.toContain("/tmp/ok:/work:rw");
    expect(joined).not.toContain("/etc/passwd");
    warn.mockRestore();
  });

  it("appends image last, before any command", () => {
    const args = buildDockerRunArgs({
      ...base,
      command: ["node", "dist/runners/heavy-worker.js"],
    });
    const imageIdx = args.indexOf("mission-control:latest");
    expect(imageIdx).toBeGreaterThan(-1);
    expect(args[imageIdx + 1]).toBe("node");
    expect(args[imageIdx + 2]).toBe("dist/runners/heavy-worker.js");
  });
});

// ---------------------------------------------------------------------------
// nanoclaw upstream review 2026-09-01 — --init, read-only mount gate,
// host-code mounts, image ↔ lockfile coupling
// ---------------------------------------------------------------------------

describe("buildDockerRunArgs — --init (nanoclaw upstream v2.1.54 #2748)", () => {
  it("runs the container under Docker's init so SIGTERM reaches node as PID 1", () => {
    const args = buildDockerRunArgs({
      image: "mission-control:latest",
      name: "mc-init-test",
    });
    expect(args).toContain("--init");
    // Still `docker run … <image>` — the flag sits before the image.
    expect(args.indexOf("--init")).toBeLessThan(
      args.indexOf("mission-control:latest"),
    );
  });
});

describe("volumeRefusal — allow-listed host path AND read-only, one gate for both doors", () => {
  it.each([
    "/root/claude/mission-control:/root/claude/mission-control:ro",
    "/root/claude/mission-control/dist:/app/dist:ro",
    "/tmp/jarvis-downloads:/tmp/jarvis-downloads:ro",
    "/root/.config/gh:/root/.config/gh:ro",
    "/root/.config/gh/hosts.yml:/x/hosts.yml:ro",
    "/root/.claude/.credentials.json:/root/.claude/.credentials.json:ro",
    "/root/claude//mission-control:/x:ro", // `//` normalizes to an allowed sub-path
    "/root/claude/./mission-control/dist:/app/dist:ro",
  ])("accepts %s", (spec) => {
    expect(volumeRefusal(spec)).toBeNull();
  });

  it.each([
    ["/root/claude/mission-control:/w:rw", "not read-only"],
    ["/root/claude/mission-control:/w", "not read-only"],
    ["/tmp/jarvis-downloads:/tmp/jarvis-downloads:RO", "not read-only"],
    ["/root/claude/mission-control:/w:ro,z", "not read-only"],
    ["/etc/passwd:/x:ro", "outside allowed paths"],
    ["/root/claude:/x:ro", "outside allowed paths"], // prefix is `/root/claude/`
    ["/root/.config/gh-evil:/x:ro", "outside allowed paths"], // boundary
    ["/root/.claude/.credentials.json.bak:/x:ro", "outside allowed paths"],
    ["/root:/x:ro", "outside allowed paths"],
    ["/root/claude/../.ssh:/x:ro", "outside allowed paths"], // `..` judged normalized (R1 W1)
    ["/root/claude/mission-control/../../.ssh:/x:ro", "outside allowed paths"],
    ["/tmp/../root/.ssh:/x:ro", "outside allowed paths"],
    ["/tmp/:/tmp:ro", "outside allowed paths"], // a directory prefix admits only a sub-path
    ["/root/claude/:/x:ro", "outside allowed paths"],
    ["dist:/app/dist:ro", "must be absolute"], // relative = docker NAMED volume
    ["./dist:/app/dist:ro", "must be absolute"],
    ["nonsense", "malformed"],
    ["", "malformed"],
    [":/x:ro", "malformed"],
  ])("refuses %s (%s)", (spec, reason) => {
    expect(volumeRefusal(spec)).toContain(reason);
  });

  it("buildDockerRunArgs drops every refused mount, keeps the :ro ones, warns per refusal", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const args = buildDockerRunArgs({
      image: "mission-control:latest",
      name: "mc-vol-test",
      volumes: [
        "/root/claude/mission-control/dist:/app/dist:ro",
        "/root/claude/mission-control:/w:rw",
        "/etc/passwd:/x:ro",
      ],
    });
    expect(args.filter((a) => a === "-v")).toHaveLength(1);
    expect(args).toContain("/root/claude/mission-control/dist:/app/dist:ro");
    const joined = args.join(" ");
    expect(joined).not.toContain(":rw");
    expect(joined).not.toContain("/etc/passwd");
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("not read-only"),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("outside allowed paths"),
    );
    warn.mockRestore();
  });
});

describe("RUNTIME_CODE_MOUNTS — the sandbox executes the host's deployed code", () => {
  it("mounts dist/ and prompt_modules/ over /app read-only", () => {
    expect(RUNTIME_CODE_MOUNTS).toEqual([
      `${MC_ROOT}/dist:/app/dist:ro`,
      `${MC_ROOT}/prompt_modules:/app/prompt_modules:ro`,
    ]);
    expect(MC_ROOT).toBe("/root/claude/mission-control");
  });

  it("every entry passes the gate both backends enforce", () => {
    for (const m of RUNTIME_CODE_MOUNTS) expect(volumeRefusal(m)).toBeNull();
  });

  it("assertRuntimeCodeMounts fails loud on a refused entry (qa R3 W1) and passes on the live list", () => {
    expect(() => assertRuntimeCodeMounts()).not.toThrow();
    expect(() => assertRuntimeCodeMounts([`${MC_ROOT}/dist:/app/dist:rw`])).toThrow(
      /RUNTIME_CODE_MOUNTS entry refused .*not read-only/,
    );
    expect(() => assertRuntimeCodeMounts(["/etc/dist:/app/dist:ro"])).toThrow(
      /outside allowed paths/,
    );
  });
});

describe("imageLockDrift — image node_modules must come from the host lockfile", () => {
  const host = "a".repeat(64);

  it("null when the image label equals the host lockfile sha", () => {
    expect(imageLockDrift("img", { host, readLabel: () => host })).toBeNull();
  });

  it("reports drift when the label differs", () => {
    const other = "b".repeat(64);
    expect(imageLockDrift("img", { host, readLabel: () => other })).toEqual({
      host,
      image: other,
    });
  });

  it("reports drift (image: null) when the image carries no label — pre-2026-09-01 build or bare `docker build`", () => {
    expect(imageLockDrift("img", { host, readLabel: () => null })).toEqual({
      host,
      image: null,
    });
  });

  it("asks the label reader about the image it was given", () => {
    const readLabel = vi.fn((_image: string) => host);
    imageLockDrift("mission-control:latest", { host, readLabel });
    expect(readLabel).toHaveBeenCalledWith("mission-control:latest");
  });

  it("hostLockfileSha256 is sha256 hex of the file bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-lock-"));
    const p = join(dir, "package-lock.json");
    writeFileSync(p, '{"lockfileVersion":3}');
    try {
      expect(hostLockfileSha256(p)).toBe(
        createHash("sha256").update('{"lockfileVersion":3}').digest("hex"),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("missingHostDistAssets — the mounted host dist/ must be a full `npm run build`, not bare tsc (qa R2 W-C)", () => {
  it("names schema.sql and seed-cases.json as the build-copied assets", () => {
    expect(HOST_DIST_REQUIRED_ASSETS).toEqual([
      "dist/db/schema.sql",
      "dist/tuning/seed-cases.json",
    ]);
  });

  it("empty when every asset exists under the root", () => {
    const seen: string[] = [];
    expect(
      missingHostDistAssets("/srv/mc", (p) => {
        seen.push(p);
        return true;
      }),
    ).toEqual([]);
    expect(seen).toEqual([
      "/srv/mc/dist/db/schema.sql",
      "/srv/mc/dist/tuning/seed-cases.json",
    ]);
  });

  it("lists exactly the missing ones (a tsc-only build leaves schema.sql out)", () => {
    expect(
      missingHostDistAssets("/srv/mc", (p) => !p.endsWith("schema.sql")),
    ).toEqual(["dist/db/schema.sql"]);
    expect(missingHostDistAssets("/srv/mc", () => false)).toEqual([
      "dist/db/schema.sql",
      "dist/tuning/seed-cases.json",
    ]);
  });

  it("the live host dist/ is complete right now (deploy.sh ran `npm run build`)", () => {
    expect(missingHostDistAssets()).toEqual([]);
  });
});
