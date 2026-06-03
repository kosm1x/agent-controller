/**
 * V8.2 Phase 5 — strategic-voice prompt module tests.
 *
 * Covers the loader (real-file load, memoization, fail-loud), the identity
 * guard on the canonical principle block (catches accidental edits to
 * identity-load-bearing text), the §9 [K]-marker producer-contract guard, and
 * the user-prompt composition helper. The cross-call cache-prefix invariant
 * (every V8.2 call shares this systemPrompt) is tested in decompose.test.ts and
 * multi-option.test.ts where those call sites are driven.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STRATEGIC_VOICE_PRINCIPLE_ID,
  principleFilePath,
  loadStrategicVoicePrinciple,
  strategicVoiceSystemPrompt,
  composeV82UserPrompt,
  JUDGMENT_CITATION_CONTRACT_V1,
  __resetStrategicVoiceCacheForTest,
} from "./strategic-voice.js";

let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env.MC_PROMPT_MODULES_DIR;
  __resetStrategicVoiceCacheForTest();
});

afterEach(() => {
  // Restore env + clear the memo so a leaked bogus/temp dir can't poison the
  // real-file tests that follow.
  if (savedEnv === undefined) delete process.env.MC_PROMPT_MODULES_DIR;
  else process.env.MC_PROMPT_MODULES_DIR = savedEnv;
  __resetStrategicVoiceCacheForTest();
});

describe("strategic-voice — id + path", () => {
  it("id is the file stem and path points at the versioned .md", () => {
    expect(STRATEGIC_VOICE_PRINCIPLE_ID).toBe("strategic_voice_principle_v1");
    expect(
      principleFilePath().endsWith("strategic_voice_principle_v1.md"),
    ).toBe(true);
  });

  it("honors MC_PROMPT_MODULES_DIR override in the resolved path", () => {
    process.env.MC_PROMPT_MODULES_DIR = "/tmp/some-fixture-dir";
    expect(principleFilePath()).toBe(
      "/tmp/some-fixture-dir/strategic_voice_principle_v1.md",
    );
  });
});

describe("strategic-voice — canonical identity block (verbatim guard)", () => {
  it("loads the 7-principle identity block from the real file", () => {
    const p = loadStrategicVoicePrinciple();
    expect(p).toContain("# Strategic-voice principles");
    expect(p).toContain("You are Jarvis, a strategic counsel.");
    expect(p).toContain("You are NOT an executor; the operator decides.");
    // All 7 numbered principles present (drop/edit guard — identity-load-bearing).
    expect(p).toMatch(
      /1\. Be diplomatically honest, not dishonestly diplomatic\./,
    );
    expect(p).toMatch(/2\. The strength of an argument is not justification/);
    expect(p).toMatch(
      /3\. Pushback WITHOUT evidence does not change your analysis\./,
    );
    expect(p).toMatch(/4\. Pushback WITH evidence is the operator giving you/);
    expect(p).toMatch(/5\. Confidence comes from evidence/);
    expect(p).toMatch(/6\. You are a partner, not a service\./);
    expect(p).toMatch(/7\. Your edge is the protocol, not raw capability\./);
    expect(p).toContain("Process > capability (Kasparov).");
  });

  it("byte-pins the active principle (any edit ⇒ deliberate version bump, not an accident)", () => {
    // The principle file is BOTH the SDK cache key (a 1-byte drift fragments the
    // intra-brief cache) AND Jarvis's load-bearing identity. A change must be a
    // deliberate `..._vN.md` + new id + this pin + a sycophancy-probe baseline
    // re-run (§10) — never a silent edit. Substring checks above give a readable
    // failure; this SHA is the byte-exact gate.
    const sha = createHash("sha256")
      .update(loadStrategicVoicePrinciple())
      .digest("hex");
    expect(sha).toBe(
      "e3075d83ba234de36a46ca0a98912d9397fc1ce1ebccfcdf8137fc799ddd11c4",
    );
  });

  it("strategicVoiceSystemPrompt() returns the loaded principle (the shared cache prefix)", () => {
    expect(strategicVoiceSystemPrompt()).toBe(loadStrategicVoicePrinciple());
  });
});

describe("strategic-voice — loader behavior", () => {
  it("memoizes: a second load does not re-read (still returns cached after the dir is broken)", () => {
    const first = loadStrategicVoicePrinciple();
    // Point at a nonexistent dir WITHOUT resetting — a re-read would throw.
    process.env.MC_PROMPT_MODULES_DIR = "/nonexistent/strategic-voice/xyz";
    const second = loadStrategicVoicePrinciple();
    expect(second).toBe(first);
  });

  it("fails LOUD when the principle file is missing", () => {
    __resetStrategicVoiceCacheForTest();
    process.env.MC_PROMPT_MODULES_DIR = "/nonexistent/strategic-voice/xyz";
    expect(() => loadStrategicVoicePrinciple()).toThrow(
      /cannot read principle file/,
    );
  });

  it("fails LOUD when the principle file is empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "sv-empty-"));
    writeFileSync(
      join(dir, `${STRATEGIC_VOICE_PRINCIPLE_ID}.md`),
      "   \n\n  \n",
      "utf8",
    );
    __resetStrategicVoiceCacheForTest();
    process.env.MC_PROMPT_MODULES_DIR = dir;
    expect(() => loadStrategicVoicePrinciple()).toThrow(/is empty/);
  });
});

describe("strategic-voice — composeV82UserPrompt", () => {
  it("puts role instructions before the body, separated", () => {
    expect(composeV82UserPrompt("ROLE", "BODY")).toBe("ROLE\n\n---\n\nBODY");
  });

  it("returns the body unchanged when role is empty or whitespace", () => {
    expect(composeV82UserPrompt("", "BODY")).toBe("BODY");
    expect(composeV82UserPrompt("   \n ", "BODY")).toBe("BODY");
  });
});

describe("strategic-voice — §9 [K]-marker producer contract", () => {
  it("JUDGMENT_CITATION_CONTRACT_V1 encodes the resolved-path citation rule", () => {
    expect(JUDGMENT_CITATION_CONTRACT_V1).toContain("[K]");
    expect(JUDGMENT_CITATION_CONTRACT_V1).toMatch(/1-based ledger index/);
    expect(JUDGMENT_CITATION_CONTRACT_V1).toMatch(/NEVER invent/);
    expect(JUDGMENT_CITATION_CONTRACT_V1).toContain("CRITIC");
  });
});
