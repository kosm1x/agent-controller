import { describe, it, expect, beforeEach } from "vitest";
import {
  extractTokens,
  checkFlailing,
  recordCall,
  buildFlailingBlockMessage,
  _resetFlailingGuard,
} from "./flailing-guard.js";

describe("flailing-guard", () => {
  beforeEach(() => {
    _resetFlailingGuard();
  });

  describe("extractTokens", () => {
    it("returns significant alphanumeric tokens, lowercased", () => {
      const tokens = extractTokens("node /tmp/tweet4_final.cjs && echo done");
      expect(tokens.has("tweet4_final")).toBe(true);
    });

    it("filters tokens shorter than the minimum length", () => {
      const tokens = extractTokens("ls -la /tmp");
      expect(tokens.has("ls")).toBe(false);
      expect(tokens.has("la")).toBe(false);
      expect(tokens.has("tmp")).toBe(false);
    });

    it("filters stopword tokens regardless of length", () => {
      const tokens = extractTokens(
        "node /root/claude/mission-control/scripts/build.sh",
      );
      // 'mission' and 'control' are stopwords even though they pass length
      expect(tokens.has("mission")).toBe(false);
      expect(tokens.has("control")).toBe(false);
      expect(tokens.has("claude")).toBe(false);
      expect(tokens.has("scripts")).toBe(false);
      expect(tokens.has("node")).toBe(false);
    });

    it("filters pure-numeric tokens (ports, timestamps)", () => {
      const tokens = extractTokens("curl http://localhost:123456/health");
      expect(tokens.has("123456")).toBe(false);
      // 'localhost' is not in the stopword list and is >= 6 chars
      expect(tokens.has("localhost")).toBe(true);
    });
  });

  describe("checkFlailing", () => {
    it("returns null when history is empty", () => {
      expect(checkFlailing("node /tmp/foo.cjs")).toBeNull();
    });

    it("blocks the 4th attempt after 3 failed prior calls sharing a token", () => {
      const t0 = 1_000_000;
      recordCall("node /tmp/tweet4_final.cjs", 1, t0);
      recordCall("node /tmp/tweet4_v2.cjs", 1, t0 + 1000);
      recordCall("node /tmp/tweet4_login.cjs", 1, t0 + 2000);
      const result = checkFlailing("node /tmp/tweet4_v3.cjs", t0 + 3000);
      expect(result).not.toBeNull();
      // The offending token will be a prefix shared across variants
      // (e.g. "tweet4") rather than any one full filename.
      expect(result!.token).toMatch(/^tweet4/);
      expect(result!.strikes).toBeGreaterThanOrEqual(3);
    });

    it("does NOT block when prior calls succeeded", () => {
      const t0 = 1_000_000;
      recordCall("node /tmp/tweet4_v1.cjs", 0, t0);
      recordCall("node /tmp/tweet4_v2.cjs", 0, t0 + 1000);
      recordCall("node /tmp/tweet4_v3.cjs", 0, t0 + 2000);
      const result = checkFlailing("node /tmp/tweet4_v4.cjs", t0 + 3000);
      expect(result).toBeNull();
    });

    it("does NOT block when prior failures share no significant token", () => {
      const t0 = 1_000_000;
      recordCall("foobar --flag=alpha", 1, t0);
      recordCall("bazquux --flag=beta", 1, t0 + 1000);
      recordCall("xyzzyz --flag=gamma", 1, t0 + 2000);
      const result = checkFlailing("unrelated_command", t0 + 3000);
      expect(result).toBeNull();
    });

    it("does NOT block when prior failures fall outside the 5-min window", () => {
      const t0 = 1_000_000;
      recordCall("node /tmp/tweet4_v1.cjs", 1, t0);
      recordCall("node /tmp/tweet4_v2.cjs", 1, t0 + 1000);
      recordCall("node /tmp/tweet4_v3.cjs", 1, t0 + 2000);
      // 6 minutes later — window has expired
      const result = checkFlailing(
        "node /tmp/tweet4_v4.cjs",
        t0 + 6 * 60 * 1000,
      );
      expect(result).toBeNull();
    });

    it("does NOT block when only 2 prior failures share a token (under limit)", () => {
      const t0 = 1_000_000;
      recordCall("node /tmp/tweet4_v1.cjs", 1, t0);
      recordCall("node /tmp/tweet4_v2.cjs", 1, t0 + 1000);
      const result = checkFlailing("node /tmp/tweet4_v3.cjs", t0 + 2000);
      expect(result).toBeNull();
    });

    it("counts only failed prior calls, ignores successful ones in between", () => {
      const t0 = 1_000_000;
      recordCall("node /tmp/tweet4_v1.cjs", 1, t0);
      recordCall("ls /tmp", 0, t0 + 500); // unrelated success
      recordCall("node /tmp/tweet4_v2.cjs", 1, t0 + 1000);
      recordCall("git status", 0, t0 + 1500); // unrelated success
      recordCall("node /tmp/tweet4_v3.cjs", 1, t0 + 2000);
      const result = checkFlailing("node /tmp/tweet4_v4.cjs", t0 + 3000);
      expect(result).not.toBeNull();
    });

    it("does NOT block on common-path tokens shared across unrelated tasks", () => {
      // Stopwords cover the obvious path noise: claude/mission/control/src/dist
      const t0 = 1_000_000;
      recordCall("npm run build", 1, t0);
      recordCall(
        "node /root/claude/mission-control/dist/index.js",
        1,
        t0 + 1000,
      );
      recordCall("tsx /root/claude/mission-control/src/foo.ts", 1, t0 + 2000);
      const result = checkFlailing("npm test", t0 + 3000);
      expect(result).toBeNull();
    });

    it("prunes the ring buffer to its size limit", () => {
      const t0 = 1_000_000;
      // Push 15 entries, all failing, all sharing a token
      for (let i = 0; i < 15; i++) {
        recordCall(`node /tmp/scriptname${i}_xyz.cjs`, 1, t0 + i * 100);
      }
      // Even with pruning, the most-recent 10 still contain enough strikes
      const result = checkFlailing(
        "node /tmp/scriptname999_xyz.cjs",
        t0 + 15 * 100,
      );
      // The shared token 'scriptname' will be there
      expect(result).not.toBeNull();
    });
  });

  describe("buildFlailingBlockMessage", () => {
    it("includes the offending token and strike count", () => {
      const msg = buildFlailingBlockMessage("tweet4_final", 3);
      expect(msg).toContain("tweet4_final");
      expect(msg).toContain("3");
      expect(msg).toContain("STOP");
      expect(msg.toLowerCase()).toContain("3-strike");
    });

    it("instructs the LLM to escalate to the user", () => {
      const msg = buildFlailingBlockMessage("foo", 4);
      // The message must steer toward "reply to user" not "try again"
      expect(msg.toLowerCase()).toMatch(/reply.*user|tell.*user|surface/);
    });
  });
});
