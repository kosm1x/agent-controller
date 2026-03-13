/**
 * Docker container helpers for NanoClaw runner.
 *
 * Handles container spawning via `docker run`, stdin/stdout communication
 * with sentinel-delimited output parsing, and activity-aware timeouts.
 */

import { spawn, execSync } from "child_process";
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

        try {
          const parsed = JSON.parse(jsonStr);
          lastOutput = {
            status: parsed.error ? "error" : "success",
            result: parsed.result ?? parsed.output ?? JSON.stringify(parsed),
            error: parsed.error,
          };
          resetTimer(); // Activity detected — reset timeout
        } catch {
          lastOutput = {
            status: "success",
            result: jsonStr,
          };
          resetTimer();
        }
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
