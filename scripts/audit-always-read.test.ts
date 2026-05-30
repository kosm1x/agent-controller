import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  utimesSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractCommitHashes,
  extractHeadClaimHashes,
  claimsMcDeployPending,
  claimsMcDeployOk,
  decideLevel,
  newestSrcFileMtimeMs,
} from "./audit-always-read.js";

describe("extractCommitHashes", () => {
  it("extracts short and long SHA-like tokens", () => {
    const hashes = extractCommitHashes(
      "HEAD is `12dfd81` after `c89de6faa2bafc00ff2a3b5cf1d4f7c2a2308dee` merged",
    );
    expect(hashes).toContain("12dfd81");
    expect(hashes).toContain("c89de6faa2bafc00ff2a3b5cf1d4f7c2a2308dee");
  });

  it("lowercases and dedupes", () => {
    const hashes = extractCommitHashes("abc1234 abc1234 ABC1234 def5678");
    expect(hashes.sort()).toEqual(["abc1234", "def5678"]);
  });

  it("ignores tokens shorter than 7 chars", () => {
    const hashes = extractCommitHashes("ref abc12 short");
    expect(hashes).not.toContain("abc12");
  });

  it("ignores tokens longer than 40 chars (not git SHAs)", () => {
    const overlong = "a".repeat(41);
    const hashes = extractCommitHashes(`token ${overlong} end`);
    expect(hashes).not.toContain(overlong);
  });

  it("returns empty for prose without hashes", () => {
    expect(
      extractCommitHashes("Plain documentation with no commit references."),
    ).toEqual([]);
  });
});

describe("extractHeadClaimHashes", () => {
  it("matches `HEAD: <hash>` style declarations", () => {
    expect(extractHeadClaimHashes("**HEAD:** `12dfd81`")).toEqual(["12dfd81"]);
  });

  it("matches `Última sincronización con repo: ...` followed by a hash within window", () => {
    const md =
      "**Última sincronización con repo:** 2026-05-28\n**HEAD:** `12dfd81` — title";
    expect(extractHeadClaimHashes(md)).toContain("12dfd81");
  });

  it("matches `último deploy` near a hash", () => {
    const md =
      "último deploy 2026-05-27 06:31 UTC tras `c89de6f` (último commit src/)";
    expect(extractHeadClaimHashes(md)).toContain("c89de6f");
  });

  it("matches `sincronizado con` paraphrase", () => {
    expect(extractHeadClaimHashes("sincronizado con repo: a1b2c3d4")).toContain(
      "a1b2c3d4",
    );
  });

  it("matches `tip del repo`", () => {
    expect(extractHeadClaimHashes("tip del repo: deadbeef")).toContain(
      "deadbeef",
    );
  });

  it("does NOT match hashes mentioned in body prose unrelated to HEAD", () => {
    const md =
      "Originally the b2fc758 fix lowered scores honestly; later the gate was tightened.";
    expect(extractHeadClaimHashes(md)).toEqual([]);
  });

  it("returns empty for prose without HEAD-context hashes", () => {
    expect(
      extractHeadClaimHashes("No commit references in this paragraph."),
    ).toEqual([]);
  });
});

describe("claimsMcDeployPending", () => {
  it("matches table-cell PENDIENTE claim", () => {
    expect(
      claimsMcDeployPending(
        "| mc-deploy | ⚠️ **PENDIENTE** — 8 commits no deployados |",
      ),
    ).toBe(true);
  });

  it("matches `mc-deploy: PENDIENTE` property style", () => {
    expect(claimsMcDeployPending("mc-deploy: PENDIENTE")).toBe(true);
  });

  it("matches `mc-deploy ⚠️ PENDIENTE — N commits` header-status form", () => {
    expect(
      claimsMcDeployPending("mc-deploy ⚠️ PENDIENTE — 8 commits sin deploy"),
    ).toBe(true);
  });

  it("matches `**mc-deploy** está pendiente` bold-prose form", () => {
    expect(claimsMcDeployPending("**mc-deploy** está pendiente")).toBe(true);
  });

  it("does NOT match anti-claim rule prose with `salvo`", () => {
    const rule =
      'No reportar "mc-deploy pendiente" salvo que `git log <último-deploy-time>..HEAD -- src/` devuelva commits.';
    expect(claimsMcDeployPending(rule)).toBe(false);
  });

  it("does NOT match `no reportar mc-deploy pendiente` prose", () => {
    expect(
      claimsMcDeployPending(
        "Regla: no reportar mc-deploy pendiente sin verificar.",
      ),
    ).toBe(false);
  });

  it("does NOT match `mc-deploy AL DÍA` claims (negated state)", () => {
    expect(
      claimsMcDeployPending(
        "✅ **mc-deploy AL DÍA.** Último deploy: 2026-05-27 06:31 UTC",
      ),
    ).toBe(false);
  });

  it("does NOT match isolated word `pendiente` far from `mc-deploy`", () => {
    expect(
      claimsMcDeployPending(
        "Haiku-downshift: activación pendiente.\n\nmc-deploy: AL DÍA",
      ),
    ).toBe(false);
  });
});

describe("claimsMcDeployOk", () => {
  it("matches `mc-deploy: AL DÍA`", () => {
    expect(claimsMcDeployOk("mc-deploy: AL DÍA — último deploy hoy")).toBe(
      true,
    );
  });

  it("matches table-cell AL DÍA claim", () => {
    expect(
      claimsMcDeployOk("| mc-deploy | ✅ **AL DÍA** — c89de6f deployado |"),
    ).toBe(true);
  });

  it("accepts `al dia` without accent", () => {
    expect(claimsMcDeployOk("mc-deploy: al dia")).toBe(true);
  });

  it("does NOT match anti-claim prose discussing the state", () => {
    expect(
      claimsMcDeployOk(
        "Nunca afirmes mc-deploy AL DÍA sin verificar contra dist mtime.",
      ),
    ).toBe(false);
  });
});

describe("original incident regression", () => {
  it("detects HEAD-claim hash AND PENDIENTE claim in the f2a4c40 fixture", () => {
    const incident = [
      "# Agent Controller — Estado Actual",
      "",
      "**Última sincronización con repo:** 2026-05-25 00:00 CDMX",
      "**HEAD:** `f2a4c40` — chore(p3-hygiene): close 5 trigger-gated long-tail items",
      "",
      "| Campo | Valor |",
      "|---|---|",
      "| mc-deploy | **PENDIENTE** (user-only) — f2a4c40 no deployado aún |",
    ].join("\n");
    expect(extractHeadClaimHashes(incident)).toContain("f2a4c40");
    expect(claimsMcDeployPending(incident)).toBe(true);
    expect(claimsMcDeployOk(incident)).toBe(false);
  });
});

describe("decideLevel", () => {
  it("returns 'ok' for empty findings", () => {
    expect(decideLevel([])).toBe("ok");
  });

  it("returns 'ok' when all findings are 'ok' (defensive)", () => {
    expect(decideLevel([{ level: "ok" }, { level: "ok" }])).toBe("ok");
  });

  it("promotes to 'warn' when any finding is warn", () => {
    expect(decideLevel([{ level: "ok" }, { level: "warn" }])).toBe("warn");
  });

  it("promotes to 'stale' when any finding is stale, even mixed with warn", () => {
    expect(
      decideLevel([{ level: "warn" }, { level: "stale" }, { level: "ok" }]),
    ).toBe("stale");
  });

  it("'stale' wins over 'warn' and 'ok' regardless of order", () => {
    expect(decideLevel([{ level: "stale" }])).toBe("stale");
    expect(decideLevel([{ level: "warn" }, { level: "stale" }])).toBe("stale");
    expect(decideLevel([{ level: "stale" }, { level: "warn" }])).toBe("stale");
  });
});

describe("newestSrcFileMtimeMs (deploy-state ground truth)", () => {
  const tmpDirs: string[] = [];

  function fixtureRepo(): string {
    const root = mkdtempSync(join(tmpdir(), "audit-src-"));
    tmpDirs.push(root);
    mkdirSync(join(root, "src", "nested"), { recursive: true });
    return root;
  }

  function writeAt(path: string, mtimeMs: number): void {
    writeFileSync(path, "// fixture\n");
    const t = mtimeMs / 1000;
    utimesSync(path, t, t);
  }

  afterEach(() => {
    while (tmpDirs.length > 0) {
      rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
    }
  });

  it("returns the newest non-test source-file mtime, recursing into subdirs", () => {
    const root = fixtureRepo();
    writeAt(join(root, "src", "a.ts"), 1_000_000_000_000);
    writeAt(join(root, "src", "nested", "b.ts"), 1_700_000_000_000); // newest non-test
    expect(newestSrcFileMtimeMs(root)).toBe(1_700_000_000_000);
  });

  it("ignores *.test.ts even when it is the newest file (deploy.sh does not ship tests)", () => {
    const root = fixtureRepo();
    writeAt(join(root, "src", "shell.ts"), 1_500_000_000_000);
    writeAt(join(root, "src", "shell.test.ts"), 1_900_000_000_000); // newer, but a test
    expect(newestSrcFileMtimeMs(root)).toBe(1_500_000_000_000);
  });

  it("ignores non-.ts files", () => {
    const root = fixtureRepo();
    writeAt(join(root, "src", "keep.ts"), 1_200_000_000_000);
    writeAt(join(root, "src", "README.md"), 1_900_000_000_000);
    writeAt(join(root, "src", "data.json"), 1_900_000_000_000);
    expect(newestSrcFileMtimeMs(root)).toBe(1_200_000_000_000);
  });

  it("returns null when src/ is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "audit-nosrc-"));
    tmpDirs.push(root);
    expect(newestSrcFileMtimeMs(root)).toBeNull();
  });

  it("deploy-then-commit regression: a build newer than every src file reads as deployed", () => {
    // Mirrors the 2026-05-30 incident: the src files were saved (and built)
    // BEFORE the git commit timestamp. The mtime signal must reflect the file
    // edit time, not the later commit — so a dist built after these mtimes
    // covers all source.
    const root = fixtureRepo();
    writeAt(join(root, "src", "shell.ts"), 1_780_035_974_000); // 06:26:14Z
    writeAt(join(root, "src", "nested", "ritual.ts"), 1_780_036_008_000); // 06:26:48Z
    const distMs = 1_780_036_373_000; // 06:32:53Z build
    const newest = newestSrcFileMtimeMs(root);
    expect(newest).toBe(1_780_036_008_000);
    expect(distMs >= (newest as number)).toBe(true); // build covers all source
  });
});
