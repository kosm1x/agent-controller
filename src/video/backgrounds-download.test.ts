import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { rmSync } from "fs";

// audit 2026-09-22: curl -L followed redirects to loopback; yt-dlp's generic
// extractor fetched any host. Direct URLs now go through safeFetch (per-hop
// validation) and yt-dlp is host-allow-listed.
const mockExecFileSync = vi.fn();
vi.mock("child_process", () => ({
  execFileSync: (...a: unknown[]) => mockExecFileSync(...a),
}));
const mockSafeFetch = vi.fn();
vi.mock("../lib/url-safety.js", () => ({
  safeFetch: (...a: unknown[]) => mockSafeFetch(...a),
}));

import { downloadBackground, MAX_DOWNLOAD_BYTES } from "./backgrounds.js";
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

describe("downloadBackground fetch paths", () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
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
    expect(mockExecFileSync).not.toHaveBeenCalled();
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
    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });

  it("runs yt-dlp for an allow-listed host, URL after --", async () => {
    await downloadBackground(slug(), "https://www.youtube.com/watch?v=x", "c");
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    const [cmd, argv] = mockExecFileSync.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("yt-dlp");
    expect(argv.join(" ")).toContain("--use-extractors default,-generic");
    expect(argv.at(-2)).toBe("--");
    expect(argv.at(-1)).toBe("https://www.youtube.com/watch?v=x");
  });
});
