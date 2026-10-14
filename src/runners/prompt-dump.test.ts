import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

vi.mock("../lib/secret-refs.js", () => ({
  scrubSecrets: vi.fn((t: string) => t),
}));
vi.mock("../api/mcp-server/redact.js", () => ({
  redactCredentials: vi.fn((t: string) => t),
}));
vi.mock("../db/jarvis-fs.js", () => ({ getJarvisKbRoot: vi.fn() }));

import { scrubSecrets } from "../lib/secret-refs.js";
import { redactCredentials } from "../api/mcp-server/redact.js";
import { getJarvisKbRoot } from "../db/jarvis-fs.js";
import { dumpPrompt } from "./prompt-dump.js";

const scrub = vi.mocked(scrubSecrets);
const redact = vi.mocked(redactCredentials);
const kbRoot = vi.mocked(getJarvisKbRoot);

describe("dumpPrompt", () => {
  let root: string;
  let dir: string;

  beforeEach(() => {
    root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "prompt-dump-"));
    dir = join(root, "dumps");
    scrub.mockImplementation((t: string) => t);
    redact.mockImplementation((t) => t ?? "");
    kbRoot.mockReturnValue(join(root, "kb"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const messages = [
    { role: "system", content: "stable persona", cacheable: true },
    { role: "system", content: "variable bit", cacheable: false },
    { role: "user", content: "hola" },
  ] as const;

  function onlyFile(): string {
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    return readFileSync(join(dir, files[0]), "utf8");
  }

  it("writes one file: header + one block per message with chars = content length", () => {
    dumpPrompt(dir, "task-1", messages);
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{8}T\d{9}-task-1\.md$/);
    const text = onlyFile();
    expect(text).toMatch(
      /^# task task-1 \d{4}-\d{2}-\d{2}T[\d:.]+Z messages=3 chars=30\n/,
    );
    expect(text).toContain("## [0] role=system cacheable=true chars=14\n");
    expect(text).toContain("## [1] role=system cacheable=false chars=12\n");
    expect(text).toContain("## [2] role=user cacheable=unset chars=4\nhola");
    expect(text.match(/^## \[/gm)).toHaveLength(3);
  });

  it("content goes through scrubSecrets — the original value never lands on disk", () => {
    scrub.mockImplementation((t: string) =>
      t.replace(/SYNTH-SECRET-0001/g, "[redacted]"),
    );
    dumpPrompt(dir, "task-2", [
      { role: "user", content: "token SYNTH-SECRET-0001 here" },
    ]);
    const text = onlyFile();
    expect(text).not.toContain("SYNTH-SECRET-0001");
    expect(text).toContain("token [redacted] here");
  });

  it("each block passes scrubSecrets, then redactCredentials", () => {
    scrub.mockImplementation((t: string) => `${t}|scrub`);
    redact.mockImplementation((t) => `${t}|redact`);
    dumpPrompt(dir, "task-2b", [{ role: "user", content: "hola" }]);
    expect(onlyFile()).toContain("\nhola|scrub|redact");
    expect(scrub.mock.invocationCallOrder[0]).toBeLessThan(
      redact.mock.invocationCallOrder[0],
    );
  });

  it("scrub throws (index cold) → no file, one warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    scrub.mockImplementation(() => {
      throw new Error("secret index cold");
    });
    expect(() => dumpPrompt(dir, "task-3", messages)).not.toThrow();
    expect(() => readdirSync(dir)).toThrow(); // dir never created
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe(
      "[prompt-dump] skipped: secret index cold",
    );
  });

  it("retention: 52 existing dumps + 1 new → 50 remain, the 3 oldest gone", () => {
    dumpPrompt(dir, "seed", []); // creates the dir
    for (const f of readdirSync(dir)) rmSync(join(dir, f));
    const old = Array.from(
      { length: 52 },
      (_, i) => `20200101T000000${String(i).padStart(3, "0")}-old.md`,
    );
    for (const f of old) writeFileSync(join(dir, f), "x");
    dumpPrompt(dir, "task-4", messages);
    const files = readdirSync(dir);
    expect(files).toHaveLength(50);
    for (const f of old.slice(0, 3)) expect(files).not.toContain(f);
    expect(files.some((f) => f.endsWith("-task-4.md"))).toBe(true);
  });

  it("retention in a shared dir: only dump-named files are pruned", () => {
    mkdirSync(dir);
    const other = Array.from({ length: 60 }, (_, i) => `2026-09-${i}.md`);
    for (const f of other) writeFileSync(join(dir, f), "x");
    for (let i = 0; i < 52; i++) {
      writeFileSync(
        join(dir, `20200101T000000${String(i).padStart(3, "0")}-old.md`),
        "x",
      );
    }
    dumpPrompt(dir, "task-6", messages);
    const files = readdirSync(dir);
    for (const f of other) expect(files).toContain(f);
    expect(files.filter((f) => /^\d{8}T\d{9}-/.test(f))).toHaveLength(50);
  });

  it("relative path → writes nothing, one warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rel = "prompt-dump-test-relative";
    try {
      dumpPrompt(`${rel}/dumps`, "task-7", messages);
      expect(existsSync(rel)).toBe(false);
    } finally {
      rmSync(rel, { recursive: true, force: true }); // a regression's leftovers
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/must be absolute/);
  });

  it("path under the KB root → writes and creates nothing, one warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mkdirSync(join(root, "kb"));
    const inside = join(root, "kb", "logs", "dumps");
    dumpPrompt(inside, "task-8", messages);
    dumpPrompt(join(root, "kb"), "task-8", messages);
    expect(readdirSync(join(root, "kb"))).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toMatch(/inside the KB root/);
  });

  it("symlink into the KB root → refused via realpath", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const kb = join(root, "kb"); // removed with `root` in afterEach
    mkdirSync(join(kb, "sub"), { recursive: true });
    const lnk = join(root, "lnk");
    symlinkSync(join(kb, "sub"), lnk);
    dumpPrompt(lnk, "task-10", messages);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/^\[prompt-dump\] skipped:/);
    dumpPrompt(join(lnk, "deeper"), "task-10", messages);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1][0]).toMatch(/^\[prompt-dump\] skipped:/);
    expect(readdirSync(kb)).toEqual(["sub"]);
    expect(readdirSync(join(kb, "sub"))).toHaveLength(0);
  });

  it("a sibling directory sharing the KB root prefix is accepted", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    kbRoot.mockReturnValue(join(root, "jarvis-kb"));
    mkdirSync(join(root, "jarvis-kb"));
    const sibling = join(root, "jarvis-kb-dumps"); // removed with `root`
    dumpPrompt(sibling, "task-11", messages);
    expect(warn).not.toHaveBeenCalled();
    const files = readdirSync(sibling);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{8}T\d{9}-task-11\.md$/);
  });

  it("an existing 0o755 dir is tightened to 0o700", () => {
    mkdirSync(dir, { mode: 0o755 });
    expect(statSync(dir).mode & 0o777).toBe(0o755);
    dumpPrompt(dir, "task-9", messages);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("dir is created 0o700 and the file written 0o600", () => {
    dumpPrompt(dir, "task-5", messages);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const [f] = readdirSync(dir);
    expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);
  });
});
