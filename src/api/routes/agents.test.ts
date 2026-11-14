/**
 * Agents routes on the real `agents` table through initDatabase(":memory:").
 *
 * Requests go through the router's in-process `request()`; nothing listens
 * on a port. The API key and rate limit are mounted on the parent `/api`
 * router, not on this one, so no authentication is set up here.
 *
 * `last_seen` is written with SQLite's clock; the cases age rows with
 * explicit values and compare fresh ones with the database's own clock.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { closeDatabase, initDatabase } from "../../db/index.js";
import { agents } from "./agents.js";

const OLD = "2000-01-01 00:00:00";

let db: Database.Database;

function post(path: string, body: unknown): Promise<Response> {
  return Promise.resolve(
    agents.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function row(agentId: string): Record<string, unknown> | undefined {
  return db.prepare("SELECT * FROM agents WHERE agent_id = ?").get(agentId) as
    | Record<string, unknown>
    | undefined;
}

function dbNow(): string {
  return (db.prepare("SELECT datetime('now') AS t").get() as { t: string }).t;
}

function setLastSeen(agentId: string, at: string): void {
  db.prepare("UPDATE agents SET last_seen = ?, updated_at = ? WHERE agent_id = ?").run(
    at,
    at,
    agentId,
  );
}

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
  vi.restoreAllMocks();
});

describe("POST /register", () => {
  it("inserts a new agent online with its capabilities and config as JSON (201)", async () => {
    const before = dbNow();
    const res = await post("/register", {
      agent_id: "agent-a",
      name: "Agent A",
      type: "fast",
      capabilities: ["read", "write"],
      model: "synthetic-model",
      config: { depth: 2 },
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ agent_id: "agent-a", status: "online" });
    const r = row("agent-a");
    expect(r).toMatchObject({
      name: "Agent A",
      type: "fast",
      status: "online",
      capabilities: '["read","write"]',
      model: "synthetic-model",
      config: '{"depth":2}',
    });
    expect(r?.last_seen).toEqual(expect.any(String));
    expect(String(r?.last_seen) >= before).toBe(true);
    expect(String(r?.last_seen) <= dbNow()).toBe(true);
  });

  it("updates the existing row on a second registration of the same agent_id (200)", async () => {
    await post("/register", {
      agent_id: "agent-a",
      name: "Agent A",
      type: "fast",
      model: "model-1",
    });
    // A second agent of another type: re-registering agent-a must not touch it.
    await post("/register", {
      agent_id: "agent-b",
      name: "Agent B",
      type: "nanoclaw",
      model: "model-b",
    });
    db.prepare("UPDATE agents SET status = 'offline' WHERE agent_id = 'agent-a'").run();
    setLastSeen("agent-a", OLD);

    const res = await post("/register", {
      agent_id: "agent-a",
      name: "Agent A renamed",
      type: "heavy",
      capabilities: ["plan"],
    });

    expect(res.status).toBe(200);
    const all = db.prepare("SELECT agent_id FROM agents").all();
    expect(all).toHaveLength(2);
    expect(row("agent-b")).toMatchObject({
      name: "Agent B",
      type: "nanoclaw",
      model: "model-b",
      status: "online",
    });
    const r = row("agent-a");
    expect(r).toMatchObject({
      name: "Agent A renamed",
      type: "heavy",
      status: "online",
      capabilities: '["plan"]',
      model: null,
      config: null,
    });
    expect(String(r?.last_seen) > OLD).toBe(true);
    expect(String(r?.updated_at) > OLD).toBe(true);
  });
});

describe("POST /heartbeat", () => {
  it("sets the reported status and refreshes last_seen", async () => {
    await post("/register", { agent_id: "agent-a", name: "A", type: "fast" });
    await post("/register", { agent_id: "agent-b", name: "B", type: "fast" });
    setLastSeen("agent-a", OLD);
    setLastSeen("agent-b", OLD);

    const res = await post("/heartbeat", { agent_id: "agent-a", status: "busy" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agent_id: "agent-a", status: "busy" });
    const a = row("agent-a");
    expect(a?.status).toBe("busy");
    expect(String(a?.last_seen) > OLD).toBe(true);
    expect(String(a?.last_seen) <= dbNow()).toBe(true);
    // Only the named agent is touched.
    expect(row("agent-b")).toMatchObject({ status: "online", last_seen: OLD });
  });

  it("answers 404 for an agent that never registered", async () => {
    const res = await post("/heartbeat", { agent_id: "agent-x", status: "idle" });

    expect(res.status).toBe(404);
    expect(row("agent-x")).toBeUndefined();
  });
});

describe("GET /", () => {
  it("lists agents most recently seen first, with JSON columns parsed", async () => {
    await post("/register", {
      agent_id: "agent-old",
      name: "Old",
      type: "fast",
      capabilities: ["a"],
    });
    await post("/register", {
      agent_id: "agent-new",
      name: "New",
      type: "nanoclaw",
      config: { k: "v" },
    });
    setLastSeen("agent-old", "2026-01-01 10:00:00");
    setLastSeen("agent-new", "2026-01-02 10:00:00");

    const res = await agents.request("/");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agents: Array<Record<string, unknown>>;
      count: number;
    };
    expect(body.count).toBe(2);
    expect(body.agents.map((a) => a.agent_id)).toEqual(["agent-new", "agent-old"]);
    expect(body.agents[0]).toMatchObject({
      name: "New",
      type: "nanoclaw",
      status: "online",
      capabilities: null,
      config: { k: "v" },
    });
    expect(body.agents[1]).toMatchObject({ capabilities: ["a"], config: null });
  });
});
