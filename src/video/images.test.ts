/**
 * fetchImage's last step: with no provider key set, the solid-colour
 * placeholder is rendered by ffmpeg as an async child (MCEventLoopBlock).
 * No provider is reached (no key → no request), and no process starts: the
 * child is mocked and writes its output only when it settles, so a call that
 * is not awaited has produced nothing when the path is returned.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const child = vi.hoisted(() => ({
  calls: [] as unknown[][],
  stdinEnds: [] as Array<ReturnType<typeof vi.fn>>,
  fail: null as Error | null,
}));
vi.mock("child_process", async () => {
  const { promisify } = await import("util");
  const { writeFileSync: write } = await import("fs");
  const refuse = () => {
    throw new Error("refused: no other child in this test");
  };
  return {
    execFileSync: refuse,
    execFile: Object.assign(refuse, {
      [promisify.custom]: (cmd: string, args: string[], opts: unknown) => {
        child.calls.push([cmd, args, opts]);
        const end = vi.fn();
        child.stdinEnds.push(end);
        const settled = new Promise((res, rej) =>
          setImmediate(() => {
            if (child.fail) return rej(child.fail);
            if (cmd !== "ffmpeg") return rej(new Error(`unexpected ${cmd}`));
            write(args[args.length - 1], "png");
            res({ stdout: "", stderr: "" });
          }),
        );
        return Object.assign(settled, { child: { stdin: { end } } });
      },
    }),
  };
});

import { fetchImage } from "./images.js";

describe("fetchImage — placeholder via async ffmpeg", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mc-test-images-"));
    child.calls.length = 0;
    child.stdinEnds.length = 0;
    child.fail = null;
    for (const k of ["PEXELS_API_KEY", "GEMINI_API_KEY", "HUGGINGFACE_TOKEN"])
      vi.stubEnv(k, "");
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("returns the placeholder ffmpeg wrote; args and timeout unchanged", async () => {
    const out = join(dir, "sub", "scene-000.jpg");
    expect(await fetchImage("x", out, 640, 360)).toBe(out);
    expect(existsSync(out)).toBe(true);
    expect(child.calls).toEqual([
      [
        "ffmpeg",
        [
          "-y",
          "-f",
          "lavfi",
          "-i",
          "color=c=0x1a1a2e:s=640x360:d=1",
          "-frames:v",
          "1",
          out,
        ],
        { timeout: 15_000 },
      ],
    ]);
    expect(child.stdinEnds[0]).toHaveBeenCalledTimes(1);
  });

  it("a failing ffmpeg rejects (the sync call threw)", async () => {
    child.fail = new Error("Command failed: ffmpeg");
    await expect(fetchImage("x", join(dir, "a.jpg"))).rejects.toThrow(
      "Command failed: ffmpeg",
    );
  });

  it("does not settle before ffmpeg does", async () => {
    const out = join(dir, "b.jpg");
    let settled = false;
    const run = fetchImage("x", out).then(() => (settled = true));
    await vi.waitFor(() => expect(child.calls).toHaveLength(1));
    expect(settled).toBe(false);
    expect(existsSync(out)).toBe(false);
    await run;
    expect(existsSync(out)).toBe(true);
  });
});
