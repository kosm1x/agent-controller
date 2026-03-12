/**
 * Agent API routes.
 *
 * POST /agents/register  — Agent self-registration
 * POST /agents/heartbeat — Agent heartbeat
 * GET  /agents           — List agents
 */

import { Hono } from "hono";
import { getDatabase } from "../../db/index.js";

const agents = new Hono();

interface AgentRow {
  id: number;
  agent_id: string;
  name: string;
  type: string;
  status: string;
  capabilities: string | null;
  model: string | null;
  config: string | null;
  last_seen: string | null;
  created_at: string;
  updated_at: string;
}

// Register an agent
agents.post("/register", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { agent_id, name, type, capabilities, model, config } = body;

  if (!agent_id || typeof agent_id !== "string") {
    return c.json({ error: "agent_id is required (string)" }, 400);
  }
  if (!name || typeof name !== "string") {
    return c.json({ error: "name is required (string)" }, 400);
  }
  if (!type || !["fast", "nanoclaw", "heavy"].includes(type)) {
    return c.json({ error: "type must be one of: fast, nanoclaw, heavy" }, 400);
  }

  const db = getDatabase();
  const existing = db
    .prepare("SELECT id FROM agents WHERE agent_id = ?")
    .get(agent_id) as { id: number } | undefined;

  if (existing) {
    db.prepare(
      `
      UPDATE agents SET name = ?, type = ?, status = 'online', capabilities = ?, model = ?, config = ?, last_seen = datetime('now'), updated_at = datetime('now')
      WHERE agent_id = ?
    `,
    ).run(
      name,
      type,
      capabilities ? JSON.stringify(capabilities) : null,
      model ?? null,
      config ? JSON.stringify(config) : null,
      agent_id,
    );
  } else {
    db.prepare(
      `
      INSERT INTO agents (agent_id, name, type, status, capabilities, model, config, last_seen)
      VALUES (?, ?, ?, 'online', ?, ?, ?, datetime('now'))
    `,
    ).run(
      agent_id,
      name,
      type,
      capabilities ? JSON.stringify(capabilities) : null,
      model ?? null,
      config ? JSON.stringify(config) : null,
    );
  }

  return c.json({ agent_id, status: "online" }, existing ? 200 : 201);
});

// Agent heartbeat
agents.post("/heartbeat", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { agent_id, status } = body;
  if (!agent_id || typeof agent_id !== "string") {
    return c.json({ error: "agent_id is required (string)" }, 400);
  }

  const db = getDatabase();
  const validStatuses = ["online", "idle", "busy", "error"];
  const agentStatus = validStatuses.includes(status) ? status : "online";

  const result = db
    .prepare(
      `
    UPDATE agents SET status = ?, last_seen = datetime('now'), updated_at = datetime('now')
    WHERE agent_id = ?
  `,
    )
    .run(agentStatus, agent_id);

  if (result.changes === 0) {
    return c.json({ error: "Agent not found. Register first." }, 404);
  }

  return c.json({ agent_id, status: agentStatus });
});

// List agents
agents.get("/", (c) => {
  const db = getDatabase();
  const rows = db
    .prepare("SELECT * FROM agents ORDER BY last_seen DESC")
    .all() as AgentRow[];

  const result = rows.map((row) => ({
    ...row,
    capabilities: row.capabilities ? JSON.parse(row.capabilities) : null,
    config: row.config ? JSON.parse(row.config) : null,
  }));

  return c.json({ agents: result, count: result.length });
});

export { agents };
