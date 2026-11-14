/**
 * Session-end writer on the real `jarvis_files` table through
 * initDatabase(":memory:"): after the idle threshold it reads today's
 * day-log row and appends one [SESSION_END] line through a raw UPDATE, then
 * mirrors the new content to disk. The mirror is pointed at a throwaway
 * folder for every case (JARVIS_KB_MIRROR_DIR is read at call time).
 *
 * The clock is fixed at 18:00 UTC. The expected day-log date and line time
 * are those of the writer's default zone (America/Mexico_City, 12:00): the
 * cases assume RITUALS_TIMEZONE is unset, as it is in the test environment.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase, closeDatabase } from "../db/index.js";
import {
  startSessionEndWriter,
  stopSessionEndWriter,
} from "./session-end-writer.js";
import {
  SESSION_IDLE_CHECK_INTERVAL_MS,
  SESSION_IDLE_THRESHOLD_MS,
} from "../messaging/session-summary.js";
import type { MessageRouter } from "../messaging/router.js";

const NOW = new Date("2026-03-10T18:00:00Z");
const TODAY = "logs/day-logs/2026-03-10.md";
const YESTERDAY = "logs/day-logs/2026-03-09.md";
const OLD = "2000-01-01 00:00:00";
const LOG = [
  "# Day log 2026-03-10",
  "- [11:20:00] **USER**: revisar presupuesto trimestral",
  "- [11:21:00] **JARVIS**: listo",
  "- [11:30:00] **USER**: preparar agenda semanal",
  "",
].join("\n");

let db: Database.Database;
let mirror: string;
const savedMirrorEnv = process.env.JARVIS_KB_MIRROR_DIR;

function seedLog(path: string, content: string): void {
  db.prepare(
    "INSERT INTO jarvis_files (id, path, title, content, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(path, path, "day log", content, OLD);
}

const rowOf = (path: string) =>
  db
    .prepare("SELECT content, updated_at FROM jarvis_files WHERE path = ?")
    .get(path) as { content: string; updated_at: string };

/** A router whose last message is `idleMs` before the fixed clock. */
const router = (idleMs: number) =>
  ({
    getLastMessageTime: () => NOW.getTime() - idleMs,
  }) as unknown as MessageRouter;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  db = initDatabase(":memory:");
  mirror = mkdtempSync(join(tmpdir(), "session-end-writer-"));
  process.env.JARVIS_KB_MIRROR_DIR = mirror;
});

afterEach(() => {
  try {
    stopSessionEndWriter();
    closeDatabase();
    vi.useRealTimers();
  } finally {
    // Always undo the mirror redirect, even when a close step throws.
    if (savedMirrorEnv === undefined) delete process.env.JARVIS_KB_MIRROR_DIR;
    else process.env.JARVIS_KB_MIRROR_DIR = savedMirrorEnv;
    rmSync(mirror, { recursive: true, force: true });
  }
});

describe("startSessionEndWriter", () => {
  it("after the idle threshold appends one SESSION_END line to today's day-log row and its mirror", async () => {
    seedLog(TODAY, LOG);
    seedLog(YESTERDAY, LOG);
    startSessionEndWriter(router(SESSION_IDLE_THRESHOLD_MS + 60_000));

    await vi.advanceTimersByTimeAsync(SESSION_IDLE_CHECK_INTERVAL_MS);

    const today = rowOf(TODAY);
    const line =
      "- [12:05:00] **JARVIS**: [SESSION_END] 2 interacciones · temas: revisar presupuesto trimestral, preparar agenda semanal · completado\n";
    expect(today.content).toBe(LOG + line);
    expect(today.updated_at).not.toBe(OLD);
    expect(readFileSync(join(mirror, TODAY), "utf-8")).toBe(LOG + line);
    // Only today's path is touched.
    expect(rowOf(YESTERDAY)).toEqual({ content: LOG, updated_at: OLD });

    // The next check sees the marker after the last USER line: no duplicate.
    await vi.advanceTimersByTimeAsync(SESSION_IDLE_CHECK_INTERVAL_MS);
    expect(rowOf(TODAY).content).toBe(LOG + line);
  });

  it("writes nothing while the conversation is still active", async () => {
    seedLog(TODAY, LOG);
    startSessionEndWriter(router(SESSION_IDLE_THRESHOLD_MS - 10 * 60_000));

    await vi.advanceTimersByTimeAsync(SESSION_IDLE_CHECK_INTERVAL_MS);

    expect(rowOf(TODAY)).toEqual({ content: LOG, updated_at: OLD });
  });

  it("writes nothing when today has no day-log row", async () => {
    seedLog(YESTERDAY, LOG);
    startSessionEndWriter(router(SESSION_IDLE_THRESHOLD_MS + 60_000));

    await vi.advanceTimersByTimeAsync(SESSION_IDLE_CHECK_INTERVAL_MS);

    expect(rowOf(YESTERDAY)).toEqual({ content: LOG, updated_at: OLD });
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM jarvis_files WHERE path = ?").get(TODAY),
    ).toEqual({ n: 0 });
  });
});
