import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initDatabase, closeDatabase, getDatabase } from "../../db/index.js";
import { upsertFile, getFile } from "../../db/jarvis-fs.js";
import { northstarSyncTool } from "./northstar-sync.js";

// --- Fetch mock helpers ----------------------------------------------------

interface MockCall {
  method: string;
  url: string;
  body?: unknown;
}

let mockCalls: MockCall[] = [];
let commitTables: {
  visions: unknown[];
  goals: unknown[];
  objectives: unknown[];
  tasks: unknown[];
} = {
  visions: [],
  goals: [],
  objectives: [],
  tasks: [],
};

function installFetchMock() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, opts?: RequestInit) => {
      const method = (opts?.method ?? "GET").toUpperCase();
      const body = opts?.body ? JSON.parse(opts.body as string) : undefined;
      mockCalls.push({ method, url, body });

      if (method === "GET") {
        const tableMatch = url.match(/\/rest\/v1\/(\w+)\?/);
        const table = tableMatch?.[1] as keyof typeof commitTables;
        return new Response(JSON.stringify(commitTables[table] ?? []), {
          status: 200,
        });
      }
      if (method === "PATCH") {
        // Simulate the PostgREST trigger bumping last_edited_at on every PATCH.
        // Tests rely on this to verify the journal stores the post-PATCH timestamp.
        const idMatch = url.match(/id=eq\.([0-9a-f-]+)/i);
        const row = {
          id: idMatch?.[1],
          ...(body as Record<string, unknown>),
          last_edited_at: patchedLastEditedAt,
          modified_by: "system",
        };
        return new Response(JSON.stringify([row]), { status: 200 });
      }
      if (method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return new Response("", { status: 200 });
    }),
  );
}

// Controls the simulated post-PATCH last_edited_at from the server trigger.
let patchedLastEditedAt = "2026-04-21T00:00:00Z";

// --- Test fixture helpers --------------------------------------------------

function makeCommitItem(
  id: string,
  title: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    user_id: "a8ad98e1-b9c6-4447-ab80-bac467835b3a",
    title,
    description: `${title} description`,
    status: "in_progress",
    target_date: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
    last_edited_at: "2026-04-01T00:00:00Z",
    order: 0,
    modified_by: "user",
    ...overrides,
  };
}

function seedJournalRow(
  commitId: string,
  kind: string,
  localPath: string,
  lastCommitEditedAt: string,
  syncedLongAgo = true,
) {
  const db = getDatabase();
  const syncAt = syncedLongAgo
    ? "2026-01-15T00:00:00Z"
    : new Date().toISOString();
  db.prepare(
    `INSERT INTO northstar_sync_state
       (commit_id, kind, local_path, last_commit_edited_at, last_local_edit_time, last_sync_at)
     VALUES (?, ?, ?, ?, NULL, ?)`,
  ).run(commitId, kind, localPath, lastCommitEditedAt, syncAt);
}

function journalCount(): number {
  const db = getDatabase();
  const row = db
    .prepare("SELECT COUNT(*) as c FROM northstar_sync_state")
    .get() as { c: number };
  return row.c;
}

function journalGet(commitId: string): Record<string, unknown> | null {
  const db = getDatabase();
  return (
    (db
      .prepare("SELECT * FROM northstar_sync_state WHERE commit_id = ?")
      .get(commitId) as Record<string, unknown> | undefined) ?? null
  );
}

// --- Setup / teardown ------------------------------------------------------

beforeEach(() => {
  initDatabase(":memory:");
  process.env.COMMIT_DB_KEY = "test-key";
  mockCalls = [];
  commitTables = { visions: [], goals: [], objectives: [], tasks: [] };
  patchedLastEditedAt = "2026-04-21T00:00:00Z";
  installFetchMock();
});

afterEach(() => {
  vi.unstubAllGlobals();
  closeDatabase();
});

// --- Tests -----------------------------------------------------------------

describe("northstar_sync — bootstrap", () => {
  it("first run with empty journal pulls every COMMIT item as local create", async () => {
    const goalId = "11111111-1111-1111-1111-111111111111";
    commitTables.goals = [makeCommitItem(goalId, "Learn Rust")];

    expect(journalCount()).toBe(0);

    const result = await northstarSyncTool.execute({});
    expect(result).toContain("bootstrap");
    expect(result).toContain("Pulled: 1");
    expect(result).toContain("Deleted local: 0");
    expect(result).toContain("Deleted remote: 0");

    const file = getFile(
      `NorthStar/goals/learn-rust--${goalId.slice(0, 8)}.md`,
    );
    expect(file).not.toBeNull();
    expect(file?.content).toContain(`COMMIT_ID: ${goalId}`);
    expect(file?.content).toContain("# Learn Rust");

    // Journal seeded
    const row = journalGet(goalId);
    expect(row).not.toBeNull();
    expect(row?.kind).toBe("goal");
  });

  it("two records with identical titles get collision-proof distinct paths", async () => {
    const id1 = "aa000001-0000-0000-0000-000000000001";
    const id2 = "bb000002-0000-0000-0000-000000000002";
    commitTables.tasks = [
      makeCommitItem(id1, "Probar en servidor local"),
      makeCommitItem(id2, "Probar en servidor local"),
    ];

    await northstarSyncTool.execute({});

    const f1 = getFile(
      `NorthStar/tasks/probar-en-servidor-local--${id1.slice(0, 8)}.md`,
    );
    const f2 = getFile(
      `NorthStar/tasks/probar-en-servidor-local--${id2.slice(0, 8)}.md`,
    );
    expect(f1).not.toBeNull();
    expect(f2).not.toBeNull();
    expect(f1?.content).toContain(`COMMIT_ID: ${id1}`);
    expect(f2?.content).toContain(`COMMIT_ID: ${id2}`);
  });

  it("bootstrap never issues DELETE against COMMIT even if local file is missing", async () => {
    // Simulates: journal is empty, COMMIT has a record, local has nothing.
    // This could be "first run with prior local deletion" — bootstrap treats as CREATE, not DELETE.
    const goalId = "22222222-2222-2222-2222-222222222222";
    commitTables.goals = [makeCommitItem(goalId, "Do not delete me")];

    await northstarSyncTool.execute({});

    const deleteCalls = mockCalls.filter((c) => c.method === "DELETE");
    expect(deleteCalls).toHaveLength(0);
  });
});

describe("northstar_sync — LWW update branches", () => {
  it("pulls when COMMIT has user edit and local has none", async () => {
    const goalId = "33333333-3333-3333-3333-333333333333";
    const filePath = "NorthStar/goals/existing.md";
    upsertFile(
      filePath,
      "Existing",
      `# Existing\nCOMMIT_ID: ${goalId}\nStatus: in_progress\n`,
      ["northstar", "goal"],
      "reference",
      30,
      null,
      [],
      { skipUserEdit: true }, // sync-originated, no user edit
    );
    seedJournalRow(goalId, "goal", filePath, "2026-04-01T00:00:00Z");

    commitTables.goals = [
      makeCommitItem(goalId, "Existing Renamed", {
        modified_by: "user",
        last_edited_at: "2026-04-19T00:00:00Z",
        status: "completed",
      }),
    ];

    const result = await northstarSyncTool.execute({});
    expect(result).toContain("Pulled: 1");

    const file = getFile(filePath);
    expect(file?.content).toContain("Status: completed");
    expect(file?.content).toContain("# Existing Renamed");
  });

  it("pushes when local has user edit and COMMIT modified_by is system", async () => {
    const goalId = "44444444-4444-4444-4444-444444444444";
    const filePath = "NorthStar/goals/pushable.md";
    // Sync-write first to get the file in place...
    upsertFile(
      filePath,
      "Pushable",
      `# Pushable\nCOMMIT_ID: ${goalId}\nStatus: in_progress\nDescription: old\n`,
      ["northstar", "goal"],
      "reference",
      30,
      null,
      [],
      { skipUserEdit: true },
    );
    seedJournalRow(goalId, "goal", filePath, "2026-04-01T00:00:00Z");
    // ...then simulate a user edit via a non-skipUserEdit upsert.
    upsertFile(
      filePath,
      "Pushable",
      `# Pushable\nCOMMIT_ID: ${goalId}\nStatus: in_progress\nDescription: NEW NOTES FROM USER\n`,
      ["northstar", "goal"],
      "reference",
      30,
    );

    commitTables.goals = [
      makeCommitItem(goalId, "Pushable", {
        modified_by: "system",
        description: "old",
      }),
    ];

    patchedLastEditedAt = "2026-04-21T12:00:00Z";
    const result = await northstarSyncTool.execute({});
    expect(result).toContain("Pushed: 1");

    const patchCall = mockCalls.find((c) => c.method === "PATCH");
    expect(patchCall).toBeDefined();
    expect(patchCall?.url).toContain(`/goals?id=eq.${goalId}`);
    const body = patchCall?.body as Record<string, unknown>;
    expect(body.description).toBe("NEW NOTES FROM USER");
    expect(body.modified_by).toBe("system");

    // Journal must capture the trigger-bumped last_edited_at, not the
    // pre-PATCH value from commit. This proves the return=representation
    // plumbing works end-to-end.
    const row = journalGet(goalId);
    expect(row?.last_commit_edited_at).toBe("2026-04-21T12:00:00Z");
  });

  it("field diff — PATCH omits fields that match commit's current value", async () => {
    const goalId = "ddddcccc-dddd-cccc-dddd-ccccddddcccc";
    const filePath = "NorthStar/goals/diff.md";
    // Seed the local file via sync so skipUserEdit=true (no user edit), then
    // user edits only the description — status/title should NOT be in the PATCH.
    upsertFile(
      filePath,
      "Diffable",
      `# Diffable\nCOMMIT_ID: ${goalId}\nStatus: in_progress\nDescription: original\n`,
      ["northstar", "goal"],
      "reference",
      30,
      null,
      [],
      { skipUserEdit: true },
    );
    seedJournalRow(goalId, "goal", filePath, "2026-04-01T00:00:00Z");
    upsertFile(
      filePath,
      "Diffable",
      `# Diffable\nCOMMIT_ID: ${goalId}\nStatus: in_progress\nDescription: changed\n`,
      ["northstar", "goal"],
      "reference",
      30,
    );

    commitTables.goals = [
      makeCommitItem(goalId, "Diffable", {
        modified_by: "system",
        description: "original",
        status: "in_progress",
      }),
    ];

    await northstarSyncTool.execute({});

    const patchCall = mockCalls.find((c) => c.method === "PATCH");
    const body = patchCall?.body as Record<string, unknown>;
    expect(body.description).toBe("changed");
    expect(body.title).toBeUndefined();
    expect(body.status).toBeUndefined();
  });

  it("field-remove — deleting a Notes line pushes null to clear remote", async () => {
    const taskId = "12340000-0000-0000-0000-000000000001";
    const filePath = "NorthStar/tasks/clear-notes.md";
    upsertFile(
      filePath,
      "Clear notes",
      `# Clear notes\nCOMMIT_ID: ${taskId}\nStatus: in_progress\nNotes: old notes\n`,
      ["northstar", "task"],
      "reference",
      30,
      null,
      [],
      { skipUserEdit: true },
    );
    seedJournalRow(taskId, "task", filePath, "2026-04-01T00:00:00Z");
    // User edits: removes the Notes line entirely.
    upsertFile(
      filePath,
      "Clear notes",
      `# Clear notes\nCOMMIT_ID: ${taskId}\nStatus: in_progress\n`,
      ["northstar", "task"],
      "reference",
      30,
    );

    commitTables.tasks = [
      makeCommitItem(taskId, "Clear notes", {
        modified_by: "system",
        notes: "old notes",
      }),
    ];

    await northstarSyncTool.execute({});

    const patchCall = mockCalls.find((c) => c.method === "PATCH");
    const body = patchCall?.body as Record<string, unknown>;
    expect(body.notes).toBeNull();
  });

  it("field-remove — title and status are preserved when lines are absent", async () => {
    // `title` and `status` must never be nulled via sync — a record without a
    // title or status is nonsense. If the user accidentally deletes the `# …`
    // or `Status:` line, we leave the remote alone.
    const goalId = "12340000-0000-0000-0000-000000000002";
    const filePath = "NorthStar/goals/no-headers.md";
    upsertFile(
      filePath,
      "Headerless",
      `# Headerless\nCOMMIT_ID: ${goalId}\nStatus: in_progress\nDescription: still here\n`,
      ["northstar", "goal"],
      "reference",
      30,
      null,
      [],
      { skipUserEdit: true },
    );
    seedJournalRow(goalId, "goal", filePath, "2026-04-01T00:00:00Z");
    // User mutilates the file — no `# …`, no `Status:` line — but keeps Description.
    upsertFile(
      filePath,
      "Headerless",
      `COMMIT_ID: ${goalId}\nDescription: changed\n`,
      ["northstar", "goal"],
      "reference",
      30,
    );

    commitTables.goals = [
      makeCommitItem(goalId, "Headerless", {
        modified_by: "system",
        description: "old",
        status: "in_progress",
      }),
    ];

    await northstarSyncTool.execute({});

    const patchCall = mockCalls.find((c) => c.method === "PATCH");
    const body = patchCall?.body as Record<string, unknown>;
    expect(body.description).toBe("changed");
    expect(body.title).toBeUndefined();
    expect(body.status).toBeUndefined();
    // modified_by is always stamped — that's fine, it's not a clearable field.
    expect(body.modified_by).toBe("system");
  });

  it("modified_by='system' blocks pull even if last_edited_at advanced", async () => {
    // Proves `modified_by` is an independent gate on top of the timestamp
    // comparison. Without this guard, a trigger-bumped last_edited_at after
    // our own sync PATCH would masquerade as a user edit.
    const goalId = "eeeedddd-eeee-dddd-eeee-ddddeeeedddd";
    const filePath = "NorthStar/goals/sys-advanced.md";
    upsertFile(
      filePath,
      "System advanced",
      `# System advanced\nCOMMIT_ID: ${goalId}\nStatus: in_progress\n`,
      ["northstar", "goal"],
      "reference",
      30,
      null,
      [],
      { skipUserEdit: true },
    );
    seedJournalRow(goalId, "goal", filePath, "2026-04-01T00:00:00Z");

    commitTables.goals = [
      makeCommitItem(goalId, "System advanced", {
        modified_by: "system",
        last_edited_at: "2026-04-20T00:00:00Z", // advanced past journal
      }),
    ];

    const result = await northstarSyncTool.execute({});
    expect(result).toContain("Pulled: 0");
  });

  it("commit wins tiebreak when both sides edited and commit timestamp is newer", async () => {
    const goalId = "55555555-5555-5555-5555-555555555555";
    const filePath = "NorthStar/goals/conflict.md";
    upsertFile(
      filePath,
      "Conflict",
      `# Conflict\nCOMMIT_ID: ${goalId}\nStatus: in_progress\n`,
      ["northstar", "goal"],
      "reference",
      30,
      null,
      [],
      { skipUserEdit: true },
    );
    seedJournalRow(goalId, "goal", filePath, "2026-01-01T00:00:00Z");
    // Local user edit at t=old
    upsertFile(
      filePath,
      "Conflict",
      `# Conflict\nCOMMIT_ID: ${goalId}\nStatus: in_progress\nDescription: local\n`,
      ["northstar", "goal"],
      "reference",
      30,
    );
    // Manually backdate local.user_edit_time
    getDatabase()
      .prepare(
        `UPDATE jarvis_files SET user_edit_time = '2026-04-10T00:00:00Z' WHERE path = ?`,
      )
      .run(filePath);

    commitTables.goals = [
      makeCommitItem(goalId, "Conflict Remote Wins", {
        modified_by: "user",
        last_edited_at: "2026-04-20T00:00:00Z",
        description: "remote",
      }),
    ];

    const result = await northstarSyncTool.execute({});
    expect(result).toContain("Pulled: 1");
    expect(result).not.toContain("Pushed: 1");

    const file = getFile(filePath);
    expect(file?.content).toContain("# Conflict Remote Wins");
  });
});

describe("northstar_sync — delete propagation", () => {
  it("propagates local delete to COMMIT via DELETE when journal has the record", async () => {
    const goalId = "66666666-6666-6666-6666-666666666666";
    // Journal exists but no local file — user deleted it.
    seedJournalRow(
      goalId,
      "goal",
      "NorthStar/goals/deleted-locally.md",
      "2026-04-01T00:00:00Z",
    );
    commitTables.goals = [makeCommitItem(goalId, "Should be deleted")];

    const result = await northstarSyncTool.execute({});
    expect(result).toContain("Deleted remote: 1");

    const deleteCall = mockCalls.find((c) => c.method === "DELETE");
    expect(deleteCall?.url).toContain(`/goals?id=eq.${goalId}`);

    // Journal row gone
    expect(journalGet(goalId)).toBeNull();
  });

  it("propagates COMMIT delete to local filesystem when journal has the record", async () => {
    const goalId = "77777777-7777-7777-7777-777777777777";
    const filePath = "NorthStar/goals/will-be-deleted.md";
    upsertFile(
      filePath,
      "Will be deleted",
      `# Will be deleted\nCOMMIT_ID: ${goalId}\n`,
      ["northstar", "goal"],
      "reference",
      30,
      null,
      [],
      { skipUserEdit: true },
    );
    seedJournalRow(goalId, "goal", filePath, "2026-04-01T00:00:00Z");

    // COMMIT tables empty — record gone from remote.
    const result = await northstarSyncTool.execute({});
    expect(result).toContain("Deleted local: 1");

    expect(getFile(filePath)).toBeNull();
    expect(journalGet(goalId)).toBeNull();
  });

  it("local-only with COMMIT_ID and no journal row skips without DELETE", async () => {
    // A file with COMMIT_ID that isn't in the journal and isn't on COMMIT is
    // the "v1 limitation" case — we don't POST to recreate it, but we must
    // NEVER delete it either. The skipped path surfaces in the return string.
    const goalId = "ffff1111-ffff-1111-ffff-111111111111";
    const filePath = "NorthStar/goals/orphan-local.md";
    upsertFile(
      filePath,
      "Orphan local",
      `# Orphan local\nCOMMIT_ID: ${goalId}\nStatus: in_progress\n`,
      ["northstar", "goal"],
      "reference",
      30,
    );
    // Seed an unrelated journal row so we're not in bootstrap mode.
    seedJournalRow(
      "00000000-0000-0000-0000-000000000099",
      "goal",
      "NorthStar/goals/other.md",
      "2026-04-01T00:00:00Z",
    );

    const result = await northstarSyncTool.execute({});
    expect(result).toContain("Skipped: 1");
    expect(result).toContain(filePath);

    const deleteCalls = mockCalls.filter((c) => c.method === "DELETE");
    expect(deleteCalls).toHaveLength(0);
    // Local file survives untouched.
    expect(getFile(filePath)).not.toBeNull();
  });

  it("drops journal row when both sides are gone", async () => {
    const goalId = "88888888-8888-8888-8888-888888888888";
    seedJournalRow(
      goalId,
      "goal",
      "NorthStar/goals/orphan.md",
      "2026-04-01T00:00:00Z",
    );

    await northstarSyncTool.execute({});

    expect(journalGet(goalId)).toBeNull();
  });
});

describe("northstar_sync — no-op stability", () => {
  it("second sync after a pull does not re-pull the same record", async () => {
    // Simulates: journal row has last_commit_edited_at matching current commit.last_edited_at.
    // Even though commit.modified_by=="user" (the app wrote last, not us),
    // the timestamp comparison should reveal "no change since last sync".
    const goalId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const filePath = "NorthStar/goals/already-pulled.md";
    upsertFile(
      filePath,
      "Already pulled",
      `# Already pulled\nCOMMIT_ID: ${goalId}\nStatus: in_progress\n`,
      ["northstar", "goal"],
      "reference",
      30,
      null,
      [],
      { skipUserEdit: true },
    );
    const lastEditedAt = "2026-04-20T00:00:00Z";
    getDatabase()
      .prepare(
        `INSERT INTO northstar_sync_state
           (commit_id, kind, local_path, last_commit_edited_at, last_local_edit_time, last_sync_at)
         VALUES (?, ?, ?, ?, NULL, datetime('now'))`,
      )
      .run(goalId, "goal", filePath, lastEditedAt);

    commitTables.goals = [
      makeCommitItem(goalId, "Already pulled", {
        modified_by: "user",
        last_edited_at: lastEditedAt,
      }),
    ];

    const result = await northstarSyncTool.execute({});
    expect(result).toContain("Pulled: 0");
    expect(result).toContain("Pushed: 0");
    const patchCalls = mockCalls.filter((c) => c.method === "PATCH");
    expect(patchCalls).toHaveLength(0);
  });

  it("concurrent invocation is rejected by the reentrancy guard", async () => {
    commitTables.goals = [
      makeCommitItem("cccccccc-cccc-cccc-cccc-cccccccccccc", "Pending"),
    ];
    const p1 = northstarSyncTool.execute({});
    const second = await northstarSyncTool.execute({});
    expect(second).toContain("already in progress");
    await p1; // let the first call finish and clear the guard
  });

  it("modified_by=system round-trip does not cause push/pull loop", async () => {
    const goalId = "99999999-9999-9999-9999-999999999999";
    const filePath = "NorthStar/goals/stable.md";
    upsertFile(
      filePath,
      "Stable",
      `# Stable\nCOMMIT_ID: ${goalId}\nStatus: in_progress\n`,
      ["northstar", "goal"],
      "reference",
      30,
      null,
      [],
      { skipUserEdit: true },
    );
    seedJournalRow(goalId, "goal", filePath, "2026-04-20T00:00:00Z", false);

    commitTables.goals = [
      makeCommitItem(goalId, "Stable", { modified_by: "system" }),
    ];

    const result = await northstarSyncTool.execute({});
    expect(result).toContain("Pulled: 0");
    expect(result).toContain("Pushed: 0");
    expect(result).toContain("Deleted");

    const patchCalls = mockCalls.filter((c) => c.method === "PATCH");
    const deleteCalls = mockCalls.filter((c) => c.method === "DELETE");
    expect(patchCalls).toHaveLength(0);
    expect(deleteCalls).toHaveLength(0);
  });
});
