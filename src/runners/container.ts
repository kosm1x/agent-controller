/**
 * Docker container helpers for NanoClaw runner.
 *
 * Handles container spawning via `docker run`, stdin/stdout communication
 * with sentinel-delimited output parsing, and activity-aware timeouts.
 */

import { spawn, execSync, execFileSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { posix } from "path";
import type { ChildProcess } from "child_process";
import { getConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const OUTPUT_START_MARKER = "---NANOCLAW_OUTPUT_START---";
export const OUTPUT_END_MARKER = "---NANOCLAW_OUTPUT_END---";
const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
const GRACEFUL_STOP_TIMEOUT_MS = 10_000; // 10 seconds

/**
 * Control-plane credentials that must never reach a sandboxed agent (H5). The
 * container can reach the host API via host-gateway:8080, so a real MC_API_KEY
 * would let a compromised agent drive the control plane. We SUBSTITUTE a
 * neutral placeholder rather than DROP the var: the worker's loadConfig() calls
 * required("MC_API_KEY") and throws on an empty value, but nothing inside ever
 * reads the real value — only its presence matters. Keep INFERENCE_PRIMARY_KEY
 * intact (the SDK/inference path needs it inside the container).
 */
export const SANDBOX_NEUTRALIZED_ENV = new Map<string, string>([
  ["MC_API_KEY", "sandbox-no-control-plane-access"],
]);

/**
 * Host paths a container volume mount is allowed to source from. Shared with
 * the OpenSandbox backend (opensandbox-backend.ts) so both runtimes enforce
 * the same client-side allow-list. The lifecycle server keeps its OWN,
 * deliberately NARROWER list in [storage].allowed_host_paths
 * (container/opensandbox/sandbox.toml: `/tmp/jarvis-downloads`, not `/tmp/`) —
 * a mount that passes here can still be rejected there with
 * HOST_PATH_NOT_ALLOWED; widen the TOML when adding a new host mount.
 */
export const VOLUME_ALLOWED_PREFIXES = [
  "/root/claude/",
  "/tmp/",
  "/root/.config/gh", // gh CLI auth (read-only for jarvis_dev PRs)
  "/root/.claude/.credentials.json", // Claude Agent SDK auth (read-only, Sonnet runner path)
];

/** Host checkout the sandbox executes from (also its `:ro` reference mount). */
export const MC_ROOT = "/root/claude/mission-control";

/**
 * The deployed code the sandbox EXECUTES, mounted read-only over the image's
 * baked copies (Dockerfile `COPY dist/`, `COPY prompt_modules/`).
 *
 * Why (nanoclaw upstream review 2026-09-01): the worker ran `/app/dist` from
 * INSIDE the image, so every host deploy left the sandbox on whatever dist/
 * the image was built from — the live image was 7 weeks old and lacked the
 * shell/file/immutable-core guard fixes of 27 commits touching sandbox-
 * executed paths (111 commits total since that build). Upstream's rule since
 * nanoclaw v2.0.0: "all groups mount the same agent-runner read-only … Source
 * is never baked in … Source-only changes never require an image rebuild."
 * The image now contributes node + system deps + node_modules only; dist/
 * tracks the host deploy at the next spawn. The baked copies remain the
 * fallback for a bare `docker run mission-control:latest`.
 *
 * Coupling: host dist/ imports the IMAGE's node_modules, so the image must
 * have been built from the same package-lock.json — see `imageLockDrift`.
 *
 * prompt_modules/: live for the heavy path (cwd `/app`, `resolve("prompt_modules")`
 * in strategic-voice.ts). The nanoclaw worker `chdir()`s into its `/workspace`
 * clone, whose prompt_modules/ is already HEAD — the mount is a no-op there
 * (qa R1 W3), kept so both runners carry one list.
 */
export const RUNTIME_CODE_MOUNTS: readonly string[] = [
  `${MC_ROOT}/dist:/app/dist:ro`,
  `${MC_ROOT}/prompt_modules:/app/prompt_modules:ro`,
];

/**
 * Why a `host:container[:mode]` volume spec is refused, or null when allowed.
 * Shared by the docker path (buildDockerRunArgs) and the OpenSandbox path
 * (toVolumes) so both doors enforce the same two rules:
 *   1. the host path is under VOLUME_ALLOWED_PREFIXES;
 *   2. the mode is `ro` — every mount the runners make is read-only, and a
 *      writable host mount reachable from inside the sandbox would bypass
 *      every host-side write guard (nanoclaw upstream v2.1.54 "mount
 *      allowlists honor readOnly"). A future rw mount is a deliberate change
 *      here, never a caller-side string.
 */
export function volumeRefusal(spec: string): string | null {
  const [hostPath, mountPath, mode] = spec.split(":");
  if (!hostPath || !mountPath) return "malformed volume spec";
  // A relative host path is a docker NAMED volume, not a bind mount — refuse
  // rather than resolve it against cwd (which would admit `dist:/app/dist`).
  if (!hostPath.startsWith("/")) return "host path must be absolute";
  // Judge the NORMALIZED path (`..`, `//` collapsed — the same form the docker
  // daemon mounts), so `/root/claude/../.ssh` is judged as `/root/.ssh` (qa R1
  // W1). Symlinks are deliberately not resolved: specs are runner literals,
  // never model input. Boundary-safe: a directory prefix (`…/`) admits only a
  // real sub-path (never the whole directory), a file/dir entry without `/`
  // admits itself or a sub-path — `/root/.config/gh` must not admit
  // `/root/.config/gh-evil`, `…credentials.json` must not admit `…json.bak`.
  const norm = posix.normalize(hostPath);
  const allowed = VOLUME_ALLOWED_PREFIXES.some((p) =>
    p.endsWith("/")
      ? norm.startsWith(p) && norm.length > p.length
      : norm === p || norm.startsWith(`${p}/`),
  );
  if (!allowed) return "outside allowed paths";
  if (mode !== "ro") return "not read-only (only :ro mounts are allowed)";
  return null;
}

/**
 * Boot-time invariant (qa R3 W1, 2026-09-01): every RUNTIME_CODE_MOUNTS entry
 * must pass the same gate the runners apply per spec. buildDockerRunArgs /
 * toVolumes warn-and-SKIP a refused mount, so a refused runtime-code mount
 * would silently leave the sandbox on the image's baked dist/ — the exact
 * failure this mount list exists to close. Throwing at module load turns that
 * silent degrade into a boot failure (main().catch → exit 1).
 */
export function assertRuntimeCodeMounts(
  mounts: readonly string[] = RUNTIME_CODE_MOUNTS,
): void {
  for (const m of mounts) {
    const refused = volumeRefusal(m);
    if (refused) {
      throw new Error(
        `[container] RUNTIME_CODE_MOUNTS entry refused by volumeRefusal (${refused}): ${m}`,
      );
    }
  }
}
assertRuntimeCodeMounts();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  [key: string]: unknown;
}

export interface ContainerOutput {
  status: "success" | "error";
  result: string | null;
  error?: string;
}

export interface ContainerHandle {
  name: string;
  process: ChildProcess;
  result: Promise<ContainerOutput>;
  kill: () => void;
}

export interface SpawnContainerOptions {
  image?: string;
  name?: string;
  input: ContainerInput;
  envVars?: Record<string, string>;
  timeoutMs?: number;
  /** Override the container's default CMD (e.g. ["node", "dist/runners/heavy-worker.js"]). */
  command?: string[];
  /** Volume mounts — host path under VOLUME_ALLOWED_PREFIXES and mode MUST be `:ro` (volumeRefusal), e.g. ["/host/path:/container/path:ro"]. */
  volumes?: string[];
}

// ---------------------------------------------------------------------------
// Container name generation
// ---------------------------------------------------------------------------

/**
 * Generate a unique container name with sanitized prefix.
 */
export function generateContainerName(prefix = "task"): string {
  const sanitized = prefix
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 30);
  return `mc-${sanitized}-${Date.now()}`;
}

// ---------------------------------------------------------------------------
// Image pre-flight
// ---------------------------------------------------------------------------

/**
 * Check whether a Docker image exists on the local daemon.
 *
 * Pre-flight guard for runners that spawn from a named image. Without this,
 * a missing image surfaces only as `Container exited with code 125: Unable
 * to find image '...' locally\ndocker: Error response from daemon: pull
 * access denied for ...` after docker attempts a registry pull — opaque to
 * operators and easy to mistake for a container runtime failure. Returns
 * `false` on any inspect error (image absent, daemon down, permission
 * denied) so callers can fail loud with a rebuild instruction.
 *
 * Uses execFileSync (NOT execSync) to avoid shell interpretation of the
 * image name. Local-only, ~50ms typical.
 */
export function imageExistsLocally(image: string): boolean {
  try {
    execFileSync("docker", ["image", "inspect", image], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Image ↔ lockfile coupling
// ---------------------------------------------------------------------------

/** Label `scripts/build-mc-image.sh` stamps with sha256(package-lock.json). */
export const IMAGE_LOCK_LABEL = "mc.lock-sha256";

/** sha256 of the host lockfile the mounted dist/ was built against. */
export function hostLockfileSha256(
  lockPath = `${MC_ROOT}/package-lock.json`,
): string {
  return createHash("sha256").update(readFileSync(lockPath)).digest("hex");
}

/** The image's lockfile label, or null when absent / image not inspectable. */
export function imageLockLabel(image: string): string | null {
  try {
    const out = execFileSync(
      "docker",
      [
        "image",
        "inspect",
        image,
        "--format",
        `{{index .Config.Labels "${IMAGE_LOCK_LABEL}"}}`,
      ],
      { stdio: "pipe", encoding: "utf8" },
    ).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Assets `npm run build` copies into dist/ beside the tsc output (package.json
 * `build`: `tsc && cp src/db/schema.sql … && cp src/tuning/seed-cases.json …`).
 * The sandbox executes the HOST dist/ (RUNTIME_CODE_MOUNTS) and that mount
 * shadows the image's baked `dist/db/schema.sql`, so a tsc-only host build
 * would ENOENT every container task at `initDatabase` — and the lockfile label
 * cannot see it (qa R2 W-C, 2026-09-01). Checked before spawn.
 */
export const HOST_DIST_REQUIRED_ASSETS: readonly string[] = [
  "dist/db/schema.sql",
  "dist/tuning/seed-cases.json",
];

/** Required build assets absent from the host dist/ (empty = complete). */
export function missingHostDistAssets(
  root = MC_ROOT,
  exists: (absPath: string) => boolean = existsSync,
): string[] {
  return HOST_DIST_REQUIRED_ASSETS.filter((rel) => !exists(`${root}/${rel}`));
}

export interface ImageLockDrift {
  /** sha256 of the host package-lock.json. */
  host: string;
  /** What the image carries — null = no label (built before 2026-09-01). */
  image: string | null;
}

/**
 * Pre-flight: the sandbox executes the HOST dist/ (RUNTIME_CODE_MOUNTS) on top
 * of the IMAGE's node_modules, so an image built from a different lockfile can
 * lack a module the host code imports — surfacing mid-task as an opaque
 * `Cannot find module`. Returns null when the two lockfiles match.
 * `scripts/deploy.sh` rebuilds the image on drift, so a persistent mismatch
 * means a deploy bypassed it; the caller fails loud with the rebuild line
 * (same contract as `imageExistsLocally`). `deps` is a test seam.
 */
export function imageLockDrift(
  image: string,
  deps: { host?: string; readLabel?: (image: string) => string | null } = {},
): ImageLockDrift | null {
  const host = deps.host ?? hostLockfileSha256();
  const found = (deps.readLabel ?? imageLockLabel)(image);
  return found === host ? null : { host, image: found };
}

// ---------------------------------------------------------------------------
// Sentinel payload parsing
// ---------------------------------------------------------------------------

/**
 * Result of parsing one sentinel-wrapped payload from worker stdout.
 *
 * `kind: "progress"` — heartbeat from a long-running worker. The host
 * should reset its activity timer but NOT update `lastOutput` (otherwise
 * the close handler would resolve with the heartbeat as if it were the
 * final result). `output` is undefined for this kind.
 *
 * `kind: "result"` — terminal payload from the worker (either the
 * success result or a thrown-error envelope). The host updates
 * `lastOutput` with `output` and the eventual close handler resolves
 * with it.
 */
export interface ParsedPayload {
  kind: "progress" | "result";
  output?: ContainerOutput;
}

/**
 * Pure host-side parser for one sentinel-delimited JSON payload.
 *
 * Extracted from the inline closure inside spawnContainer() so the
 * progress/result discrimination can be unit-tested without standing up
 * a docker subprocess. The closure delegates to this and applies the
 * imperative state updates (resetTimer, lastOutput). 2026-05-23.
 */
export function parsePayload(jsonStr: string): ParsedPayload {
  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

    // Heartbeat: worker emits these every 60s during long orchestrate()
    // runs so the host-side activity timer resets mid-task.
    if (parsed.type === "progress") {
      return { kind: "progress" };
    }

    const err = parsed.error;
    return {
      kind: "result",
      output: {
        status: err ? "error" : "success",
        result: (parsed.result ?? parsed.output ?? JSON.stringify(parsed)) as
          string | null,
        ...(typeof err === "string" ? { error: err } : {}),
      },
    };
  } catch {
    // Malformed JSON — preserve the original raw-string fallback the
    // closure had before extraction.
    return {
      kind: "result",
      output: {
        status: "success",
        result: jsonStr,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Docker argument construction
// ---------------------------------------------------------------------------

/**
 * Build the full `docker run …` argument vector. Extracted from spawnContainer
 * so the H5 hardening flags + env neutralization + volume allowlist can be
 * unit-tested without spawning a real docker subprocess.
 *
 * SAFE-SET resource/security limits only — deliberately NOT `--network none`
 * or `--read-only`, which break the working nanoclaw coding path (git clone,
 * npm install, /tmp writes, host-gateway inference). The container image runs
 * as root by design (it reads the mode-600 root-owned Claude SDK credentials
 * and mounts root-owned /root paths — a `--user 1000:1000` process could read
 * neither), so we drop capabilities and forbid privilege escalation instead of
 * switching users.
 */
export function buildDockerRunArgs(opts: {
  image: string;
  name: string;
  envVars?: Record<string, string>;
  volumes?: string[];
  command?: string[];
}): string[] {
  const args: string[] = [
    "run",
    "-i",
    "--rm",
    // PID 1 init (nanoclaw upstream v2.1.54 #2748 "use Docker's init
    // process"): node as PID 1 never takes SIGTERM's default action, so
    // `docker stop -t 10` always burned the full grace before SIGKILL
    // (measured 10.3 s → 0.2 s with --init, 2026-09-01), and zombie children
    // of the agent's shell were never reaped against --pids-limit.
    "--init",
    "--name",
    opts.name,
    // H5 safe-set hardening:
    "--cap-drop=ALL", // drop every Linux capability
    "--security-opt=no-new-privileges", // block setuid privilege escalation
    "--memory",
    "4g", // OOM-kill a runaway before it starves the host; 4g leaves headroom
    // for a real build (tsc/webpack on a large repo) — closure-audit I1.
    "--cpus",
    "2", // cap CPU shares
    "--pids-limit",
    "512", // fork-bomb guard
  ];

  // Environment variables (control-plane creds neutralized — see
  // SANDBOX_NEUTRALIZED_ENV).
  if (opts.envVars) {
    for (const [key, value] of Object.entries(opts.envVars)) {
      const safeValue = SANDBOX_NEUTRALIZED_ENV.get(key) ?? value;
      args.push("-e", `${key}=${safeValue}`);
    }
  }

  // Volume mounts (validated: allow-listed host path + read-only — see
  // volumeRefusal, shared with the OpenSandbox path).
  if (opts.volumes) {
    for (const vol of opts.volumes) {
      const refused = volumeRefusal(vol);
      if (refused) {
        console.warn(`[container] Blocked volume mount (${refused}): ${vol}`);
        continue;
      }
      args.push("-v", vol);
    }
  }

  args.push(opts.image);

  // Append custom command if provided (e.g. worker entrypoint).
  if (opts.command) args.push(...opts.command);

  return args;
}

// ---------------------------------------------------------------------------
// Container spawning
// ---------------------------------------------------------------------------

/**
 * Spawn a Docker container with stdin JSON input and sentinel-delimited output.
 *
 * The container receives JSON on stdin, processes it, and writes output between
 * OUTPUT_START_MARKER and OUTPUT_END_MARKER sentinel strings on stdout.
 * The parsed JSON between markers is the container's result.
 */
export function spawnContainer(opts: SpawnContainerOptions): ContainerHandle {
  const config = getConfig();
  // Fallback to the real, present image (mission-control:latest). The former
  // `nanoclawImage` default ("nanoclaw-agent:latest") never existed on the host,
  // so an image-less call silently exit-125'd — the same drift that broke the
  // nanoclaw runner. All callers pass `image` explicitly; this is the backstop.
  const image = opts.image ?? config.heavyRunnerImage;
  const name = opts.name ?? generateContainerName();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Build docker args (H5 hardening + env neutralization + volume allowlist).
  const args = buildDockerRunArgs({
    image,
    name,
    envVars: opts.envVars,
    volumes: opts.volumes,
    command: opts.command,
  });

  // Spawn the container process
  const proc = spawn("docker", args, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Write input to stdin
  const inputJson = JSON.stringify(opts.input);
  proc.stdin!.write(inputJson);
  proc.stdin!.end();

  // Create result promise with sentinel parsing and activity-aware timeout
  const result = new Promise<ContainerOutput>((resolve) => {
    let stdout = "";
    let stderr = "";
    let lastOutput: ContainerOutput | null = null;
    let timedOut = false;
    let settled = false;

    // Activity-aware timeout: resets on each successful marker parse
    let timer: ReturnType<typeof setTimeout>;

    function resetTimer(): void {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        killContainer({
          name,
          process: proc,
          result: Promise.resolve({} as ContainerOutput),
          kill: () => {},
        });
        if (!settled) {
          settled = true;
          resolve(
            lastOutput ?? {
              status: "error",
              result: null,
              error: `Container timed out after ${timeoutMs}ms`,
            },
          );
        }
      }, timeoutMs);
    }

    resetTimer();

    proc.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      parseSentinelOutput();
    });

    proc.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;

      if (timedOut) return;

      // Try one final parse
      parseSentinelOutput();

      if (lastOutput) {
        resolve(lastOutput);
      } else if (code !== 0) {
        resolve({
          status: "error",
          result: null,
          error: `Container exited with code ${code}${stderr ? `: ${stderr.slice(0, 500)}` : ""}`,
        });
      } else {
        // Exited cleanly but no sentinel output — return raw stdout
        resolve({
          status: "success",
          result: stdout.trim() || null,
        });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({
        status: "error",
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });

    function parseSentinelOutput(): void {
      let startIdx: number;
      while ((startIdx = stdout.indexOf(OUTPUT_START_MARKER)) !== -1) {
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER, startIdx);
        if (endIdx === -1) break; // Incomplete — wait for more data

        const jsonStr = stdout
          .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
          .trim();

        // Advance past this marker pair
        stdout = stdout.slice(endIdx + OUTPUT_END_MARKER.length);

        // Delegate to pure parsePayload (unit-tested) — closure only
        // applies the imperative side effects (resetTimer, lastOutput).
        const parsed = parsePayload(jsonStr);
        if (parsed.kind === "progress") {
          resetTimer();
          continue;
        }
        if (parsed.output) {
          lastOutput = parsed.output;
        }
        resetTimer();
      }
    }
  });

  const kill = () =>
    killContainer({ name, process: proc, result, kill: () => {} });

  return { name, process: proc, result, kill };
}

// ---------------------------------------------------------------------------
// Container cleanup
// ---------------------------------------------------------------------------

/**
 * Stop and kill a running container.
 * Attempts graceful stop first, falls back to SIGKILL.
 */
export function killContainer(handle: ContainerHandle): void {
  try {
    execSync(
      `docker stop -t ${Math.floor(GRACEFUL_STOP_TIMEOUT_MS / 1000)} ${handle.name}`,
      {
        timeout: GRACEFUL_STOP_TIMEOUT_MS + 5_000,
        stdio: "ignore",
      },
    );
  } catch {
    // Container may already be stopped; try force kill
    try {
      handle.process.kill("SIGKILL");
    } catch {
      // Already dead
    }
  }
}
