import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseMentions, mentionsUrl } from "./read.js";

/** A minimal X activity-stream notifications body (the shape verified live). */
const sample = JSON.stringify({
  globalObjects: {
    tweets: {
      "1500000000000000002": {
        id_str: "1500000000000000002",
        full_text: "@iooking4ward great thread!",
        user_id_str: "11",
        created_at: "Tue Jun 23 06:00:00 +0000 2026",
      },
      "1500000000000000001": {
        id_str: "1500000000000000001",
        full_text: "hey @iooking4ward what do you think?",
        user_id_str: "22",
        created_at: "Tue Jun 23 05:00:00 +0000 2026",
        in_reply_to_status_id_str: "1499999999999999999",
      },
    },
    users: {
      "11": { id_str: "11", screen_name: "alice", name: "Alice A." },
      "22": { id_str: "22", screen_name: "bob", name: "Bob B." },
    },
  },
});

describe("parseMentions", () => {
  it("flattens tweets+users into mentions, newest first", () => {
    const m = parseMentions(sample);
    expect(m).toHaveLength(2);
    expect(m[0].tweetId).toBe("1500000000000000002"); // newest first
    expect(m[0].author).toBe("alice");
    expect(m[0].authorName).toBe("Alice A.");
    expect(m[0].text).toBe("@iooking4ward great thread!");
    expect(m[1].tweetId).toBe("1500000000000000001");
    expect(m[1].inReplyToTweetId).toBe("1499999999999999999");
    expect(m[0].inReplyToTweetId).toBeUndefined();
  });

  it("orders by numeric id even across id lengths (length-then-lex, not naive lex)", () => {
    const raw = JSON.stringify({
      globalObjects: {
        tweets: {
          a: { id_str: "999", user_id_str: "1", full_text: "older" },
          b: { id_str: "1000", user_id_str: "1", full_text: "newer" },
        },
        users: { "1": { screen_name: "u", name: "U" } },
      },
    });
    expect(parseMentions(raw).map((m) => m.tweetId)).toEqual(["1000", "999"]);
  });

  it("falls back to `text` when `full_text` is absent, and tolerates a missing user", () => {
    const raw = JSON.stringify({
      globalObjects: {
        tweets: { x: { id_str: "5", text: "legacy text", user_id_str: "404" } },
        users: {},
      },
    });
    const m = parseMentions(raw);
    expect(m[0].text).toBe("legacy text");
    expect(m[0].author).toBe(""); // unknown user → empty, not a throw
  });

  it("returns [] for empty / non-JSON / shapeless bodies (never throws)", () => {
    expect(parseMentions("")).toEqual([]);
    expect(parseMentions("<html>")).toEqual([]);
    expect(parseMentions("{}")).toEqual([]);
    expect(parseMentions(JSON.stringify({ globalObjects: {} }))).toEqual([]);
  });

  it("skips tweet entries without an id_str", () => {
    const raw = JSON.stringify({
      globalObjects: {
        tweets: {
          bad: { user_id_str: "1" },
          good: { id_str: "7", user_id_str: "1" },
        },
        users: { "1": { screen_name: "u", name: "U" } },
      },
    });
    expect(parseMentions(raw).map((m) => m.tweetId)).toEqual(["7"]);
  });
});

describe("mentionsUrl (via X_MENTIONS_URL override)", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.X_MENTIONS_URL;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.X_MENTIONS_URL;
    else process.env.X_MENTIONS_URL = saved;
  });

  it("defaults to the notifications/mentions endpoint with the count param", () => {
    delete process.env.X_MENTIONS_URL;
    const u = mentionsUrl(25);
    expect(u).toContain("/2/notifications/mentions.json");
    expect(u).toContain("count=25");
  });

  it("honors X_MENTIONS_URL at call time (X's next move = config change)", () => {
    process.env.X_MENTIONS_URL = "https://example.test/m.json";
    expect(mentionsUrl(5)).toBe("https://example.test/m.json?count=5");
  });
});
