import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { mkdirSync, rmSync, writeFileSync } from "fs";

// audit 2026-09-22: curl -L followed redirects to loopback; yt-dlp's generic
// extractor fetched any host. Direct URLs now go through safeFetch (per-hop
// validation) and yt-dlp is host-allow-listed.
// The children run through promisify(execFile) (MCEventLoopBlock): the mock
// hangs on promisify.custom and answers `{ stdout, stderr }` on a later tick,
// with `.child` on the promise like the real one.
const { mockExecFile, stdinEnds } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  stdinEnds: [] as Array<ReturnType<typeof vi.fn>>,
}));
vi.mock("child_process", async () => {
  const { promisify } = await import("util");
  return {
    execFile: Object.assign(vi.fn(), {
      [promisify.custom]: (...a: unknown[]) => {
        const end = vi.fn();
        stdinEnds.push(end);
        return Object.assign(Promise.resolve(mockExecFile(...a)), {
          child: { stdin: { end } },
        });
      },
    }),
  };
});
const mockSafeFetch = vi.fn();
vi.mock("../lib/url-safety.js", () => ({
  safeFetch: (...a: unknown[]) => mockSafeFetch(...a),
}));

import {
  downloadBackground,
  extractSubclip,
  MAX_DOWNLOAD_BYTES,
} from "./backgrounds.js";
import { existsSync } from "fs";

const made: string[] = [];
const slug = () => {
  const s = `t-${randomUUID().slice(0, 8)}`;
  made.push(s);
  return s;
};
afterAll(() => {
  for (const s of made)
    rmSync(`/tmp/video-backgrounds/${s}`, { recursive: true, force: true });
});

const YT = "https://www.youtube.com/watch?v=x";
const tick = () => new Promise<void>((r) => setImmediate(r));
/** Resolve on a later tick, after `effect` (the child's own side effect). */
const later = (stdout: string, effect: () => void = () => {}) =>
  new Promise((res) =>
    setImmediate(() => {
      effect();
      res({ stdout, stderr: "" });
    }),
  );
const failLater = (err: Error, effect: () => void = () => {}) =>
  new Promise((_res, rej) =>
    setImmediate(() => {
      effect();
      rej(err);
    }),
  );
const argvOf = (cmd: string) =>
  mockExecFile.mock.calls.find((c) => c[0] === cmd)?.[1] as
    | string[]
    | undefined;
const outOf = (argv: string[]) => argv[argv.indexOf("-o") + 1];
const ffprobeAnswer = (duration: string) =>
  JSON.stringify({ format: { duration } });

describe("downloadBackground fetch paths", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    mockExecFile.mockImplementation(() =>
      Promise.reject(new Error("unexpected child")),
    );
    stdinEnds.length = 0;
    mockSafeFetch.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("direct URLs go through safeFetch, never curl", async () => {
    mockSafeFetch.mockRejectedValueOnce(
      new Error("redirect hop 1 → http://127.0.0.1:8080/: Blocked"),
    );
    const r = await downloadBackground(
      slug(),
      "https://cdn.example/a.mp4",
      "c",
    );
    expect(r).toBeNull();
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("refuses a declared size over the cap without writing", async () => {
    const cancel = vi.fn(async () => {});
    mockSafeFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({
        "content-length": String(MAX_DOWNLOAD_BYTES + 1),
      }),
      body: { cancel },
    });
    const name = slug();
    expect(
      await downloadBackground(name, "https://cdn.example/a.mp4", "c"),
    ).toBeNull();
    expect(cancel).toHaveBeenCalled();
    expect(existsSync(`/tmp/video-backgrounds/${name}/${name}.mp4`)).toBe(
      false,
    );
  });

  it("aborts a stream that exceeds the cap mid-flight and removes the partial file", async () => {
    const cap = 3 * 1024 * 1024;
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        sent += chunk.length;
        if (sent > cap + 4 * chunk.length) ctrl.close();
        else ctrl.enqueue(chunk);
      },
    });
    mockSafeFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      body,
    });
    const name = slug();
    expect(
      await downloadBackground(name, "https://cdn.example/a.mp4", "c", cap),
    ).toBeNull();
    expect(existsSync(`/tmp/video-backgrounds/${name}/${name}.mp4`)).toBe(
      false,
    );
    expect(sent).toBeLessThan(cap + 4 * chunk.length);
  });

  it("refuses yt-dlp for a host outside the allow-list", async () => {
    const r = await downloadBackground(
      slug(),
      "http://attacker.example/page",
      "c",
    );
    expect(r).toBeNull();
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });

  it("runs yt-dlp for an allow-listed host: cap before `--`, URL after it, args otherwise unchanged", async () => {
    const name = slug();
    mockExecFile.mockImplementation(() => later(""));
    await downloadBackground(name, YT, "c");
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [cmd, argv, opts] = mockExecFile.mock.calls[0] as [
      string,
      string[],
      unknown,
    ];
    expect(cmd).toBe("yt-dlp");
    expect(argv).toEqual([
      "-f",
      "bestvideo[height<=1080][ext=mp4]/best[height<=1080]",
      "-o",
      `/tmp/video-backgrounds/${name}/${name}.mp4`,
      "--no-playlist",
      "--use-extractors",
      "default,-generic",
      "--max-filesize",
      String(MAX_DOWNLOAD_BYTES),
      "--quiet",
      "--",
      YT,
    ]);
    expect(argv.indexOf("--max-filesize")).toBeLessThan(argv.indexOf("--"));
    expect(opts).toEqual({ timeout: 120_000 });
    expect(stdinEnds[0]).toHaveBeenCalledTimes(1);
  });

  it("passes a custom cap to yt-dlp as plain integer bytes", async () => {
    mockExecFile.mockImplementation(() => later(""));
    await downloadBackground(slug(), YT, "c", 12_345_678);
    const argv = argvOf("yt-dlp")!;
    expect(argv[argv.indexOf("--max-filesize") + 1]).toBe("12345678");
  });

  it("caches the file yt-dlp wrote, with the duration ffprobe answered", async () => {
    const name = slug();
    mockExecFile.mockImplementation((cmd: string, argv: string[]) =>
      cmd === "yt-dlp"
        ? later("", () => writeFileSync(outOf(argv), "video"))
        : later(ffprobeAnswer("42.5")),
    );
    const meta = await downloadBackground(name, YT, "credit-x");
    const file = `/tmp/video-backgrounds/${name}/${name}.mp4`;
    expect(meta).toMatchObject({
      name,
      filePath: file,
      durationSeconds: 42.5,
      credit: "credit-x",
    });
    expect(mockExecFile.mock.calls[1].slice(0, 3)).toEqual([
      "ffprobe",
      ["-v", "quiet", "-print_format", "json", "-show_format", file],
      { timeout: 15_000, encoding: "utf-8" },
    ]);
  });

  it("a failing ffprobe caches the file with duration 0", async () => {
    const name = slug();
    mockExecFile.mockImplementation((cmd: string, argv: string[]) =>
      cmd === "yt-dlp"
        ? later("", () => writeFileSync(outOf(argv), "video"))
        : failLater(new Error("Command failed: ffprobe")),
    );
    expect(await downloadBackground(name, YT, "c")).toMatchObject({
      durationSeconds: 0,
    });
  });

  it("refuses and deletes a yt-dlp file larger than the cap (size unknown up front)", async () => {
    const name = slug();
    const cap = 10;
    mockExecFile.mockImplementation((_cmd: string, argv: string[]) =>
      later("", () => writeFileSync(outOf(argv), "x".repeat(cap + 1))),
    );
    expect(await downloadBackground(name, YT, "c", cap)).toBeNull();
    expect(existsSync(`/tmp/video-backgrounds/${name}/${name}.mp4`)).toBe(
      false,
    );
    expect(console.warn).toHaveBeenCalledWith(
      `[backgrounds] Refused ${cap + 1} B (cap): ${name}`,
    );
    // Refused before probing or caching.
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(existsSync(`/tmp/video-backgrounds/${name}/metadata.json`)).toBe(
      false,
    );
  });

  it("a file exactly at the cap is kept", async () => {
    const name = slug();
    mockExecFile.mockImplementation((cmd: string, argv: string[]) =>
      cmd === "yt-dlp"
        ? later("", () => writeFileSync(outOf(argv), "x".repeat(10)))
        : later(ffprobeAnswer("3")),
    );
    expect(await downloadBackground(name, YT, "c", 10)).not.toBeNull();
  });

  it.each([
    [
      "timeout (killed, SIGTERM)",
      Object.assign(new Error("Command failed: yt-dlp"), {
        killed: true,
        signal: "SIGTERM",
        code: null,
      }),
    ],
    [
      "non-zero exit",
      Object.assign(new Error("Command failed: yt-dlp\nERROR: x"), {
        code: 1,
      }),
    ],
  ])(
    "yt-dlp %s → null, and the output, .part and .ytdl files are removed",
    async (_label, err) => {
      const name = slug();
      const out = `/tmp/video-backgrounds/${name}/${name}.mp4`;
      mockExecFile.mockImplementation(() =>
        failLater(err, () => {
          for (const f of [out, `${out}.part`, `${out}.ytdl`])
            writeFileSync(f, "partial");
        }),
      );
      expect(await downloadBackground(name, YT, "c")).toBeNull();
      for (const f of [out, `${out}.part`, `${out}.ytdl`])
        expect(existsSync(f), f).toBe(false);
      expect(console.warn).toHaveBeenCalledWith(
        `[backgrounds] Download failed for ${name}:`,
        err.message,
      );
    },
  );

  it("does not settle while yt-dlp runs (the event loop stays free)", async () => {
    let release!: () => void;
    mockExecFile.mockImplementation(
      () => new Promise((res) => (release = () => res({ stdout: "" }))),
    );
    let settled = false;
    const run = downloadBackground(slug(), YT, "c").then((r) => {
      settled = true;
      return r;
    });
    await vi.waitFor(() => expect(release).toBeDefined());
    for (let i = 0; i < 5; i++) await tick();
    expect(settled).toBe(false);
    release();
    expect(await run).toBeNull(); // no file written → "produced no file"
  });
});

describe("extractSubclip — async ffmpeg", () => {
  const cached = (durationSeconds: number) => {
    const name = slug();
    const dir = `/tmp/video-backgrounds/${name}`;
    mkdirSync(dir, { recursive: true });
    const filePath = `${dir}/${name}.mp4`;
    writeFileSync(filePath, "src");
    writeFileSync(
      `${dir}/metadata.json`,
      JSON.stringify({
        name,
        filePath,
        durationSeconds,
        credit: "c",
        downloadedAt: "x",
      }),
    );
    return { name, filePath, out: `${dir}/sub.mp4` };
  };

  beforeEach(() => {
    mockExecFile.mockReset();
    stdinEnds.length = 0;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("returns the subclip ffmpeg wrote; args and timeout unchanged", async () => {
    const { name, filePath, out } = cached(600);
    mockExecFile.mockImplementation((_cmd: string, argv: string[]) =>
      later("", () => writeFileSync(argv.at(-1)!, "clip")),
    );
    expect(await extractSubclip(name, 10, out)).toBe(out);
    const [cmd, argv, opts] = mockExecFile.mock.calls[0] as [
      string,
      string[],
      unknown,
    ];
    expect(cmd).toBe("ffmpeg");
    expect(argv[0]).toBe("-y");
    expect(argv[1]).toBe("-ss");
    expect(argv.slice(3)).toEqual([
      "-i",
      filePath,
      "-t",
      "10",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-an",
      out,
    ]);
    // 10 % skip of a 600 s clip = 60 s minimum start.
    expect(Number(argv[2])).toBeGreaterThanOrEqual(60);
    expect(opts).toEqual({ timeout: 60_000 });
    expect(stdinEnds[0]).toHaveBeenCalledTimes(1);
  });

  it("a failing ffmpeg → null with the failure logged", async () => {
    const { name, out } = cached(600);
    mockExecFile.mockImplementation(() =>
      failLater(new Error("Command failed: ffmpeg")),
    );
    expect(await extractSubclip(name, 10, out)).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(
      "[backgrounds] Subclip extraction failed:",
      "Command failed: ffmpeg",
    );
  });

  it("ffmpeg exiting 0 without an output file → null", async () => {
    const { name, out } = cached(600);
    mockExecFile.mockImplementation(() => later(""));
    expect(await extractSubclip(name, 10, out)).toBeNull();
  });
});
