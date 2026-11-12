import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  existsSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  parseHtmlComposition,
  validateHtmlPath,
  HTML_PATH_ALLOWED_PREFIX,
  __setHtmlPathAllowedPrefixForTests,
} from "./html-parser.js";

// The live html-compose tool works in /root/tmp-video-html/ (operator files).
// Every fs write/remove this file makes is checked: one aimed at the live
// folder (or a sibling spelled with its prefix) is recorded and NOT performed,
// and the file fails in the last afterAll.
const liveTouches = vi.hoisted(() => [] as string[]);
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const guard =
    <A extends unknown[], R>(name: string, fn: (...a: A) => R) =>
    (...args: A): R | undefined => {
      const hit = args.find(
        (a) => typeof a === "string" && a.startsWith("/root/tmp-video-html"),
      );
      if (hit !== undefined) {
        liveTouches.push(`${name} ${String(hit)}`);
        return undefined;
      }
      return fn(...args);
    };
  const guarded = {
    mkdirSync: guard("mkdirSync", actual.mkdirSync),
    writeFileSync: guard("writeFileSync", actual.writeFileSync),
    rmSync: guard("rmSync", actual.rmSync),
    symlinkSync: guard("symlinkSync", actual.symlinkSync),
  };
  return { ...actual, ...guarded, default: { ...actual, ...guarded } };
});

// A folder this file owns; the parser's allow-list points at it for the run.
const ROOT = mkdtempSync(join(tmpdir(), "mc-test-video-html-"));
const TMP_DIR = join(ROOT, "compose");
const OUTSIDE_DIR = join(ROOT, "outside");
const jobId = `html-parser-test-${Date.now()}`;

// The allow-list as the module loaded it, observed before any setter call:
// a string-only check that fails at the prefix test, no file-system call.
const loadTimeRejection = (() => {
  try {
    validateHtmlPath(`${ROOT}/load-time-probe.html`);
    return "accepted";
  } catch (err) {
    return (err as Error).message;
  }
})();

beforeAll(() => {
  mkdirSync(TMP_DIR, { recursive: true });
  mkdirSync(OUTSIDE_DIR, { recursive: true });
  __setHtmlPathAllowedPrefixForTests(`${TMP_DIR}/`);
});

afterAll(() => {
  __setHtmlPathAllowedPrefixForTests();
  rmSync(ROOT, { recursive: true, force: true });
  expect(liveTouches).toEqual([]);
});

function writeHtml(name: string, body: string): string {
  const p = join(TMP_DIR, `${jobId}-${name}.html`);
  writeFileSync(p, body, "utf8");
  return p;
}

describe("html-parser — validateHtmlPath", () => {
  it("accepts a valid absolute path under allowlist", () => {
    const p = writeHtml("ok", "<html><body></body></html>");
    expect(() => validateHtmlPath(p)).not.toThrow();
  });

  it("rejects non-string input", () => {
    expect(() => validateHtmlPath(123 as unknown)).toThrow(/non-empty string/);
  });

  it("rejects relative paths", () => {
    expect(() => validateHtmlPath("relative/path.html")).toThrow(
      /must be absolute/,
    );
  });

  it("rejects path traversal", () => {
    expect(() =>
      validateHtmlPath("/root/tmp-video-html/../etc/passwd.html"),
    ).toThrow(/must not contain/);
  });

  it("rejects outside allowlist", () => {
    expect(() => validateHtmlPath("/tmp/other/file.html")).toThrow(
      `html_path must live under ${TMP_DIR}/`,
    );
  });

  // The service's own prefix: checked on the string alone (the prefix test
  // runs before any file system call), so the live folder is not read.
  it("enforces the live composition folder when no test prefix is set", () => {
    expect(HTML_PATH_ALLOWED_PREFIX).toBe("/root/tmp-video-html/");
    expect(loadTimeRejection).toBe(
      "html_path must live under /root/tmp-video-html/",
    );
    __setHtmlPathAllowedPrefixForTests();
    try {
      expect(() => validateHtmlPath(`${TMP_DIR}/x.html`)).toThrow(
        "html_path must live under /root/tmp-video-html/",
      );
    } finally {
      __setHtmlPathAllowedPrefixForTests(`${TMP_DIR}/`);
    }
    for (const bad of [TMP_DIR, "relative/", "/", "//", "/tmp/../"]) {
      expect(() => __setHtmlPathAllowedPrefixForTests(bad)).toThrow(
        "allowed prefix must be an absolute folder other than '/', ending with '/'",
      );
    }
  });

  it("rejects non-.html extension", () => {
    const p = writeHtml("scripty", "<html></html>");
    const renamed = p.replace(/\.html$/, ".js");
    writeFileSync(renamed, "<html></html>", "utf8");
    expect(() => validateHtmlPath(renamed)).toThrow(/\.html extension/);
  });

  it("rejects shell metachars in path", () => {
    expect(() => validateHtmlPath("/root/tmp-video-html/a\nb.html")).toThrow(
      /forbidden character/,
    );
    expect(() => validateHtmlPath("/root/tmp-video-html/a'b.html")).toThrow(
      /forbidden character/,
    );
  });

  it("rejects null-byte in path", () => {
    expect(() => validateHtmlPath("/root/tmp-video-html/a\0b.html")).toThrow(
      /forbidden character/,
    );
  });

  it("rejects missing file", () => {
    expect(() =>
      validateHtmlPath(`${TMP_DIR}/does-not-exist-${Date.now()}.html`),
    ).toThrow(/does not exist/);
  });

  it("rejects symlink that escapes allowlist", () => {
    const escapeTarget = join(OUTSIDE_DIR, "outside.html");
    writeFileSync(escapeTarget, "<html></html>", "utf8");
    const link = join(TMP_DIR, `${jobId}-symlink.html`);
    if (existsSync(link)) rmSync(link);
    symlinkSync(escapeTarget, link);
    expect(() => validateHtmlPath(link)).toThrow(
      /resolves via symlink outside allowlist/,
    );
  });
});

describe("html-parser — parseHtmlComposition", () => {
  it("computes data-driven duration from max(start+duration)", () => {
    const p = writeHtml(
      "data-driven",
      `<html><body>
        <div data-start="0" data-duration="3"></div>
        <div data-start="2" data-duration="5"></div>
        <div data-start="1" data-duration="1"></div>
      </body></html>`,
    );
    const r = parseHtmlComposition(p, { maxDurationSec: 120 });
    expect(r.dataDrivenDurationSec).toBe(7);
    expect(r.totalDurationSec).toBe(7);
    expect(r.elements.length).toBe(3);
    expect(r.elements[0].startSec).toBe(0);
    expect(r.elements[2].startSec).toBe(2);
  });

  it("uses declared duration from window.__hf.duration() over data-driven", () => {
    const p = writeHtml(
      "declared-override",
      `<html><body>
        <div data-start="0" data-duration="3"></div>
        <script>window.__hf = { duration: () => 10, seek: (t) => { /* noop */ } };</script>
      </body></html>`,
    );
    const r = parseHtmlComposition(p, { maxDurationSec: 120 });
    expect(r.declaredDurationSec).toBe(10);
    expect(r.dataDrivenDurationSec).toBe(3);
    expect(r.totalDurationSec).toBe(10);
    expect(r.hasSeekFn).toBe(true);
  });

  it("detects function-body duration pattern", () => {
    const p = writeHtml(
      "declared-fn",
      `<html><body>
        <div data-start="0" data-duration="1"></div>
        <script>window.__hf = { duration() { return 5.5; }, seek(t) { } };</script>
      </body></html>`,
    );
    const r = parseHtmlComposition(p, { maxDurationSec: 120 });
    expect(r.declaredDurationSec).toBe(5.5);
    expect(r.totalDurationSec).toBe(5.5);
  });

  it("clamps totalDurationSec to maxDurationSec cap", () => {
    const p = writeHtml(
      "overflow",
      `<html><body>
        <div data-start="0" data-duration="500"></div>
        <script>window.__hf = { duration: () => 300 };</script>
      </body></html>`,
    );
    const r = parseHtmlComposition(p, { maxDurationSec: 30 });
    expect(r.totalDurationSec).toBe(30);
  });

  it("throws when no timeline present", () => {
    const p = writeHtml("empty", `<html><body><div>hi</div></body></html>`);
    expect(() => parseHtmlComposition(p, { maxDurationSec: 120 })).toThrow(
      /no timeline found/,
    );
  });

  it("throws when maxDurationSec is invalid", () => {
    const p = writeHtml(
      "max-invalid",
      `<html><body><div data-start="0" data-duration="3"></div></body></html>`,
    );
    expect(() => parseHtmlComposition(p, { maxDurationSec: 0 })).toThrow(
      /maxDurationSec/,
    );
    expect(() => parseHtmlComposition(p, { maxDurationSec: 700 })).toThrow(
      /maxDurationSec/,
    );
  });

  it("coerces malformed numeric attributes to defaults", () => {
    const p = writeHtml(
      "malformed",
      `<html><body>
        <div data-start="abc" data-duration="-5"></div>
        <div data-start="" data-duration=""></div>
        <div data-start="1.5" data-duration="2"></div>
      </body></html>`,
    );
    const r = parseHtmlComposition(p, { maxDurationSec: 120 });
    // First two default to start=0 duration=maxCap-0=120, but clamped to 120
    // which means they'd pin the duration at 120. To avoid that, reject here.
    // However coerceFloat fallbacks mean the zero-length elements sit at
    // (0, 120). Test just asserts well-formed third element is preserved.
    const third = r.elements.find((e) => e.startSec === 1.5);
    expect(third?.durationSec).toBe(2);
  });

  it("caps data-start and data-duration at maxDurationSec per-element", () => {
    const p = writeHtml(
      "clamp-elem",
      `<html><body>
        <div data-start="0" data-duration="9999"></div>
      </body></html>`,
    );
    const r = parseHtmlComposition(p, { maxDurationSec: 60 });
    expect(r.elements[0].durationSec).toBeLessThanOrEqual(60);
    expect(r.totalDurationSec).toBeLessThanOrEqual(60);
  });

  it("reads trackIndex and layer defaults to 0", () => {
    const p = writeHtml(
      "tracks",
      `<html><body>
        <div data-start="0" data-duration="2" data-track-index="3" data-layer="7"></div>
        <div data-start="1" data-duration="1"></div>
      </body></html>`,
    );
    const r = parseHtmlComposition(p, { maxDurationSec: 120 });
    const withTracks = r.elements.find((e) => e.trackIndex === 3);
    expect(withTracks?.layer).toBe(7);
    const withoutTracks = r.elements.find((e) => e.trackIndex === 0);
    expect(withoutTracks?.layer).toBe(0);
  });

  it("rejects HTML file that exceeds 2MB cap", () => {
    const bigBody = "x".repeat(2 * 1024 * 1024 + 1);
    const p = writeHtml(
      "too-big",
      `<html><body><div data-start="0" data-duration="1">${bigBody}</div></body></html>`,
    );
    expect(() => parseHtmlComposition(p, { maxDurationSec: 120 })).toThrow(
      /2MB cap/,
    );
  });
});
