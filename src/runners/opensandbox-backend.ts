/**
 * OpenSandbox backend for the sandbox seam (2026-08-16).
 *
 * Same contract as `spawnContainer()` in container.ts — the worker still
 * reads one JSON blob on stdin and writes sentinel-delimited JSON on stdout —
 * but the container is owned by the OpenSandbox lifecycle server instead of a
 * host `docker run`:
 *
 *   Sandbox.create (image, env, volumes, limits, TTL, optional egress policy)
 *     → files.writeFiles(input JSON)
 *     → commands.run(`<worker> < input.json`) streamed over execd SSE
 *     → sentinel parse (progress heartbeats reset the activity timer)
 *     → sandbox.kill() — always, in finally; the server TTL is the backstop
 *       for the "zombie container outlives a killed task" class.
 *
 * Why the same wire contract: nanoclaw-worker.ts / heavy-worker.ts are
 * untouched, so `SANDBOX_BACKEND=docker` stays byte-identical and the flip is
 * one env var. Hardening parity is split: env neutralization + volume
 * allow-list are enforced HERE (shared constants with container.ts); cap-drop
 * ALL / no-new-privileges / pids 512 live in the server TOML
 * (container/opensandbox/sandbox.toml) and are re-checked by the e2e probe.
 *
 * Reference: docs/planning/opensandbox-adoption.md
 */

import {
  ConnectionConfig,
  Sandbox,
  type SandboxCreateOptions,
  type Volume,
} from "@alibaba-group/opensandbox";
import { getConfig } from "../config.js";
import {
  OUTPUT_START_MARKER,
  OUTPUT_END_MARKER,
  SANDBOX_NEUTRALIZED_ENV,
  volumeRefusal,
  generateContainerName,
  parsePayload,
  type ContainerOutput,
  type SpawnContainerOptions,
} from "./container.js";
import type { SandboxHandle } from "./sandbox-backend.js";

// ---------------------------------------------------------------------------
// Constants (mirror the docker path — container.ts buildDockerRunArgs)
// ---------------------------------------------------------------------------

/** Parity with `--memory 4g --cpus 2` in container.ts. */
const RESOURCE_LIMITS = { cpu: "2", memory: "4Gi" } as const;
/** Where the worker's stdin JSON is staged inside the sandbox. */
export const INPUT_PATH = "/tmp/mc-sandbox-input.json";
/** Image WORKDIR — worker commands are relative (`node dist/runners/...`). */
const WORKDIR = "/app";
const DEFAULT_TIMEOUT_MS = 300_000; // same as container.ts
/**
 * Server-side TTL = activity timeout + grace, RENEWED on every sentinel
 * (heartbeat or result) so it tracks the docker path's inactivity semantics
 * — a worker that keeps heartbeating is never wall-clock-killed (qa C1) — and
 * still reaps the sandbox if mission-control dies mid-task (zombie class,
 * queue 2026-07-14): no host ⇒ no renew ⇒ reaped at last-activity + TTL.
 */
export const TTL_GRACE_S = 120; // MUST exceed 2× the workers' heartbeat interval (60 s in nanoclaw-worker.ts / heavy-worker.ts) so a renew gap never lets the TTL lapse
/** Don't hit /renew-expiration more than once per this many ms. */
const RENEW_MIN_INTERVAL_MS = 60_000;
/** Ready wait: image is local; execd staging is a few seconds. */
const READY_TIMEOUT_S = 90;
/** Bound the raw stdout we retain between sentinel pairs (results are
 *  extracted as they arrive; this only guards a marker-less firehose). */
const MAX_RAW_STDOUT = 4 * 1024 * 1024;
const MAX_STDERR = 16 * 1024;

// ---------------------------------------------------------------------------
// Client seam (injectable for tests)
// ---------------------------------------------------------------------------

/** The subset of the SDK `Sandbox` this backend touches. */
export interface SandboxLike {
  id: string;
  files: {
    writeFiles: (
      entries: { path: string; data: string; mode?: number }[],
    ) => Promise<void>;
  };
  commands: {
    run: (
      command: string,
      opts?: { workingDirectory?: string; timeoutSeconds?: number },
      handlers?: {
        onStdout?: (m: { text: string }) => void;
        onStderr?: (m: { text: string }) => void;
        skipAccumulation?: boolean;
      },
      signal?: AbortSignal,
    ) => Promise<{
      exitCode?: number | null;
      error?: { name?: string; value?: string };
      complete?: unknown;
    }>;
  };
  renew: (timeoutSeconds: number) => Promise<unknown>;
  kill: () => Promise<void>;
  close: () => Promise<void>;
}

export type SandboxCreator = (
  opts: SandboxCreateOptions,
) => Promise<SandboxLike>;

// No cast: `Sandbox` must structurally satisfy `SandboxLike` (property-style
// function types ⇒ parameter drift is checked too, not just return shapes), so
// an SDK bump that changes a signature we rely on fails `tsc`, not the first task.
const sdkCreate: SandboxCreator = (opts) => Sandbox.create(opts);
let createSandbox: SandboxCreator = sdkCreate;

/** Test hook: replace the SDK factory. Pass `null` to restore. */
export function _setSandboxCreatorForTests(fn: SandboxCreator | null): void {
  createSandbox = fn ?? sdkCreate;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** POSIX single-quote each argv element so execd's shell sees it verbatim. */
export function shellQuote(argv: string[]): string {
  return argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
}

/**
 * `"/host:/ctr:ro"` strings → SDK Volume objects. Same gate as the docker
 * path (container.ts volumeRefusal: allow-listed host path AND read-only),
 * same warn-and-skip; the server's [storage].allowed_host_paths is the
 * second gate. Every accepted mount is read-only by construction.
 */
export function toVolumes(specs: string[] | undefined): Volume[] {
  const out: Volume[] = [];
  for (const spec of specs ?? []) {
    const refused = volumeRefusal(spec);
    if (refused) {
      console.warn(`[opensandbox] Blocked volume mount (${refused}): ${spec}`);
      continue;
    }
    const [hostPath, mountPath] = spec.split(":");
    out.push({
      name: `v${out.length}`,
      host: { path: hostPath },
      mountPath,
      readOnly: true,
    });
  }
  return out;
}

/** Apply the control-plane credential neutralization (same map as docker). */
export function neutralizeEnv(
  envVars: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(envVars ?? {})) {
    out[k] = SANDBOX_NEUTRALIZED_ENV.get(k) ?? v;
  }
  return out;
}

/** Build the SDK create options for one worker run. */
export function buildCreateOptions(opts: {
  image: string;
  name: string;
  envVars?: Record<string, string>;
  volumes?: string[];
  timeoutMs: number;
  egressAllow: string[];
  connectionConfig: ConnectionConfig;
}): SandboxCreateOptions {
  const ttl = Math.ceil(opts.timeoutMs / 1000) + TTL_GRACE_S; // ≥ 120 by construction (server minimum is 60)
  return {
    connectionConfig: opts.connectionConfig,
    image: opts.image,
    env: neutralizeEnv(opts.envVars),
    volumes: toVolumes(opts.volumes),
    resource: { ...RESOURCE_LIMITS },
    timeoutSeconds: ttl,
    metadata: { mc_name: opts.name },
    readyTimeoutSeconds: READY_TIMEOUT_S,
    ...(opts.egressAllow.length > 0 && {
      networkPolicy: {
        defaultAction: "deny" as const,
        egress: opts.egressAllow.map((target) => ({
          action: "allow" as const,
          target,
        })),
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

/**
 * Run a worker inside an OpenSandbox-managed container. Returns immediately
 * with a handle whose `result` resolves exactly once (never rejects) — same
 * semantics as `spawnContainer()`.
 */
export function spawnOpenSandbox(opts: SpawnContainerOptions): SandboxHandle {
  const config = getConfig();
  const image = opts.image ?? config.heavyRunnerImage;
  const name = opts.name ?? generateContainerName();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const command = opts.command ?? [];

  const connectionConfig = new ConnectionConfig({
    domain: config.opensandboxUrl,
    protocol: "http",
    apiKey: config.opensandboxApiKey,
    requestTimeoutSeconds: 60,
  });

  const abort = new AbortController();
  let sandbox: SandboxLike | null = null;
  let killed = false;
  let timedOut = false;
  let settled = false;
  let resolveResult!: (out: ContainerOutput) => void;
  const result = new Promise<ContainerOutput>((resolve) => {
    resolveResult = (out) => {
      if (settled) return;
      settled = true;
      resolve(out);
    };
  });

  const teardown = async (): Promise<void> => {
    if (killed) return;
    killed = true;
    abort.abort();
    if (!sandbox) return;
    try {
      await sandbox.kill();
    } catch (err) {
      console.warn(
        `[opensandbox] kill failed for ${name} (${sandbox.id}); server TTL will reap it: ${errMsg(err)}`,
      );
    }
    try {
      await sandbox.close();
    } catch {
      // transport already gone
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastOutput: ContainerOutput | null = null;
  const ttlSeconds = Math.ceil(timeoutMs / 1000) + TTL_GRACE_S;
  let lastRenewAt = Date.now();
  let renewWarned = false;
  const renewTtl = (): void => {
    if (!sandbox || killed) return;
    const now = Date.now();
    if (now - lastRenewAt < RENEW_MIN_INTERVAL_MS) return;
    lastRenewAt = now;
    sandbox.renew(ttlSeconds).catch((err: unknown) => {
      if (renewWarned) return;
      renewWarned = true;
      console.warn(
        `[opensandbox] renew failed for ${name}; TTL will expire at last-renew+${ttlSeconds}s: ${errMsg(err)}`,
      );
    });
  };
  const resetTimer = (): void => {
    renewTtl();
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      void teardown();
      resolveResult(
        lastOutput ?? {
          status: "error",
          result: null,
          error: `Container timed out after ${timeoutMs}ms`,
        },
      );
    }, timeoutMs);
  };

  void (async () => {
    let stdout = "";
    let stderr = "";

    // Same marker-scan as container.ts parseSentinelOutput(); delegates the
    // progress/result discrimination to the shared, unit-tested parsePayload.
    const drain = (): void => {
      let startIdx: number;
      while ((startIdx = stdout.indexOf(OUTPUT_START_MARKER)) !== -1) {
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER, startIdx);
        if (endIdx === -1) break;
        const jsonStr = stdout
          .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
          .trim();
        stdout = stdout.slice(endIdx + OUTPUT_END_MARKER.length);
        const parsed = parsePayload(jsonStr);
        if (parsed.kind === "result" && parsed.output)
          lastOutput = parsed.output;
        resetTimer();
      }
      if (stdout.length > MAX_RAW_STDOUT) {
        // Keep an unterminated sentinel intact (cut before its START marker,
        // not through it) — but the cap is a HARD memory bound: a pending
        // payload that itself exceeds MAX_RAW_STDOUT is truncated to the tail
        // like any other firehose (qa R2 W-2).
        const keepFrom = stdout.lastIndexOf(OUTPUT_START_MARKER);
        stdout =
          keepFrom === -1 || stdout.length - keepFrom > MAX_RAW_STDOUT
            ? stdout.slice(-MAX_RAW_STDOUT)
            : stdout.slice(keepFrom);
      }
    };

    try {
      resetTimer();
      sandbox = await createSandbox(
        buildCreateOptions({
          image,
          name,
          envVars: opts.envVars,
          volumes: opts.volumes,
          timeoutMs,
          egressAllow: config.sandboxEgressAllow,
          connectionConfig,
        }),
      );
      if (killed) {
        // Killed while creating — the sandbox exists now; reap it.
        killed = false;
        await teardown();
        return;
      }
      console.log(`[opensandbox] ${name} → sandbox ${sandbox.id} (${image})`);

      // execd parses `mode` as octal DIGITS carried in a decimal int (644 →
      // 0o644, per the SDK README) — 0o600 (=384) would 500 the upload.
      await sandbox.files.writeFiles([
        { path: INPUT_PATH, data: JSON.stringify(opts.input), mode: 600 },
      ]);

      const cmd = `${shellQuote(command)} < ${INPUT_PATH}`;
      const exec = await sandbox.commands.run(
        cmd,
        {
          workingDirectory: WORKDIR,
          // No `timeoutSeconds`: execd's is an ABSOLUTE wall clock and would
          // kill a heartbeating worker (qa C1). Bounds are the activity timer
          // above (inactivity) and the renewed TTL (host death).
        },
        {
          skipAccumulation: true,
          onStdout: (m) => {
            stdout += m.text;
            drain();
          },
          onStderr: (m) => {
            if (stderr.length < MAX_STDERR) stderr += m.text;
          },
        },
        abort.signal,
      );

      if (timedOut || killed) return; // already resolved by the timer/kill path
      drain();
      if (timer) clearTimeout(timer); // after drain: it may re-arm the timer

      if (lastOutput) {
        resolveResult(lastOutput);
      } else if (typeof exec.exitCode === "number" && exec.exitCode !== 0) {
        // execd reports a non-zero exit as error {name:"CommandExecError",
        // value:"<code>"}; the SDK parses that into exitCode — same wording as
        // the docker path so downstream matching is unchanged.
        resolveResult({
          status: "error",
          result: null,
          error: `Container exited with code ${exec.exitCode}${stderr ? `: ${stderr.slice(0, 500)}` : ""}`,
        });
      } else if (exec.error) {
        resolveResult({
          status: "error",
          result: null,
          error: `Sandbox exec error: ${exec.error.name ?? "error"}${exec.error.value ? `: ${exec.error.value.slice(0, 500)}` : ""}`,
        });
      } else if (exec.exitCode == null && !exec.complete) {
        // SSE ended with neither `complete` nor `error` (server restart,
        // stream cut) — fail closed like the docker path does on a null exit
        // code (qa W1).
        resolveResult({
          status: "error",
          result: null,
          error: `Sandbox stream ended without a terminal event${stderr ? `: ${stderr.slice(0, 500)}` : ""}`,
        });
      } else {
        resolveResult({ status: "success", result: stdout.trim() || null });
      }
    } catch (err) {
      if (timer) clearTimeout(timer);
      if (timedOut || killed) return;
      resolveResult({
        status: "error",
        result: null,
        error: `Sandbox ${sandbox ? "exec" : "create"} error: ${errMsg(err)}`,
      });
    } finally {
      await teardown();
    }
  })();

  return {
    name,
    result,
    kill: () => {
      void teardown().then(() => {
        resolveResult(
          lastOutput ?? {
            status: "error",
            result: null,
            error: "Sandbox killed",
          },
        );
      });
    },
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
