/**
 * OpenSandbox backend: same wire contract as spawnContainer() (input JSON in,
 * sentinel JSON out, activity timeout, kill), hardening parity (env
 * neutralization + volume allow-list), TTL backstop, and teardown on every
 * exit path. The SDK is replaced by an in-memory fake via
 * _setSandboxCreatorForTests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: {
    heavyRunnerImage: "mission-control:latest",
    opensandboxUrl: "127.0.0.1:8098",
    opensandboxApiKey: "test-key",
    sandboxEgressAllow: [] as string[],
  },
}));
vi.mock("../config.js", () => ({ getConfig: () => mocks.config }));

import { ConnectionConfig } from "@alibaba-group/opensandbox";
import { OUTPUT_END_MARKER, OUTPUT_START_MARKER } from "./container.js";
import {
  INPUT_PATH,
  _setSandboxCreatorForTests,
  buildCreateOptions,
  neutralizeEnv,
  shellQuote,
  spawnOpenSandbox,
  toVolumes,
  type SandboxLike,
} from "./opensandbox-backend.js";

const sentinel = (obj: unknown) =>
  `${OUTPUT_START_MARKER}${JSON.stringify(obj)}${OUTPUT_END_MARKER}`;

interface FakeOpts {
  /** Script the command run: emit chunks then finish. */
  run?: (h: {
    stdout: (t: string) => void;
    stderr: (t: string) => void;
    signal?: AbortSignal;
  }) => Promise<{
    exitCode?: number | null;
    error?: { name: string; value?: string };
    complete?: unknown;
  }>;
  createError?: Error;
}

function makeFake(o: FakeOpts = {}) {
  const calls = {
    create: [] as unknown[],
    writes: [] as { path: string; data: string; mode?: number }[],
    runs: [] as { command: string; opts: unknown }[],
    kill: 0,
    close: 0,
    renews: [] as number[],
    signal: undefined as AbortSignal | undefined,
  };
  const sandbox: SandboxLike = {
    id: "sbx-1",
    files: {
      async writeFiles(entries) {
        calls.writes.push(...entries);
      },
    },
    commands: {
      async run(command, opts, handlers, signal) {
        calls.runs.push({ command, opts });
        calls.signal = signal;
        const stdout = (t: string) => handlers?.onStdout?.({ text: t });
        const stderr = (t: string) => handlers?.onStderr?.({ text: t });
        if (o.run) return o.run({ stdout, stderr, signal });
        stdout(sentinel({ result: "ok" }));
        return { exitCode: 0, complete: {} };
      },
    },
    async renew(seconds) {
      calls.renews.push(seconds);
    },
    async kill() {
      calls.kill++;
    },
    async close() {
      calls.close++;
    },
  };
  _setSandboxCreatorForTests(async (opts) => {
    calls.create.push(opts);
    if (o.createError) throw o.createError;
    return sandbox;
  });
  return calls;
}

afterEach(() => {
  _setSandboxCreatorForTests(null);
  vi.useRealTimers();
  mocks.config.sandboxEgressAllow = [];
});

describe("pure helpers", () => {
  it("shellQuote single-quotes every argv element", () => {
    expect(shellQuote(["node", "dist/w.js", "it's"])).toBe(
      `'node' 'dist/w.js' 'it'\\''s'`,
    );
  });

  it("neutralizeEnv substitutes the control-plane key and keeps the rest", () => {
    expect(
      neutralizeEnv({
        MC_API_KEY: "real",
        INFERENCE_PRIMARY_KEY: "k",
        HOME: "/root",
      }),
    ).toEqual({
      MC_API_KEY: "sandbox-no-control-plane-access",
      INFERENCE_PRIMARY_KEY: "k",
      HOME: "/root",
    });
  });

  // 2026-09-01: the gate is container.ts volumeRefusal — allow-listed host
  // path AND `:ro`. A mode-less or `:rw` spec is DROPPED (it used to be
  // admitted writable), so every accepted Volume is readOnly by construction.
  it("toVolumes enforces the shared allow-list and refuses non-:ro mounts", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const vols = toVolumes([
      "/root/claude/mission-control:/root/claude/mission-control:ro",
      "/root/.claude/.credentials.json:/root/.claude/.credentials.json:ro",
      "/tmp/jarvis-downloads:/tmp/jarvis-downloads",
      "/root/claude/mission-control:/workspace:rw",
      "/etc/passwd:/x:ro",
    ]);
    expect(vols).toEqual([
      {
        name: "v0",
        host: { path: "/root/claude/mission-control" },
        mountPath: "/root/claude/mission-control",
        readOnly: true,
      },
      {
        name: "v1",
        host: { path: "/root/.claude/.credentials.json" },
        mountPath: "/root/.claude/.credentials.json",
        readOnly: true,
      },
    ]);
    expect(vols.every((v) => v.readOnly)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("/etc/passwd"));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("not read-only"),
    );
    warn.mockRestore();
  });

  // qa R1 W2 (2026-09-01): the gate is only worth anything if its output is
  // what reaches the server — pin the `volumes: toVolumes(opts.volumes)` wiring.
  it("buildCreateOptions passes exactly toVolumes()' output (refused specs never reach the server)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cc = new ConnectionConfig({
      domain: "127.0.0.1:8098",
      protocol: "http",
    });
    // Two ACCEPTED specs so a truncating rewrite (`.slice(0, 1)`) also fails (R2 W-B).
    const specs = [
      "/root/claude/mission-control/dist:/app/dist:ro",
      "/root/claude/mission-control:/workspace:rw",
      "/root/claude/mission-control/prompt_modules:/app/prompt_modules:ro",
      "/etc/passwd:/x:ro",
    ];
    const opts = buildCreateOptions({
      image: "mission-control:latest",
      name: "mc-wire",
      volumes: specs,
      timeoutMs: 60_000,
      egressAllow: [],
      connectionConfig: cc,
    });
    expect(opts.volumes).toEqual(toVolumes(specs));
    expect(opts.volumes).toEqual([
      {
        name: "v0",
        host: { path: "/root/claude/mission-control/dist" },
        mountPath: "/app/dist",
        readOnly: true,
      },
      {
        name: "v1",
        host: { path: "/root/claude/mission-control/prompt_modules" },
        mountPath: "/app/prompt_modules",
        readOnly: true,
      },
    ]);
    warn.mockRestore();
  });

  it("buildCreateOptions: limits, TTL = timeout + grace, no policy unless an allow-list is set", () => {
    const cc = new ConnectionConfig({
      domain: "127.0.0.1:8098",
      protocol: "http",
    });
    const base = buildCreateOptions({
      image: "mission-control:latest",
      name: "mc-nanoclaw-x",
      envVars: { MC_API_KEY: "real" },
      volumes: [],
      timeoutMs: 900_000,
      egressAllow: [],
      connectionConfig: cc,
    });
    expect(base.image).toBe("mission-control:latest");
    expect(base.resource).toEqual({ cpu: "2", memory: "4Gi" });
    expect(base.timeoutSeconds).toBe(900 + 120);
    expect(base.env).toEqual({ MC_API_KEY: "sandbox-no-control-plane-access" });
    expect(base.metadata).toEqual({ mc_name: "mc-nanoclaw-x" });
    expect(base.networkPolicy).toBeUndefined();

    const gated = buildCreateOptions({
      image: "i",
      name: "n",
      timeoutMs: 1_000,
      egressAllow: ["api.anthropic.com", "*.github.com"],
      connectionConfig: cc,
    });
    expect(gated.timeoutSeconds).toBe(121);
    expect(gated.networkPolicy).toEqual({
      defaultAction: "deny",
      egress: [
        { action: "allow", target: "api.anthropic.com" },
        { action: "allow", target: "*.github.com" },
      ],
    });
  });
});

describe("spawnOpenSandbox", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("stages the input file, runs the worker with stdin redirect in the image WORKDIR, parses the sentinel result, and tears down", async () => {
    const calls = makeFake({
      run: async ({ stdout }) => {
        stdout("noise before\n");
        stdout(sentinel({ type: "progress" }));
        stdout(sentinel({ result: '{"success":true}' }).slice(0, 20));
        stdout(sentinel({ result: '{"success":true}' }).slice(20));
        return { exitCode: 0, complete: {} };
      },
    });
    const h = spawnOpenSandbox({
      input: { prompt: "p", taskId: "t1" },
      command: ["node", "dist/runners/nanoclaw-worker.js"],
      envVars: { MC_API_KEY: "real", HOME: "/root" },
      volumes: ["/root/claude/mission-control:/root/claude/mission-control:ro"],
      timeoutMs: 5_000,
      name: "mc-nanoclaw-t1",
    });
    expect(h.name).toBe("mc-nanoclaw-t1");
    const out = await h.result;
    expect(out).toEqual({ status: "success", result: '{"success":true}' });

    expect(calls.writes).toEqual([
      {
        path: INPUT_PATH,
        data: JSON.stringify({ prompt: "p", taskId: "t1" }),
        mode: 600,
      },
    ]);
    expect(calls.runs[0].command).toBe(
      `'node' 'dist/runners/nanoclaw-worker.js' < ${INPUT_PATH}`,
    );
    // No execd wall clock (qa C1): inactivity timer + renewed TTL are the bounds.
    expect(calls.runs[0].opts).toEqual({ workingDirectory: "/app" });
    const created = calls.create[0] as {
      env: Record<string, string>;
      volumes: unknown[];
    };
    expect(created.env.MC_API_KEY).toBe("sandbox-no-control-plane-access");
    expect(created.volumes).toHaveLength(1);
    // teardown exactly once, on the success path
    await vi.waitFor(() => expect(calls.kill).toBe(1));
    expect(calls.close).toBe(1);
  });

  it("activity timeout: a silent worker is killed and the result reports the timeout (heartbeats would have reset it)", async () => {
    vi.useFakeTimers();
    const calls = makeFake({
      run: ({ signal }) =>
        new Promise((_, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    const h = spawnOpenSandbox({
      input: { prompt: "p" },
      command: ["node", "w.js"],
      timeoutMs: 10_000,
    });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(calls.kill).toBe(0);
    await vi.advanceTimersByTimeAsync(1_500);
    const out = await h.result;
    expect(out).toEqual({
      status: "error",
      result: null,
      error: "Container timed out after 10000ms",
    });
    expect(calls.signal?.aborted).toBe(true);
    await vi.waitFor(() => expect(calls.kill).toBe(1));
  });

  it("kill() aborts the stream, reaps the sandbox once, and resolves the pending result", async () => {
    const calls = makeFake({
      run: ({ signal }) =>
        new Promise((_, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    const h = spawnOpenSandbox({
      input: { prompt: "p" },
      command: ["node", "w.js"],
      timeoutMs: 60_000,
    });
    await vi.waitFor(() => expect(calls.runs).toHaveLength(1));
    h.kill();
    h.kill(); // idempotent
    const out = await h.result;
    expect(out).toEqual({
      status: "error",
      result: null,
      error: "Sandbox killed",
    });
    await vi.waitFor(() => expect(calls.kill).toBe(1));
    expect(calls.close).toBe(1);
  });

  it("create failure resolves an error result without a kill call", async () => {
    const calls = makeFake({ createError: new Error("image not found") });
    const h = spawnOpenSandbox({
      input: { prompt: "p" },
      command: ["node", "w.js"],
      timeoutMs: 5_000,
    });
    expect(await h.result).toEqual({
      status: "error",
      result: null,
      error: "Sandbox create error: image not found",
    });
    expect(calls.kill).toBe(0);
  });

  it("non-zero exit without a sentinel surfaces the code + stderr tail; exit 0 without a sentinel returns raw stdout", async () => {
    makeFake({
      run: async ({ stderr }) => {
        stderr("boom\n");
        // real execd shape: exit code arrives as an error event the SDK parses
        return { exitCode: 2, error: { name: "CommandExecError", value: "2" } };
      },
    });
    expect(
      await spawnOpenSandbox({
        input: { prompt: "p" },
        command: ["x"],
        timeoutMs: 5_000,
      }).result,
    ).toEqual({
      status: "error",
      result: null,
      error: "Container exited with code 2: boom\n",
    });

    makeFake({
      run: async ({ stdout }) => {
        stdout("plain output\n");
        return { exitCode: 0, complete: {} };
      },
    });
    expect(
      await spawnOpenSandbox({
        input: { prompt: "p" },
        command: ["x"],
        timeoutMs: 5_000,
      }).result,
    ).toEqual({ status: "success", result: "plain output" });
  });

  it("an execd-level error is reported as an exec error", async () => {
    makeFake({
      run: async () => ({
        error: { name: "CommandTimeout", value: "server wall clock" },
      }),
    });
    expect(
      await spawnOpenSandbox({
        input: { prompt: "p" },
        command: ["x"],
        timeoutMs: 5_000,
      }).result,
    ).toEqual({
      status: "error",
      result: null,
      error: "Sandbox exec error: CommandTimeout: server wall clock",
    });
  });

  it("heartbeats renew the server TTL (throttled to once per minute) so a working worker is never wall-clock-killed", async () => {
    vi.useFakeTimers();
    let emit: ((t: string) => void) | undefined;
    const calls = makeFake({
      run: ({ stdout, signal }) =>
        new Promise((_, reject) => {
          emit = stdout;
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    const h = spawnOpenSandbox({
      input: { prompt: "p" },
      command: ["node", "w.js"],
      timeoutMs: 900_000,
    });
    await vi.advanceTimersByTimeAsync(10);
    for (let minute = 1; minute <= 20; minute++) {
      await vi.advanceTimersByTimeAsync(60_000);
      emit?.(sentinel({ type: "progress" }));
    }
    // 20 minutes of heartbeats > the 15-minute inactivity budget: still alive.
    expect(calls.kill).toBe(0);
    expect(calls.renews.length).toBeGreaterThanOrEqual(19);
    expect(calls.renews.every((s) => s === 900 + 120)).toBe(true);
    // A double heartbeat inside the same minute does not double-renew.
    const before = calls.renews.length;
    emit?.(sentinel({ type: "progress" }));
    expect(calls.renews.length).toBe(before);
    h.kill();
    await h.result;
  });

  it("a stream that ends without a terminal event fails closed (no false success)", async () => {
    makeFake({
      run: async ({ stdout }) => {
        stdout("partial\n");
        return { exitCode: null };
      },
    });
    expect(
      await spawnOpenSandbox({
        input: { prompt: "p" },
        command: ["x"],
        timeoutMs: 5_000,
      }).result,
    ).toEqual({
      status: "error",
      result: null,
      error: "Sandbox stream ended without a terminal event",
    });
  });

  it("egress allow-list from config becomes a default-deny networkPolicy on create", async () => {
    mocks.config.sandboxEgressAllow = ["api.anthropic.com"];
    const calls = makeFake();
    await spawnOpenSandbox({
      input: { prompt: "p" },
      command: ["x"],
      timeoutMs: 5_000,
    }).result;
    const created = calls.create[0] as { networkPolicy?: unknown };
    expect(created.networkPolicy).toEqual({
      defaultAction: "deny",
      egress: [{ action: "allow", target: "api.anthropic.com" }],
    });
  });
});
