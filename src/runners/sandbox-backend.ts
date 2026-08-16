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

export type SandboxHandle = Pick<ContainerHandle, "name" | "result" | "kill">;

export type SandboxBackend = "docker" | "opensandbox";

/** The backend that `spawnSandbox()` will use right now. */
export function activeSandboxBackend(): SandboxBackend {
  return getConfig().sandboxBackend;
}

/** Spawn a worker in the configured sandbox backend. */
export function spawnSandbox(opts: SpawnContainerOptions): SandboxHandle {
  if (activeSandboxBackend() === "opensandbox") return spawnOpenSandbox(opts);
  return spawnContainer(opts);
}
