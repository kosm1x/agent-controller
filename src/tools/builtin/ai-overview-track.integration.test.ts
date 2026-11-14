/**
 * ai_overview_track snapshot write on the real `ai_overview_tracking` table.
 *
 * ai-overview-track.test.ts stubs `prepare`, so it never runs the INSERT.
 * The write swallows its own errors (the tool must still answer), so a wrong
 * column would show only as a missing row and a missing `snapshot_id`: the
 * cases read the row back. The SERP fetch is stubbed and rejects unless a
 * case answers it, so no browser and no network are ever reached.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";

vi.mock("../../lib/stealth-browser.js", () => ({
  stealthFetch: vi.fn(async () => {
    throw new Error("unexpected stealthFetch call");
  }),
}));

import { closeDatabase, initDatabase } from "../../db/index.js";
import { stealthFetch } from "../../lib/stealth-browser.js";
import { aiOverviewTrackTool } from "./ai-overview-track.js";

const SERP_WITH_OVERVIEW = `
<div data-attrid="AIOverview">
  <p>synthetic summary</p>
  <a href="https://source-a.example/article">Source A article</a>
</div>
<a href="/url?q=https://organic.example/page"><h3>Organic page</h3></a>
`;

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
  vi.restoreAllMocks();
});

function rows(): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT id, query, present, sources, serp_top, fetch_status, captured_at
       FROM ai_overview_tracking ORDER BY id`,
    )
    .all() as Array<Record<string, unknown>>;
}

describe("ai_overview_track persists a snapshot", () => {
  it("writes presence as 1, the cited sources and the organic results as JSON, and returns the row id", async () => {
    vi.mocked(stealthFetch).mockResolvedValueOnce({
      content: SERP_WITH_OVERVIEW,
      finalUrl: "https://www.google.com/search",
      solved: false,
    });

    const out = JSON.parse(
      await aiOverviewTrackTool.execute({ query: "synthetic query" }),
    );

    const written = rows();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      query: "synthetic query",
      present: 1,
      fetch_status: "ok",
    });
    expect(JSON.parse(written[0].sources as string)).toEqual([
      {
        url: "https://source-a.example/article",
        title: "Source A article",
        rank: 1,
      },
    ]);
    expect(JSON.parse(written[0].serp_top as string)).toEqual(
      expect.arrayContaining([
        { url: "https://organic.example/page", title: "Organic page" },
      ]),
    );
    expect(written[0].captured_at).toEqual(expect.any(String));
    expect(out.snapshot_id).toBe(written[0].id);
  });

  it("writes presence as 0 with the blocked status when the page is an anti-bot interstitial", async () => {
    vi.mocked(stealthFetch).mockResolvedValueOnce({
      content: "<p>Our systems have detected unusual traffic</p>",
      finalUrl: "https://www.google.com/sorry",
      solved: false,
    });

    const out = JSON.parse(
      await aiOverviewTrackTool.execute({ query: "blocked query" }),
    );

    expect(out.fetch_status).toBe("blocked");
    const written = rows();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      query: "blocked query",
      present: 0,
      fetch_status: "blocked",
      sources: "[]",
      serp_top: "[]",
    });
  });
});
