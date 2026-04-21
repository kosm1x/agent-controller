/**
 * Tests for canary — self-monitoring health checks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runCanaryCheck } from "./canary.js";
import { initDatabase, closeDatabase, getDatabase } from "../db/index.js";

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
  vi.restoreAllMocks();
});

describe("runCanaryCheck", () => {
  it("returns healthy metrics on empty DB", () => {
    const result = runCanaryCheck();
    expect(result.taskSuccessRate).toBe(1);
    expect(result.totalTasks).toBe(0);
    expect(result.alerts).toHaveLength(0);
  });

  it("detects low success rate", () => {
    const db = getDatabase();
    // Insert 10 tasks: 5 completed, 5 failed
    for (let i = 0; i < 10; i++) {
      db.prepare(
        "INSERT INTO tasks (task_id, title, description, status, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
      ).run(`task-${i}`, `Task ${i}`, "test", i < 5 ? "completed" : "failed");
    }

    const result = runCanaryCheck();
    expect(result.taskSuccessRate).toBe(0.5);
    expect(result.totalTasks).toBe(10);
    expect(result.alerts.length).toBeGreaterThan(0);
    expect(result.alerts[0]).toContain("50%");
  });

  it("does not alert when success rate is above threshold", () => {
    const db = getDatabase();
    for (let i = 0; i < 10; i++) {
      db.prepare(
        "INSERT INTO tasks (task_id, title, description, status, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
      ).run(`task-${i}`, `Task ${i}`, "test", i < 8 ? "completed" : "failed");
    }

    const result = runCanaryCheck();
    expect(result.taskSuccessRate).toBe(0.8);
    expect(result.alerts).toHaveLength(0);
  });

  it("does not alert with fewer than 5 tasks", () => {
    const db = getDatabase();
    // 2 tasks, both failed — but total < 5 so no alert
    for (let i = 0; i < 2; i++) {
      db.prepare(
        "INSERT INTO tasks (task_id, title, description, status, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
      ).run(`task-${i}`, `Task ${i}`, "test", "failed");
    }

    const result = runCanaryCheck();
    expect(result.alerts).toHaveLength(0);
  });

  it("does not count chat tasks with gmail_send in the default allowlist as missed deliveries", () => {
    const db = getDatabase();
    // Simulate 10 chat tasks that completed_with_concerns. Each has gmail_send
    // in its tool allowlist (the chat default) but no user intent to email —
    // and none called gmail_send. The *old* canary flagged all 10 as misses.
    const chatMetadata = JSON.stringify({
      tags: ["messaging", "telegram"],
      tools: ["jarvis_file_read", "web_search", "gmail_send", "memory_store"],
    });
    const chatOutput = JSON.stringify({
      text: "ok",
      toolCalls: ["jarvis_file_read"],
    });
    for (let i = 0; i < 10; i++) {
      db.prepare(
        "INSERT INTO tasks (task_id, title, description, status, metadata, output, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))",
      ).run(
        `chat-${i}`,
        `Chat: Lista mi NorthStar ${i}`,
        "chat",
        "completed_with_concerns",
        chatMetadata,
        chatOutput,
      );
    }

    const result = runCanaryCheck();
    expect(result.deliveryMisses).toBe(0);
    expect(
      result.alerts.some((a) => a.includes("email deliveries did not call")),
    ).toBe(false);
  });

  it("counts a scheduled email task that did not call gmail_send as a miss", () => {
    const db = getDatabase();
    // Needs ≥5 tasks to avoid success-rate guard; pad with 5 successful tasks.
    for (let i = 0; i < 5; i++) {
      db.prepare(
        "INSERT INTO tasks (task_id, title, description, status, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
      ).run(`pad-${i}`, `Padding ${i}`, "pad", "completed");
    }
    // 3 scheduled tasks that should have sent email but didn't — crosses the >2 threshold.
    const scheduledMetadata = JSON.stringify({
      tags: ["scheduled", "schedule:abc-123"],
      tools: ["web_search", "gmail_send"],
    });
    const outputWithoutGmail = JSON.stringify({
      text: "Report body",
      toolCalls: ["web_search"],
    });
    for (let i = 0; i < 3; i++) {
      db.prepare(
        "INSERT INTO tasks (task_id, title, description, status, metadata, output, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))",
      ).run(
        `sched-miss-${i}`,
        `[Scheduled] Reporte Diario ${i}`,
        "scheduled",
        "completed_with_concerns",
        scheduledMetadata,
        outputWithoutGmail,
      );
    }

    const result = runCanaryCheck();
    expect(result.deliveryMisses).toBe(3);
    expect(
      result.alerts.some((a) =>
        a.includes(
          "3 scheduled/ritual email deliveries did not call gmail_send",
        ),
      ),
    ).toBe(true);
  });

  it("counts a ritual (Morning briefing / Nightly close) that didn't send as a miss, even with empty metadata", () => {
    const db = getDatabase();
    for (let i = 0; i < 5; i++) {
      db.prepare(
        "INSERT INTO tasks (task_id, title, description, status, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
      ).run(`pad-${i}`, `Padding ${i}`, "pad", "completed");
    }
    // Rituals don't populate metadata.tools — title prefix alone qualifies.
    const outputWithoutGmail = JSON.stringify({
      text: "Briefing body",
      toolCalls: ["jarvis_file_read"],
    });
    const ritualTitles = [
      "Morning briefing — 2026-04-21",
      "Nightly close — 2026-04-20",
      "Signal intelligence — 2026-04-21",
    ];
    for (const [i, title] of ritualTitles.entries()) {
      db.prepare(
        "INSERT INTO tasks (task_id, title, description, status, output, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))",
      ).run(
        `ritual-${i}`,
        title,
        "ritual",
        "completed_with_concerns",
        outputWithoutGmail,
      );
    }

    const result = runCanaryCheck();
    expect(result.deliveryMisses).toBe(3);
  });

  it("counts a ritual that FAILED without calling gmail_send (retry-exhausted case)", () => {
    const db = getDatabase();
    for (let i = 0; i < 5; i++) {
      db.prepare(
        "INSERT INTO tasks (task_id, title, description, status, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
      ).run(`pad-${i}`, `Padding ${i}`, "pad", "completed");
    }
    // When a ritual has gmail_send in requiredTools but the retry also misses,
    // the dispatcher downgrades status to `failed`. This is the MOST important
    // state for the canary to catch — it's the "retry already fired, still
    // no email" case the operator actually needs alerting on.
    const outputWithoutGmail = JSON.stringify({
      text: "[error_max_turns] partial response",
      toolCalls: ["jarvis_file_read"],
    });
    for (let i = 0; i < 3; i++) {
      db.prepare(
        "INSERT INTO tasks (task_id, title, description, status, output, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))",
      ).run(
        `failed-${i}`,
        `Morning briefing — 2026-04-2${i}`,
        "ritual",
        "failed",
        outputWithoutGmail,
      );
    }

    const result = runCanaryCheck();
    expect(result.deliveryMisses).toBe(3);
  });

  it("does not flag chat tasks whose description happens to contain the bare word `scheduled`", () => {
    const db = getDatabase();
    // Adversarial: a chat task whose description contains the word "scheduled"
    // in free text, OR whose tags contain a non-exact-match like
    // `"schedule-related"`. The canary's quoted-form `%"scheduled"%` substring
    // MUST NOT match these — only the exact JSON-array token `"scheduled"`.
    const sneakyMetadata = JSON.stringify({
      tags: ["messaging", "telegram", "schedule-followup"],
      tools: ["jarvis_file_read", "gmail_send"],
    });
    const chatOutput = JSON.stringify({
      text: "ok",
      toolCalls: ["jarvis_file_read"],
    });
    for (let i = 0; i < 10; i++) {
      db.prepare(
        "INSERT INTO tasks (task_id, title, description, status, metadata, output, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))",
      ).run(
        `sneaky-${i}`,
        `Chat: I had scheduled a thing for tomorrow ${i}`,
        "this task was scheduled by the user in conversation",
        "completed_with_concerns",
        sneakyMetadata,
        chatOutput,
      );
    }

    const result = runCanaryCheck();
    expect(result.deliveryMisses).toBe(0);
  });

  it("does not count a scheduled task that DID call gmail_send", () => {
    const db = getDatabase();
    for (let i = 0; i < 5; i++) {
      db.prepare(
        "INSERT INTO tasks (task_id, title, description, status, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
      ).run(`pad-${i}`, `Padding ${i}`, "pad", "completed");
    }
    const metadata = JSON.stringify({
      tags: ["scheduled", "schedule:xyz"],
      tools: ["web_search", "gmail_send"],
    });
    const outputWithGmail = JSON.stringify({
      text: "Sent",
      toolCalls: ["web_search", "gmail_send"],
    });
    db.prepare(
      "INSERT INTO tasks (task_id, title, description, status, metadata, output, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))",
    ).run(
      "sched-ok",
      "[Scheduled] Reporte Diario OK",
      "scheduled",
      "completed_with_concerns",
      metadata,
      outputWithGmail,
    );

    const result = runCanaryCheck();
    expect(result.deliveryMisses).toBe(0);
  });
});
