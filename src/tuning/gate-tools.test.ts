/**
 * The eval gate's tool population is deterministic: the env-gated builtin
 * groups and the Google / skills / memory sources register with NO env set
 * (2026-10-04 — Google tools used to be unreachable in the gate).
 */

import { describe, it, expect, vi } from "vitest";
import { ToolRegistry } from "../tools/registry.js";
import { registerEvalGateTools } from "./gate-tools.js";

const GATED_ENV = [
  "WP_SITES",
  "CRM_API_TOKEN",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
];

describe("registerEvalGateTools", () => {
  it("registers Google, WordPress, CRM, skills and memory tools with none of their env set, contacting nothing", async () => {
    for (const k of GATED_ENV) vi.stubEnv(k, "");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const registry = new ToolRegistry();
      await registerEvalGateTools(registry);
      for (const name of [
        "web_search", // builtin core
        "gmail_send",
        "gsheets_write",
        "calendar_list",
        "gdrive_list", // Google source
        "wp_publish", // builtin, WP_SITES-gated
        "crm_query", // builtin, CRM_API_TOKEN-gated
        "skill_list",
        "skill_save", // skills source
        "memory_kg_query", // memory source (backend_independent)
      ]) {
        expect(registry.has(name), name).toBe(true);
      }
      // MCP-server tools and the SDK's ToolSearch are never registered here.
      expect(registry.list().some((n) => n.startsWith("mcp__"))).toBe(false);
      expect(registry.has("ToolSearch")).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
