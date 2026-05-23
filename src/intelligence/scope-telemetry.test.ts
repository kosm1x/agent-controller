import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";

let db: Database.Database;

function freshDb() {
  const d = new Database(":memory:");
  return d;
}

vi.mock("../db/index.js", () => ({
  getDatabase: () => db,
}));

// Re-import after mocking so the module picks up the mocked getDatabase
const {
  ensureScopeTelemetryTable,
  recordScopeDecision,
  recordToolExecution,
  linkScopeToTask,
} = await import("./scope-telemetry.js");

describe("scope-telemetry — UPSERT behavior (Sprint 1 R-1)", () => {
  beforeEach(() => {
    db = freshDb();
    ensureScopeTelemetryTable();
  });

  describe("recordToolExecution — happy path (row already exists)", () => {
    it("UPDATEs an existing row when one was created by recordScopeDecision", () => {
      // Simulate the router path: insert row first, then link to task, then record.
      const rowId = recordScopeDecision(
        "hola jarvis",
        ["chat"],
        ["web_search", "file_read"],
      );
      linkScopeToTask(rowId, "task-A");

      recordToolExecution("task-A", ["web_search"], []);

      const row = db
        .prepare("SELECT * FROM scope_telemetry WHERE task_id = ?")
        .get("task-A") as Record<string, string>;
      expect(row).toBeDefined();
      expect(JSON.parse(row.tools_called)).toEqual(["web_search"]);
      expect(JSON.parse(row.active_groups)).toEqual(["chat"]); // preserved
      expect(JSON.parse(row.tools_in_scope)).toEqual([
        "web_search",
        "file_read",
      ]); // preserved
      expect(row.tool_chain).toBe("web_search");
    });

    it("does NOT INSERT when no fallback provided and no row exists", () => {
      // No prior recordScopeDecision — UPDATE finds nothing, no fallback given.
      recordToolExecution("task-orphan", ["web_search"], []);

      const rows = db
        .prepare("SELECT COUNT(*) as n FROM scope_telemetry")
        .get() as { n: number };
      expect(rows.n).toBe(0);
    });
  });

  describe("recordToolExecution — fallback INSERT (the R-1 fix)", () => {
    it("INSERTs a synthetic row when no prior row exists AND fallback is provided", () => {
      // No prior recordScopeDecision — emulate a scheduled task that
      // bypassed the messaging router. The fallback should fire.
      recordToolExecution("task-scheduled", ["jarvis_file_read"], [], {
        message: "Daily ritual: read today's day log and summarize.",
        activeGroups: [],
        toolsInScope: ["jarvis_file_read", "jarvis_file_write"],
      });

      const row = db
        .prepare("SELECT * FROM scope_telemetry WHERE task_id = ?")
        .get("task-scheduled") as Record<string, string>;
      expect(row).toBeDefined();
      expect(JSON.parse(row.tools_called)).toEqual(["jarvis_file_read"]);
      expect(JSON.parse(row.active_groups)).toEqual([]); // signals unscoped dispatch
      expect(JSON.parse(row.tools_in_scope)).toEqual([
        "jarvis_file_read",
        "jarvis_file_write",
      ]);
      expect(row.tool_chain).toBe("jarvis_file_read");
      expect(row.message).toBe(
        "Daily ritual: read today's day log and summarize.",
      );
    });

    it("truncates fallback message to 500 chars", () => {
      const longMsg = "A".repeat(800);
      recordToolExecution("task-long", [], [], {
        message: longMsg,
        activeGroups: [],
        toolsInScope: [],
      });
      const row = db
        .prepare("SELECT message FROM scope_telemetry WHERE task_id = ?")
        .get("task-long") as { message: string };
      expect(row.message.length).toBe(500);
    });

    it("does NOT INSERT a duplicate row when one already exists (fallback is no-op on UPDATE success)", () => {
      // Insert via router path first
      const rowId = recordScopeDecision("hola", ["chat"], ["web_search"]);
      linkScopeToTask(rowId, "task-B");

      // Fallback should be ignored because UPDATE found the row
      recordToolExecution("task-B", ["web_search"], [], {
        message: "this fallback should not be used",
        activeGroups: ["fallback-marker"],
        toolsInScope: ["fallback-tool"],
      });

      const rows = db
        .prepare("SELECT * FROM scope_telemetry WHERE task_id = ?")
        .all("task-B") as Record<string, string>[];
      expect(rows.length).toBe(1); // no duplicate inserted
      // Original active_groups preserved, NOT overwritten by fallback
      expect(JSON.parse(rows[0].active_groups)).toEqual(["chat"]);
    });

    it("preserves tool_chain ordering and dedup in INSERT path", () => {
      recordToolExecution(
        "task-chain",
        ["a", "b", "a", "c", "b"], // duplicates + interleaved
        [],
        {
          message: "test",
          activeGroups: [],
          toolsInScope: ["a", "b", "c"],
        },
      );

      const row = db
        .prepare("SELECT tool_chain FROM scope_telemetry WHERE task_id = ?")
        .get("task-chain") as { tool_chain: string };
      expect(row.tool_chain).toBe("a→b→c"); // ordered, deduplicated
    });
  });
});
