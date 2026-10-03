/**
 * Sandbox backend seam (2026-08-16).
 *
 * Container runners (nanoclaw, containerized heavy) call `spawnSandbox()`
 * instead of `spawnContainer()` directly. The backend is chosen once per call
 * from `SANDBOX_BACKEND`:
 *
 *   docker      — in-tree `docker run` path (container.ts). DEFAULT; the
 *                 behaviour is byte-identical to before the seam existed.
 *   opensandbox — OpenSandbox lifecycle server + execd (opensandbox-backend.ts).
 *
 * Both return the same `SandboxHandle` (`name`, `result`, `kill`) — the
 * subset of `ContainerHandle` the runners actually use.
 *
 * Reference: docs/planning/opensandbox-adoption.md
 */

import { getConfig } from "../config.js";
import {
  spawnContainer,
  type ContainerHandle,
  type SpawnContainerOptions,
} from "./container.js";
import { spawnOpenSandbox } from "./opensandbox-backend.js";
import { scrubStructured } from "../lib/secret-refs.js";

export type SandboxHandle = Pick<ContainerHandle, "name" | "result" | "kill">;

export type SandboxBackend = "docker" | "opensandbox";

/** The backend that `spawnSandbox()` will use right now. */
export function activeSandboxBackend(): SandboxBackend {
  return getConfig().sandboxBackend;
}

/**
 * Spawn a worker in the configured sandbox backend.
 *
 * Ruling 3c, audit round 5 (S6): the task payload (`input` — prompt, title,
 * description, history, every string leaf; numeric leaves equal to a stored
 * value too) is scrubbed HERE, host-side, before either backend serialises
 * it to the container's stdin: a container's model never receives a stored
 * credential value in clear. `envVars` (the worker's own config) are not
 * touched. A scrub failure throws (fail closed: nothing is spawned).
 */
export function spawnSandbox(opts: SpawnContainerOptions): SandboxHandle {
  const input = scrubStructured(opts.input) as SpawnContainerOptions["input"];
  const safe = input === opts.input ? opts : { ...opts, input };
  if (activeSandboxBackend() === "opensandbox") return spawnOpenSandbox(safe);
  return spawnContainer(safe);
}
