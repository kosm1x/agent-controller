/**
 * The shared output-file check, against the real filesystem. The only
 * things written are a temporary folder under /tmp/ and symlinks inside it,
 * removed after the file; a link's target is only looked up, never written.
 */

import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { basename } from "node:path";
import { checkOutputPath } from "./output-path.js";
import { resolveOutputPath as diagramOut } from "./diagram-generate.js";
import { resolveOutputPath as infographicOut } from "./infographic-generate.js";
import { validateOutputPath as convertOut } from "./file-convert.js";

// The folder must sit under /tmp/ itself (not TMPDIR) so the allowed-folder
// premise of every case holds wherever the runner points TMPDIR.
const dir = mkdtempSync("/tmp/out-path-");
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const UNDER_TEXT = "output_path must be under one of: /tmp/, /workspace/";

describe("checkOutputPath", () => {
  it("returns the caller's default when no output is given", () => {
    expect(checkOutputPath(undefined, "/tmp/default.svg")).toEqual({
      ok: true,
      abs: "/tmp/default.svg",
    });
    expect(checkOutputPath("", "/tmp/default.svg")).toEqual({
      ok: true,
      abs: "/tmp/default.svg",
    });
  });

  it("refuses a relative path", () => {
    expect(checkOutputPath("out/a.svg", "/tmp/d.svg")).toEqual({
      ok: false,
      error: "output_path must be absolute",
    });
  });

  it("refuses a non-canonical spelling", () => {
    for (const bad of [
      "/tmp/../etc/a.svg",
      "/tmp//a.svg",
      "/tmp/./a.svg",
      "/tmp/a/",
    ]) {
      expect(checkOutputPath(bad, "/tmp/d.svg")).toEqual({
        ok: false,
        error: "output_path must be canonical",
      });
    }
  });

  it("refuses a path outside the allowed folders", () => {
    expect(checkOutputPath("/etc/a.svg", "/tmp/d.svg")).toEqual({
      ok: false,
      error: UNDER_TEXT,
    });
  });

  it("refuses a bare allowed folder (a folder is not a file to write)", () => {
    for (const bare of ["/tmp", "/workspace"]) {
      expect(checkOutputPath(bare, "/tmp/d.svg")).toEqual({
        ok: false,
        error: UNDER_TEXT,
      });
    }
  });

  it("refuses a sibling whose name only starts like an allowed folder", () => {
    for (const bad of ["/tmpx/a.svg", "/workspacex/a.svg"]) {
      expect(checkOutputPath(bad, "/tmp/d.svg")).toEqual({
        ok: false,
        error: UNDER_TEXT,
      });
    }
  });

  it("keeps a path under each allowed folder", () => {
    const underTmp = `${dir}/a.svg`;
    // A fresh random name: no link under /workspace/ can redirect it.
    const underWorkspace = `/workspace/${basename(dir)}/a.svg`;
    expect(checkOutputPath(underTmp, "/tmp/d.svg")).toEqual({
      ok: true,
      abs: underTmp,
    });
    expect(checkOutputPath(underWorkspace, "/tmp/d.svg")).toEqual({
      ok: true,
      abs: underWorkspace,
    });
  });

  it("refuses a path through a symlink that leaves the allowed folders", () => {
    symlinkSync("/etc", `${dir}/out-link`);
    expect(checkOutputPath(`${dir}/out-link/a.svg`, "/tmp/d.svg")).toEqual({
      ok: false,
      error: "output_path resolves outside the allow-list",
    });
  });

  it("keeps a path through a symlink that stays under an allowed folder", () => {
    mkdirSync(`${dir}/real`);
    symlinkSync(`${dir}/real`, `${dir}/in-link`);
    expect(checkOutputPath(`${dir}/in-link/a.svg`, "/tmp/d.svg")).toEqual({
      ok: true,
      abs: `${dir}/in-link/a.svg`,
    });
  });
});

describe("each tool supplies its own default output path", () => {
  it.each([
    [
      "diagram svg_html",
      () => diagramOut(undefined, "svg_html"),
      /^\/tmp\/diagram-[0-9a-f-]+\.html$/,
    ],
    [
      "diagram graphviz",
      () => diagramOut(undefined, "graphviz"),
      /^\/tmp\/diagram-[0-9a-f-]+\.svg$/,
    ],
    [
      "infographic png",
      () => infographicOut(undefined, "png"),
      /^\/tmp\/infographic-[0-9a-f-]+\.png$/,
    ],
    [
      "file_convert pdf",
      () => convertOut(undefined, "pdf"),
      /^\/tmp\/file-convert-[0-9a-f-]+\.pdf$/,
    ],
    [
      "file_convert html",
      () => convertOut(undefined, "html"),
      /^\/tmp\/file-convert-[0-9a-f-]+\.html$/,
    ],
  ])("%s", (_n, run, shape) => {
    const r = run();
    expect(r.ok ? r.abs : r.error).toMatch(shape);
  });
});
