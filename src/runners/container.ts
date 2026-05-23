/**
 * Docker container helpers for NanoClaw runner.
 *
 * Handles container spawning via `docker run`, stdin/stdout communication
 * with sentinel-delimited output parsing, and activity-aware timeouts.
 */

import { spawn, execSync, execFileSync } from "child_process";
import type { ChildProcess } from "child_process";
import { getConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const OUTPUT_START_MARKER = "---NANOCLAW_OUTPUT_START---";
export const OUTPUT_END_MARKER = "---NANOCLAW_OUTPUT_END---";
const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
const GRACEFUL_STOP_TIMEOUT_MS = 10_000; // 10 seconds

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
  /** Volume mounts (e.g. ["/host/path:/container/path:rw"]). */
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
          | string
          | null,
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
  const image = opts.image ?? config.nanoclawImage;
  const name = opts.name ?? generateContainerName();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Build docker args
  const args: string[] = ["run", "-i", "--rm", "--name", name];

  // Add environment variables
  if (opts.envVars) {
    for (const [key, value] of Object.entries(opts.envVars)) {
      args.push("-e", `${key}=${value}`);
    }
  }

  // Add volume mounts (validated: host path must be in allowlist)
  if (opts.volumes) {
    const allowedPrefixes = [
      "/root/claude/",
      "/tmp/",
      "/root/.config/gh", // gh CLI auth (read-only for jarvis_dev PRs)
      "/root/.claude/.credentials.json", // Claude Agent SDK auth (read-only, Sonnet runner path)
    ];
    for (const vol of opts.volumes) {
      const hostPath = vol.split(":")[0];
      if (!allowedPrefixes.some((p) => hostPath.startsWith(p))) {
        console.warn(
          `[container] Blocked volume mount outside allowed paths: ${vol}`,
        );
        continue;
      }
      args.push("-v", vol);
    }
  }

  args.push(image);

  // Append custom command if provided (e.g. worker entrypoint)
  if (opts.command) args.push(...opts.command);

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
