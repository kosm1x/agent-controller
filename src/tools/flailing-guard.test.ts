import { describe, it, expect, beforeEach } from "vitest";
import {
  extractTokens,
  checkFlailing,
  recordCall,
  buildFlailingBlockMessage,
  isInRitualContext,
  ritualContext,
  _resetFlailingGuard,
  isReadOnlyDiagnostic,
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

  describe("ritualContext exemption", () => {
    it("isInRitualContext is false outside ritualContext.run", () => {
      expect(isInRitualContext()).toBe(false);
    });

    it("isInRitualContext is true inside ritualContext.run", () => {
      ritualContext.run({ ritualId: "evolution-log" }, () => {
        expect(isInRitualContext()).toBe(true);
      });
    });

    it("checkFlailing returns null inside ritual context even when history is loaded", () => {
      const t0 = 1_000_000;
      recordCall("node /tmp/tweet4_v1.cjs", 1, t0);
      recordCall("node /tmp/tweet4_v2.cjs", 1, t0 + 1000);
      recordCall("node /tmp/tweet4_v3.cjs", 1, t0 + 2000);
      // Outside context: would block
      expect(
        checkFlailing("node /tmp/tweet4_v4.cjs", t0 + 3000),
      ).not.toBeNull();
      // Inside context: never blocks
      ritualContext.run({ ritualId: "evolution-log" }, () => {
        expect(checkFlailing("node /tmp/tweet4_v4.cjs", t0 + 3000)).toBeNull();
      });
    });

    it("recordCall is a no-op inside ritual context (buffer not polluted by failing ritual calls)", () => {
      const t0 = 1_000_000;
      // Many ritual-time SELECT calls THAT FAIL — must NOT enter the buffer.
      // exitCode=1 is the realistic case: a flaky memory_reflect or transient
      // SQLite lock fails inside the ritual. Without the exemption, 3+ of these
      // would trip strikes on the next non-ritual SELECT in the 5-min window.
      ritualContext.run({ ritualId: "evolution-log" }, () => {
        for (let i = 0; i < 5; i++) {
          recordCall(
            `./mc-ctl db "SELECT * FROM ritual_table_${i}"`,
            1,
            t0 + 100 + i,
          );
        }
      });
      // After ritual: a non-ritual SELECT must not collide with the 5 ritual
      // SELECTs because they were never recorded. (If the no-op were removed,
      // this would return non-null because "select" would have 5 strikes.)
      const result = checkFlailing(
        './mc-ctl db "SELECT * FROM something_else"',
        t0 + 2000,
      );
      expect(result).toBeNull();
    });

    it("ritualContext.run isolates per-call (no leakage after return)", () => {
      ritualContext.run({ ritualId: "evolution-log" }, () => {
        expect(isInRitualContext()).toBe(true);
      });
      expect(isInRitualContext()).toBe(false);
    });

    it("propagates context through await boundaries (async work)", async () => {
      const result = await ritualContext.run(
        { ritualId: "evolution-log" },
        async () => {
          await Promise.resolve();
          await new Promise((r) => setTimeout(r, 1));
          return isInRitualContext();
        },
      );
      expect(result).toBe(true);
    });

    it("propagates context to fire-and-forget async work (no await)", async () => {
      // Mirrors the dispatcher.ts dispatchTask(...).catch(...) pattern: spawn
      // an async chain inside ritualContext.run without awaiting it, then
      // check that the chain saw the context.
      let sawRitualContext = false;
      ritualContext.run({ ritualId: "evolution-log" }, () => {
        void Promise.resolve().then(() => {
          sawRitualContext = isInRitualContext();
        });
      });
      await new Promise((r) => setTimeout(r, 5));
      expect(sawRitualContext).toBe(true);
      // And the outer context is clean afterward.
      expect(isInRitualContext()).toBe(false);
    });

    it("unwinds on throw (no leak when the wrapped callback rejects)", () => {
      expect(() =>
        ritualContext.run({ ritualId: "evolution-log" }, () => {
          throw new Error("simulated runner failure");
        }),
      ).toThrow("simulated runner failure");
      expect(isInRitualContext()).toBe(false);
    });

    it("documented inheritance: nested ritualContext.run preserves the outer scope after the inner unwinds", () => {
      ritualContext.run({ ritualId: "outer" }, () => {
        expect(ritualContext.getStore()?.ritualId).toBe("outer");
        ritualContext.run({ ritualId: "inner" }, () => {
          expect(ritualContext.getStore()?.ritualId).toBe("inner");
        });
        expect(ritualContext.getStore()?.ritualId).toBe("outer");
      });
      expect(isInRitualContext()).toBe(false);
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

describe("read-only diagnostic exemption (Phase 4, ant-colony incident)", () => {
  beforeEach(() => {
    _resetFlailingGuard();
  });

  /** Three failed curls sharing the "colony" token — the incident setup. */
  function strikeColony(): void {
    recordCall("curl -sI https://ant-colony.187.77.25.101.nip.io", 35);
    recordCall(
      "curl -v https://ant-colony.187.77.25.101.nip.io/index.html",
      35,
    );
    recordCall("curl --insecure https://ant-colony.187.77.25.101.nip.io", 35);
  }

  it("allows a novel journalctl diagnostic after 3 strikes on its token", () => {
    strikeColony();
    // Sanity: enforcement is live for non-diagnostics.
    expect(
      checkFlailing("curl https://ant-colony.187.77.25.101.nip.io"),
    ).not.toBeNull();
    // The exact command class the guard blocked on 2026-08-23.
    expect(
      checkFlailing("journalctl -u caddy | grep -i ant-colony"),
    ).toBeNull();
    expect(checkFlailing("systemctl status ant-colony")).toBeNull();
    expect(
      checkFlailing("grep ant-colony /etc/caddy/previews-generated.caddy"),
    ).toBeNull();
  });

  it("keeps enforcing network mutators — the original flailing class", () => {
    strikeColony();
    expect(
      checkFlailing("curl -X POST https://ant-colony.187.77.25.101.nip.io"),
    ).not.toBeNull();
    expect(
      checkFlailing("wget https://ant-colony.187.77.25.101.nip.io"),
    ).not.toBeNull();
    expect(checkFlailing("node /tmp/ant-colony-probe.cjs")).not.toBeNull();
  });

  it("a redirect to a real file disqualifies the exemption", () => {
    strikeColony();
    expect(
      checkFlailing("journalctl -u caddy | grep ant-colony > /tmp/out.txt"),
    ).not.toBeNull();
  });

  it("harmless redirects (/dev/null, 2>&1) keep the exemption", () => {
    strikeColony();
    expect(
      checkFlailing("journalctl -u caddy 2>&1 | grep ant-colony"),
    ).toBeNull();
    expect(
      checkFlailing("grep ant-colony /var/log/caddy/access.log 2>/dev/null"),
    ).toBeNull();
  });

  it("every segment of a compound must be diagnostic", () => {
    strikeColony();
    expect(
      checkFlailing("journalctl -u caddy && rm -rf /tmp/ant-colony"),
    ).not.toBeNull();
    expect(
      checkFlailing("systemctl restart caddy && journalctl -u ant-colony"),
    ).not.toBeNull();
  });

  it("diagnostic failures still record strikes for later write-class calls", () => {
    recordCall("grep ant-colony /var/log/caddy/access.log", 1);
    recordCall("grep ant-colony /var/log/syslog", 1);
    recordCall("journalctl -u caddy | grep ant-colony", 1);
    expect(checkFlailing("node /tmp/fix-ant-colony.cjs")).not.toBeNull();
  });

  describe("isReadOnlyDiagnostic table", () => {
    const rows: Array<[string, boolean]> = [
      ["journalctl -u mission-control --since '5 min ago'", true],
      ["sudo journalctl -u caddy", true],
      ["timeout 30 journalctl -f -u caddy", true],
      ["FOO=bar journalctl -u caddy", true],
      ["/usr/bin/journalctl -u caddy", true],
      ["systemctl status caddy", true],
      ["systemctl is-active preview-caddy-sync.path", true],
      ["systemctl cat caddy", true],
      ["systemctl restart caddy", false],
      ["systemctl stop caddy", false],
      ["caddy validate --config /etc/caddy/Caddyfile", true],
      ["caddy reload", false],
      ["docker logs crm-hindsight", true],
      ["docker restart crm-hindsight", false],
      ["git log --oneline -5", true],
      ["git push origin main", false],
      ["ss -tlnp", true],
      ["dig ant-colony.187.77.25.101.nip.io", true],
      ["curl -sI https://example.com", false],
      ["wget https://example.com", false],
      ["rm -rf /tmp/x", false],
      ["sed -i 's/a/b/' file.txt", false],
      ["sqlite3 data/mc.db 'SELECT 1'", false],
      ["echo hi", false],
      ["", false],
      ["awk '{print}' f.txt > out.txt", false],
      ["cat f.txt | grep x | wc -l", true],
      // R1 audit C2 — the rows that defeated the first grammar:
      ["journalctl -u caddy\ncurl -X POST https://x.com", false],
      ["env curl -sI https://x.com", false],
      ["find /tmp/ant-colony -delete", false],
      ["find . -name '*.log' -exec rm {} +", false],
      ["find /var/log -name '*.log' -mtime -1", true],
      ["git branch -D feature/x", false],
      ["git branch", false],
      ["ip link set eth0 down", false],
      ["ip addr show", false],
      ["date -s '2020-01-01'", false],
      ["grep x `cat list`", false],
      ["grep x $(cat list)", false],
      ["systemctl --no-pager status caddy", false], // flag before subcommand — strict
      ["journalctl -u caddy;", true], // trailing separator, empty segment
      // R2 audit C1 — `&` (background) is a top-level separator too:
      ["journalctl -u caddy & curl -X POST https://x.com", false],
      ["grep foo f & wget https://x.com", false],
      ["journalctl -u caddy &", true],
      // R2 audit W3 — listed binaries in mutating modes:
      ["journalctl --vacuum-time=1d", false],
      ["journalctl --rotate", false],
      ["dmesg --clear", false],
      ["dmesg -C", false],
      ["sort -o /etc/passwd f", false],
      ["sort --output=/tmp/pwned f", false],
      ["sort f.txt", false], // dropped R3 C1 — has a write mode (-o)
      ["uniq /tmp/in /tmp/out", false],
      ["uniq /tmp/in", false], // dropped R3 C1 — has a write mode (IN OUT)
      ["ss -K dst 1.2.3.4", false],
      ["git diff --output=/tmp/x", false],
      // R3 audit C1 — bundled short flags and write/exec-mode binaries:
      ["sort -uo victim.txt in.txt", false],
      ["dmesg -Cw", false],
      ["dmesg -w", true],
      ["ss -Kn", false],
      ["rg --pre /bin/rm doomed target", false],
      ["rg TODO src/", false],
      ["xxd file.bin", false],
      ["xxd -r dump.hex out.bin", false],
      ["hostname evil-name", false],
      ["hostname", false],
      ["file -C -m magic", false],
      ["git log --output=/tmp/x -3", false],
      // R4 audit C1 — journalctl is allow-by-membership now; the three
      // R4 escapes plus an unknown-future-flag canary:
      ["journalctl -n 1 --cursor-file=/tmp/cur", false],
      ["journalctl --update-catalog", false],
      ["journalctl --smart-relinquish-var", false],
      ["journalctl --some-future-flag", false],
      ["journalctl -u caddy --since '5 min ago' -o json --no-pager", true],
      ["journalctl -xeu caddy", true],
      ["journalctl --disk-usage", true],
      ["journalctl -f -u mission-control", true],
    ];
    for (const [cmd, expected] of rows) {
      it(`${JSON.stringify(cmd)} → ${expected}`, () => {
        expect(isReadOnlyDiagnostic(cmd)).toBe(expected);
      });
    }
  });
});
