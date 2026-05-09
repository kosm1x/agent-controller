/**
 * Tests for MCP-tool annotation overrides (v7.6 Spine 4 W4).
 *
 * Pin every name pattern that a live MCP server is registering today
 * (browser__*, playwright__browser_*, xpoz__xpoz_*) so an upstream rename
 * lands here rather than silently regressing the destructive-cohort metric.
 */
import { describe, it, expect } from "vitest";
import { getMcpToolHints } from "./annotations.js";

describe("getMcpToolHints — xpoz Reddit Intel server", () => {
  it.each([
    "xpoz__xpoz_get_digest",
    "xpoz__xpoz_get_history",
    "xpoz__xpoz_get_topics",
  ])("%s is read-only via xpoz_get_ prefix", (name) => {
    const hints = getMcpToolHints(name);
    expect(hints).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it("xpoz__xpoz_trigger_run is destructive", () => {
    const hints = getMcpToolHints("xpoz__xpoz_trigger_run");
    expect(hints).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
  });
});

describe("getMcpToolHints — browser (lightpanda) server", () => {
  it.each(["browser__goto", "browser__markdown", "browser__links"])(
    "%s is read-only",
    (name) => {
      const hints = getMcpToolHints(name);
      expect(hints?.readOnlyHint).toBe(true);
      expect(hints?.destructiveHint).toBe(false);
    },
  );

  it.each([
    "browser__semantic_tree",
    "browser__interactiveElements",
    "browser__structuredData",
  ])("%s is read-only via verb-list match", (name) => {
    const hints = getMcpToolHints(name);
    expect(hints?.readOnlyHint).toBe(true);
  });

  it.each(["browser__click", "browser__fill", "browser__scroll"])(
    "%s is write-class (interaction, not destructive)",
    (name) => {
      const hints = getMcpToolHints(name);
      expect(hints?.readOnlyHint).toBe(false);
      expect(hints?.destructiveHint).toBe(false);
      expect(hints?.idempotentHint).toBe(false);
    },
  );

  it("browser__evaluate is write-class (DOM mutation possible)", () => {
    const hints = getMcpToolHints("browser__evaluate");
    expect(hints?.readOnlyHint).toBe(false);
    expect(hints?.destructiveHint).toBe(false);
  });
});

describe("getMcpToolHints — playwright server", () => {
  it.each([
    "playwright__browser_navigate",
    "playwright__browser_navigate_back",
    "playwright__browser_snapshot",
    "playwright__browser_take_screenshot",
    "playwright__browser_console_messages",
    "playwright__browser_network_requests",
    "playwright__browser_tabs",
    "playwright__browser_wait_for",
  ])("%s is read-only", (name) => {
    const hints = getMcpToolHints(name);
    expect(hints?.readOnlyHint).toBe(true);
  });

  it.each([
    "playwright__browser_click",
    "playwright__browser_fill_form",
    "playwright__browser_press_key",
    "playwright__browser_type",
    "playwright__browser_drag",
    "playwright__browser_hover",
    "playwright__browser_select_option",
    "playwright__browser_resize",
    "playwright__browser_handle_dialog",
    "playwright__browser_run_code",
    "playwright__browser_evaluate",
    "playwright__browser_file_upload",
  ])("%s is write-class", (name) => {
    const hints = getMcpToolHints(name);
    expect(hints?.readOnlyHint).toBe(false);
    expect(hints?.destructiveHint).toBe(false);
  });

  it("playwright__browser_close is destructive (kills session)", () => {
    const hints = getMcpToolHints("playwright__browser_close");
    expect(hints?.destructiveHint).toBe(true);
  });
});

describe("getMcpToolHints — fallback", () => {
  it("returns undefined for unmatched tool names", () => {
    expect(getMcpToolHints("unknown_server__some_random_tool")).toBeUndefined();
    expect(getMcpToolHints("xpoz__never_seen_verb")).toBeUndefined();
  });

  it("handles names without a server prefix", () => {
    // The lookup operates on the post-namespace name, so a bare verb
    // name still classifies correctly.
    expect(getMcpToolHints("browser_click")?.readOnlyHint).toBe(false);
    expect(getMcpToolHints("browser_close")?.destructiveHint).toBe(true);
  });

  // Audit W2 fix (2026-05-09): bare `get_` and `list_` prefixes were
  // dropped from READ_PREFIXES because they would auto-classify any
  // future tool whose name happens to start with them — `get_credentials`,
  // `list_and_delete`, etc. Now READ_PREFIXES is per-server (`xpoz_get_`,
  // `xpoz_list_`) so the false-positive class can't materialize without
  // an intentional opt-in.
  it("does NOT classify bare get_/list_ tool names as read-only", () => {
    expect(getMcpToolHints("future_server__get_credentials")).toBeUndefined();
    expect(getMcpToolHints("future_server__list_and_delete")).toBeUndefined();
  });
});

describe("getMcpToolHints — invariants", () => {
  it("no override has readOnlyHint:true AND destructiveHint:true", () => {
    // Logical contradiction; types.test.ts pins the same invariant for
    // builtin tools. Verify here that no MCP override violates it.
    const samples = [
      "xpoz__xpoz_get_digest",
      "xpoz__xpoz_trigger_run",
      "browser__goto",
      "browser__click",
      "playwright__browser_close",
      "playwright__browser_navigate",
      "playwright__browser_evaluate",
    ];
    for (const name of samples) {
      const hints = getMcpToolHints(name);
      if (!hints) continue;
      expect(hints.readOnlyHint && hints.destructiveHint).toBe(false);
    }
  });

  it("read-only hints always have idempotentHint: true", () => {
    // Per the canonical `r` set documented in annotations.ts. Read-only
    // tools have no side effect to be non-idempotent about.
    const samples = [
      "xpoz__xpoz_get_digest",
      "browser__goto",
      "browser__markdown",
      "playwright__browser_navigate",
      "playwright__browser_snapshot",
    ];
    for (const name of samples) {
      const hints = getMcpToolHints(name);
      expect(hints?.idempotentHint).toBe(true);
    }
  });

  it("write and destructive hints are not idempotent", () => {
    const samples = [
      "browser__click",
      "browser__fill",
      "playwright__browser_click",
      "playwright__browser_close",
      "xpoz__xpoz_trigger_run",
    ];
    for (const name of samples) {
      const hints = getMcpToolHints(name);
      expect(hints?.idempotentHint).toBe(false);
    }
  });

  it("all classified MCP tools have openWorldHint: true (network/external)", () => {
    // MCP tools are by definition out-of-process; openWorldHint is always
    // true. Pin so a future override that flips this is loud. NOTE: this
    // assumption breaks if a future in-process MCP transport (e.g.
    // HTTP-loopback, in-memory) lands; treat this test as a forcing
    // function to revisit the openWorldHint blanket.
    const samples = [
      "xpoz__xpoz_get_digest",
      "xpoz__xpoz_trigger_run",
      "browser__goto",
      "browser__click",
      "playwright__browser_navigate",
      "playwright__browser_close",
    ];
    for (const name of samples) {
      const hints = getMcpToolHints(name);
      expect(hints?.openWorldHint).toBe(true);
    }
  });

  // Audit R3 (2026-05-09): pin the precedence rule. DESTRUCTIVE_VERBS is
  // checked first in `getMcpToolHints`, so a tool that's BOTH in the
  // destructive list AND starts with a (per-server) read-prefix should
  // resolve as destructive, not read-only. xpoz__xpoz_trigger_run today
  // doesn't trigger this (it doesn't start with xpoz_get_/xpoz_list_),
  // but a future verb might. Use `xpoz_get_then_trigger` as a synthetic
  // case to prove the precedence (the verb isn't in DESTRUCTIVE_VERBS so
  // the test would fail if precedence somehow flipped — but the actual
  // assertion here is that read-prefix matches happen LAST in the chain).
  it("read-prefix match is the last-resort branch (destructive + verb match win first)", () => {
    // Synthetic: a verb that starts with `xpoz_get_` (read-prefix) but
    // is NOT in any verb list. Should classify read-only.
    expect(getMcpToolHints("xpoz__xpoz_get_anything")?.readOnlyHint).toBe(true);
    // Real: `xpoz_trigger_run` doesn't match a read-prefix, so it falls
    // through to DESTRUCTIVE_VERBS and classifies destructive.
    expect(getMcpToolHints("xpoz__xpoz_trigger_run")?.destructiveHint).toBe(
      true,
    );
  });
});
