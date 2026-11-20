import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildCommit, buildInfoUrl, describeBuildInfo, readBuildInfo, runningBuild } from "./build-info.js";

describe("describeBuildInfo", () => {
  it("names commit, branch and build time of a clean build", () => {
    const raw = JSON.stringify({
      commit: "ecae5e88aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      commitShort: "ecae5e88",
      branch: "main",
      builtAt: "2026-11-09T20:23:33Z",
      dirty: false,
      dirtyFiles: [],
    });
    expect(describeBuildInfo(raw)).toBe("ecae5e88 (main) built 2026-11-09T20:23:33Z");
  });

  it("marks a dirty build with its file count", () => {
    const raw = JSON.stringify({ commitShort: "abc1234", branch: "main", dirty: true, dirtyFiles: ["src/a.ts", "src/b.ts"] });
    expect(describeBuildInfo(raw)).toBe("abc1234 +dirty (2 file(s)) (main)");
  });

  it("falls back to the full commit when commitShort is missing", () => {
    expect(describeBuildInfo(JSON.stringify({ commit: "0123456789abcdef" }))).toBe("01234567");
  });

  it("reports absence, garbage and a record without a commit instead of throwing", () => {
    expect(describeBuildInfo(null)).toBe("no build-info.json (not built by the deploy)");
    expect(describeBuildInfo("{not json")).toBe("build-info.json unreadable");
    expect(describeBuildInfo("42")).toBe("build-info.json unreadable");
    expect(describeBuildInfo("null")).toBe("build-info.json unreadable");
    expect(describeBuildInfo(JSON.stringify({ branch: "main" }))).toBe("build-info.json has no commit");
  });
});

describe("buildCommit", () => {
  it("returns the short commit of a normal body, else the first 8 of the full commit", () => {
    expect(buildCommit(JSON.stringify({ commit: "f".repeat(40), commitShort: "abc1234", branch: "main" }))).toBe("abc1234");
    expect(buildCommit(JSON.stringify({ commit: "0123456789abcdef" }))).toBe("01234567");
  });

  it("is null for a body without a commit, for garbage and for an absent file", () => {
    expect(buildCommit(JSON.stringify({ branch: "main", dirty: false }))).toBeNull();
    expect(buildCommit(JSON.stringify({ commitShort: "" }))).toBeNull();
    expect(buildCommit("{not json")).toBeNull();
    expect(buildCommit("42")).toBeNull();
    expect(buildCommit("null")).toBeNull();
    expect(buildCommit(null)).toBeNull();
  });
});

describe("buildInfoUrl", () => {
  it("names the record one folder above the compiled module (nothing is read)", () => {
    expect(buildInfoUrl("file:///synthetic-root/dist/lib/build-info.js").href).toBe(
      "file:///synthetic-root/dist/build-info.json",
    );
  });
});

describe("runningBuild", () => {
  it("is null in a source run (no record next to the source tree) and stays the same on a second read", () => {
    expect(runningBuild()).toBeNull();
    expect(runningBuild()).toBeNull();
  });
});

describe("readBuildInfo", () => {
  it("reads the file at the URL, and tolerates its absence", () => {
    const dir = mkdtempSync(join(tmpdir(), "build-info-ts-"));
    try {
      const file = join(dir, "build-info.json");
      expect(readBuildInfo(pathToFileURL(file))).toBe("no build-info.json (not built by the deploy)");
      writeFileSync(file, JSON.stringify({ commitShort: "feedbee", branch: "main" }));
      expect(readBuildInfo(pathToFileURL(file))).toBe("feedbee (main)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
