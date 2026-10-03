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

// Ruling 3c (audit round 5, S6): a real secret index over an in-memory store.
let db: Database.Database;
vi.mock("../db/index.js", () => ({ getDatabase: () => db }));

import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { resolve } from "path";
import { activeSandboxBackend, spawnSandbox } from "./sandbox-backend.js";
import {
  resetSecretRefsForTest,
  secretPlaceholder,
} from "../lib/secret-refs.js";

const STORE_DDL = (() => {
  const schema = readFileSync(resolve(__dirname, "../db/schema.sql"), "utf8");
  const from = schema.indexOf("CREATE TABLE IF NOT EXISTS user_facts");
  const endMarker =
    "CREATE INDEX IF NOT EXISTS idx_project_log_project ON project_log(project_id);";
  return schema.slice(from, schema.indexOf(endMarker) + endMarker.length);
})();
const STORED = "sb-" + "x".repeat(14);
const PH = secretPlaceholder("SECRET_PROJECTS_ACME_FTP_PASSWORD");

const opts = { input: { prompt: "x" }, command: ["node", "w.js"] };

describe("spawnSandbox", () => {
  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(STORE_DDL);
    db.prepare(
      "INSERT INTO user_facts (category, key, value) VALUES (?, ?, ?)",
    ).run("projects", "acme_ftp_password", STORED);
    resetSecretRefsForTest();
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

  it.each(["docker", "opensandbox"])(
    "audit R5 S6 (%s): the task payload is scrubbed host-side before the backend serialises it; envVars untouched",
    (backend) => {
      mocks.config.sandboxBackend = backend;
      const spawn = backend === "docker" ? mocks.spawnContainer : mocks.spawnOpenSandbox;
      const input = {
        prompt: `Title\n\nlog in with ${STORED}`,
        title: `t ${STORED}`,
        description: `d ${STORED}`,
        history: [{ role: "user", content: `h ${STORED}` }],
        nested: { deep: [`n ${STORED}`] },
        n: 3,
      };
      const envVars = { WORKER_TOKEN: STORED };
      spawnSandbox({ input, envVars, command: ["node", "w.js"] });
      const sent = spawn.mock.calls[0]![0] as { input: unknown; envVars: unknown };
      expect(JSON.stringify(sent.input)).not.toContain(STORED);
      expect(sent.input).toEqual({
        prompt: `Title\n\nlog in with ${PH}`,
        title: `t ${PH}`,
        description: `d ${PH}`,
        history: [{ role: "user", content: `h ${PH}` }],
        nested: { deep: [`n ${PH}`] },
        n: 3,
      });
      expect(sent.envVars).toEqual(envVars);
      // The caller's object is not mutated.
      expect(input.title).toBe(`t ${STORED}`);
    },
  );

  it("audit R5 S6: no secret index → nothing is spawned (fail closed)", () => {
    db.close();
    resetSecretRefsForTest();
    expect(() => spawnSandbox({ input: { prompt: `x ${STORED}` } })).toThrow(/not open/);
    expect(mocks.spawnContainer).not.toHaveBeenCalled();
  });
});
