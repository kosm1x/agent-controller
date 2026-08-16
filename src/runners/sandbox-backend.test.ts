/**
 * Sandbox seam: SANDBOX_BACKEND selects the spawner; the default and any
 * unknown value keep the in-tree docker path (byte-identical behaviour).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawnContainer: vi.fn(),
  spawnOpenSandbox: vi.fn(),
  config: { sandboxBackend: "docker" as string },
}));

vi.mock("../config.js", () => ({
  getConfig: () => mocks.config,
}));
vi.mock("./container.js", () => ({
  spawnContainer: mocks.spawnContainer,
}));
vi.mock("./opensandbox-backend.js", () => ({
  spawnOpenSandbox: mocks.spawnOpenSandbox,
}));

import { activeSandboxBackend, spawnSandbox } from "./sandbox-backend.js";

const opts = { input: { prompt: "x" }, command: ["node", "w.js"] };

describe("spawnSandbox", () => {
  beforeEach(() => {
    mocks.spawnContainer.mockReset().mockReturnValue({ name: "docker" });
    mocks.spawnOpenSandbox.mockReset().mockReturnValue({ name: "osb" });
    mocks.config.sandboxBackend = "docker";
  });

  it("defaults to the docker path", () => {
    expect(activeSandboxBackend()).toBe("docker");
    expect(spawnSandbox(opts)).toEqual({ name: "docker" });
    expect(mocks.spawnContainer).toHaveBeenCalledWith(opts);
    expect(mocks.spawnOpenSandbox).not.toHaveBeenCalled();
  });

  it("routes to OpenSandbox only when the config says so", () => {
    mocks.config.sandboxBackend = "opensandbox";
    expect(spawnSandbox(opts)).toEqual({ name: "osb" });
    expect(mocks.spawnOpenSandbox).toHaveBeenCalledWith(opts);
    expect(mocks.spawnContainer).not.toHaveBeenCalled();
  });

  it("an unknown/undefined backend value falls back to docker (config resolves it, seam is defensive)", () => {
    mocks.config.sandboxBackend = undefined as unknown as string;
    expect(spawnSandbox(opts)).toEqual({ name: "docker" });
    mocks.config.sandboxBackend = "firecracker";
    expect(spawnSandbox(opts)).toEqual({ name: "docker" });
    expect(mocks.spawnOpenSandbox).not.toHaveBeenCalled();
  });
});
