import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getXRouter, probeAllAccounts, XPostRouter } from "./index.js";
import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import { enterRunToolContext } from "../../tools/rule-of-two.js";
import { tweetProbeTool, tweetPostTool } from "../../tools/builtin/x-post.js";

const saved: Record<string, string | undefined> = {};
const X_KEYS = Object.keys(process.env).filter((k) => k.startsWith("X_"));

beforeEach(() => {
  for (const k of X_KEYS) saved[k] = process.env[k];
  for (const k of Object.keys(process.env))
    if (k.startsWith("X_")) delete process.env[k];
  process.env.X_AUTH_TOKEN__iooking4ward = "a";
  process.env.X_CT0__iooking4ward = "b";
  process.env.X_AUTH_TOKEN__mexiconecesario = "c";
  process.env.X_CT0__mexiconecesario = "d";
});

afterEach(() => {
  for (const k of Object.keys(process.env))
    if (k.startsWith("X_")) delete process.env[k];
  for (const [k, v] of Object.entries(saved))
    if (v !== undefined) process.env[k] = v;
});

describe("getXRouter", () => {
  it("returns a router for an EXACT configured handle", () => {
    expect(getXRouter("iooking4ward")).toBeInstanceOf(XPostRouter);
  });

  it("returns a router for a fuzzy near-miss (the l↔I typo class)", () => {
    // Was the prod failure: model passed 'lookin4ward' → must still route.
    expect(getXRouter("lookin4ward")).toBeInstanceOf(XPostRouter);
    expect(getXRouter("looking4ward")).toBeInstanceOf(XPostRouter);
  });

  it("returns null for a truly-unknown handle (so noAccountError lists the real accounts)", () => {
    expect(getXRouter("garbage")).toBeNull();
  });

  it("returns null when no accounts are configured", () => {
    for (const k of Object.keys(process.env))
      if (k.startsWith("X_")) delete process.env[k];
    expect(getXRouter("iooking4ward")).toBeNull();
    expect(getXRouter()).toBeNull();
  });
});

// S6 ruling 5b: tweet_probe with no `account` checks the task's project's
// accounts, not all configured ones. Synthetic handles; no network (probe stubbed).
describe("probe default scope = the task's project's accounts", () => {
  beforeEach(() => {
    for (const k of Object.keys(process.env)) if (k.startsWith("X_")) delete process.env[k];
    process.env.X_AUTH_TOKEN__acmenews = "tok-news-0123456789";
    process.env.X_CT0__acmenews = "ct0-news-0123456789";
    process.env.X_AUTH_TOKEN__acmedesk = "tok-desk-0123456789";
    process.env.X_CT0__acmedesk = "ct0-desk-0123456789";
    process.env.X_AUTH_TOKEN__acmebrand = "tok-brand-0123456789";
    process.env.X_CT0__acmebrand = "ct0-brand-0123456789";
    initDatabase(":memory:");
    const db = getDatabase();
    const p = db.prepare("INSERT INTO projects (id, slug, name, status, config) VALUES (?, ?, ?, 'active', ?)");
    const sec = (...hs: string[]) => hs.flatMap((h) => [`SECRET_X_AUTH_TOKEN__${h}`, `SECRET_X_CT0__${h}`]);
    p.run("p1", "acme-news", "News", JSON.stringify({ secrets: sec("ACMENEWS", "ACMEDESK") }));
    p.run("p2", "acme-brand", "Brand", JSON.stringify({ secrets: sec("ACMEBRAND") }));
    p.run("p3", "acme-plain", "Plain", "{}");
    const t = db.prepare("INSERT INTO tasks (task_id, title, description, project_slug) VALUES (?, 't', 'd', ?)");
    t.run("t-news", "acme-news");
    t.run("t-plain", "acme-plain");
    vi.spyOn(XPostRouter.prototype, "probe").mockResolvedValue({ healthy: true, unconfigured: false, results: [] });
    vi.spyOn(XPostRouter.prototype, "post").mockResolvedValue({ ok: true, backend: "cookie", tweetId: "1", attempts: [] } as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    closeDatabase();
    vi.restoreAllMocks();
  });

  it("probeAllAccounts inside a run probes only the run's project's accounts", async () => {
    const r = await enterRunToolContext("t-news", () => probeAllAccounts());
    expect(r.map((a) => a.account)).toEqual(["acmedesk", "acmenews"]);
    // Outside a run (the probe cron): every configured account.
    expect((await probeAllAccounts()).map((a) => a.account)).toEqual(["acmebrand", "acmedesk", "acmenews"]);
  });

  it("tweet_probe with no account: the task's project's accounts; another project's account is refused", async () => {
    const all = JSON.parse(await enterRunToolContext("t-news", () => tweetProbeTool.execute({})));
    expect(all.accounts.map((a: { account: string }) => a.account)).toEqual(["acmedesk", "acmenews"]);
    const other = JSON.parse(await enterRunToolContext("t-news", () => tweetProbeTool.execute({ account: "acmebrand" })));
    expect(other.healthy).toBe(false);
    expect(other.error).toContain('Unknown X account "acmebrand"');
    expect(other.error).toContain("acmedesk, acmenews");
  });

  it("a project with no declared account: probe and post say so, naming no handle", async () => {
    const probe = JSON.parse(await enterRunToolContext("t-plain", () => tweetProbeTool.execute({})));
    expect(probe.healthy).toBe(false);
    expect(probe.error).toContain("No X account is reachable for this task's project (acme-plain)");
    const post = JSON.parse(await enterRunToolContext("t-plain", () => tweetPostTool.execute({ text: "hola", account: "acmenews" })));
    expect(post.error).toContain("acme-plain");
    expect(post.error).not.toMatch(/acmenews|acmedesk|acmebrand/);
  });

  it("tweet_post reaches its own project's account", async () => {
    const r = JSON.parse(await enterRunToolContext("t-news", () => tweetPostTool.execute({ text: "hola", account: "acmenews" })));
    expect(r).toMatchObject({ ok: true, account: "acmenews" });
  });
});
