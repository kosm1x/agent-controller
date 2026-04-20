/**
 * Tests for file_convert tool.
 *
 * Mocks node:child_process.execFile + node:fs statSync/existsSync so no
 * real subprocess runs and no real filesystem read is needed. Covers:
 * dispatch table correctness, source whitelist, target enum, binary
 * missing (ENOENT), timeout (SIGTERM), output-missing detection,
 * LibreOffice's --outdir rename convention.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  existsSync: vi.fn(),
  statSync: vi.fn(),
  lstatSync: vi.fn(),
  realpathSync: vi.fn(),
  renameSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mocks.execFile,
}));

vi.mock("node:fs", () => ({
  existsSync: mocks.existsSync,
  statSync: mocks.statSync,
  lstatSync: mocks.lstatSync,
  realpathSync: mocks.realpathSync,
  renameSync: mocks.renameSync,
}));

import { fileConvertTool } from "./file-convert.js";

function execFileOnce(
  opts: {
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    killed?: boolean;
    signal?: string;
    code?: string;
    captureArgv?: (binary: string, args: string[]) => void;
  } = {},
) {
  mocks.execFile.mockImplementationOnce(
    (
      binary: string,
      args: string[],
      _execOpts: Record<string, unknown>,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      opts.captureArgv?.(binary, args);
      if (opts.code === "ENOENT") {
        const err = new Error("spawn ENOENT") as Error & { code?: string };
        err.code = "ENOENT";
        cb(err, "", "");
      } else if (opts.killed && opts.signal === "SIGTERM") {
        const err = new Error("timed out") as Error & {
          killed?: boolean;
          signal?: string;
        };
        err.killed = true;
        err.signal = "SIGTERM";
        cb(err, "", "");
      } else if (opts.exitCode && opts.exitCode !== 0) {
        const err = new Error(`exit ${opts.exitCode}`) as Error & {
          code?: number;
        };
        err.code = opts.exitCode;
        cb(err, opts.stdout ?? "", opts.stderr ?? "");
      } else {
        cb(null, opts.stdout ?? "", opts.stderr ?? "");
      }
      return { pid: 999 } as unknown as ReturnType<typeof mocks.execFile>;
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: any file path we check exists and is a regular file.
  mocks.existsSync.mockReturnValue(true);
  mocks.statSync.mockReturnValue({
    isFile: () => true,
    size: 1234,
  } as unknown as ReturnType<typeof mocks.statSync>);
  // Default lstat: non-symlink, regular file. Tests that need symlink
  // behavior override this.
  mocks.lstatSync.mockReturnValue({
    isFile: () => true,
    isSymbolicLink: () => false,
  } as unknown as ReturnType<typeof mocks.lstatSync>);
  // Default realpath: echo the input path unchanged (no link resolution).
  mocks.realpathSync.mockImplementation((p: string) => p);
  mocks.renameSync.mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("file_convert dispatch", () => {
  it("routes .epub → ebook-convert with [input, output] argv", async () => {
    let seen: { bin: string; argv: string[] } | null = null;
    execFileOnce({
      captureArgv: (bin, argv) => {
        seen = { bin, argv };
      },
    });

    const result = await fileConvertTool.execute({
      input_path: "/tmp/book.epub",
      target_format: "txt",
      output_path: "/tmp/book.txt",
    });

    expect(seen!.bin).toBe("ebook-convert");
    expect(seen!.argv).toEqual(["/tmp/book.epub", "/tmp/book.txt"]);
    expect(result).toContain("file_convert:");
    expect(result).toContain("output: /tmp/book.txt");
  });

  it("routes .odt → libreoffice with --outdir convention and renames to requested output path", async () => {
    let seen: { bin: string; argv: string[] } | null = null;
    execFileOnce({
      captureArgv: (bin, argv) => {
        seen = { bin, argv };
      },
    });

    const result = await fileConvertTool.execute({
      input_path: "/workspace/notes.odt",
      target_format: "pdf",
      output_path: "/tmp/custom-name.pdf",
    });

    expect(seen!.bin).toBe("libreoffice");
    expect(seen!.argv).toEqual([
      "--headless",
      "--convert-to",
      "pdf",
      "--outdir",
      "/tmp",
      "/workspace/notes.odt",
    ]);
    // LibreOffice writes to outdir/<stem>.<target>; audit W2 added a
    // renameSync step that honors the caller's requested output_path.
    expect(mocks.renameSync).toHaveBeenCalledWith(
      "/tmp/notes.pdf",
      "/tmp/custom-name.pdf",
    );
    expect(result).toContain("output: /tmp/custom-name.pdf");
  });

  it("routes .md → pandoc with -o argv", async () => {
    let seen: { bin: string; argv: string[] } | null = null;
    execFileOnce({
      captureArgv: (bin, argv) => {
        seen = { bin, argv };
      },
    });

    await fileConvertTool.execute({
      input_path: "/tmp/doc.md",
      target_format: "html",
      output_path: "/tmp/doc.html",
    });

    expect(seen!.bin).toBe("pandoc");
    expect(seen!.argv).toEqual(["/tmp/doc.md", "-o", "/tmp/doc.html"]);
  });

  it("routes .heic → convert (ImageMagick v6)", async () => {
    let seen: { bin: string; argv: string[] } | null = null;
    execFileOnce({
      captureArgv: (bin, argv) => {
        seen = { bin, argv };
      },
    });

    await fileConvertTool.execute({
      input_path: "/tmp/photo.heic",
      target_format: "jpeg",
      output_path: "/tmp/photo.jpeg",
    });

    expect(seen!.bin).toBe("convert");
    expect(seen!.argv).toEqual(["/tmp/photo.heic", "/tmp/photo.jpeg"]);
  });

  it("routes .mp4 → ffmpeg with -ss before -i for instant seek", async () => {
    let seen: { bin: string; argv: string[] } | null = null;
    execFileOnce({
      captureArgv: (bin, argv) => {
        seen = { bin, argv };
      },
    });

    await fileConvertTool.execute({
      input_path: "/tmp/clip.mp4",
      target_format: "jpeg",
      output_path: "/tmp/frame.jpeg",
      timestamp_sec: 5.5,
    });

    expect(seen!.bin).toBe("ffmpeg");
    expect(seen!.argv[0]).toBe("-ss");
    expect(seen!.argv[1]).toBe("5.5");
    const ssPos = seen!.argv.indexOf("-ss");
    const iPos = seen!.argv.indexOf("-i");
    expect(ssPos).toBeLessThan(iPos);
  });

  it("defaults video timestamp to 1.0s when omitted", async () => {
    let seen: { argv: string[] } | null = null;
    execFileOnce({
      captureArgv: (_bin, argv) => {
        seen = { argv };
      },
    });

    await fileConvertTool.execute({
      input_path: "/tmp/v.mp4",
      target_format: "png",
    });

    expect(seen!.argv[1]).toBe("1");
  });

  it("defaults output_path to /tmp/file-convert-<uuid>.<target> when omitted", async () => {
    let seen: { argv: string[] } | null = null;
    execFileOnce({
      captureArgv: (_bin, argv) => {
        seen = { argv };
      },
    });

    const result = await fileConvertTool.execute({
      input_path: "/tmp/x.md",
      target_format: "pdf",
    });

    // pandoc receives the generated output path as last arg after "-o"
    const oIdx = seen!.argv.indexOf("-o");
    const generated = seen!.argv[oIdx + 1];
    expect(generated).toMatch(/^\/tmp\/file-convert-[0-9a-f-]+\.pdf$/);
    expect(result).toContain(generated);
  });
});

describe("file_convert path validation", () => {
  it("rejects relative input_path", async () => {
    const out = await fileConvertTool.execute({
      input_path: "relative/path.md",
      target_format: "html",
    });
    expect(JSON.parse(out).error).toMatch(/absolute/);
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it("rejects input_path with .. traversal", async () => {
    const out = await fileConvertTool.execute({
      input_path: "/tmp/../etc/passwd",
      target_format: "txt",
    });
    expect(JSON.parse(out).error).toMatch(/canonical/);
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it("rejects input_path outside the allow-list", async () => {
    const out = await fileConvertTool.execute({
      input_path: "/etc/passwd",
      target_format: "txt",
    });
    expect(JSON.parse(out).error).toMatch(/must be under/);
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it("rejects input_path that doesn't exist", async () => {
    mocks.existsSync.mockReturnValueOnce(false);
    const out = await fileConvertTool.execute({
      input_path: "/tmp/missing.md",
      target_format: "html",
    });
    expect(JSON.parse(out).error).toMatch(/does not exist/);
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it("rejects input_path pointing at a directory", async () => {
    // Audit C1: check is now via lstatSync (symlink-safe), so the mock
    // must override lstat, not stat.
    mocks.lstatSync.mockReturnValueOnce({
      isFile: () => false,
      isSymbolicLink: () => false,
    } as unknown as ReturnType<typeof mocks.lstatSync>);
    const out = await fileConvertTool.execute({
      input_path: "/tmp/somedir.md",
      target_format: "html",
    });
    expect(JSON.parse(out).error).toMatch(/regular file/);
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it("rejects output_path outside /tmp or /workspace", async () => {
    const out = await fileConvertTool.execute({
      input_path: "/tmp/x.md",
      target_format: "html",
      output_path: "/root/claude/mission-control/src/hack.html",
    });
    expect(JSON.parse(out).error).toMatch(/output_path must be under/);
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it("rejects output_path with .. traversal", async () => {
    const out = await fileConvertTool.execute({
      input_path: "/tmp/x.md",
      target_format: "html",
      output_path: "/tmp/../etc/shadow",
    });
    expect(JSON.parse(out).error).toMatch(/canonical/);
    expect(mocks.execFile).not.toHaveBeenCalled();
  });
});

describe("file_convert target enum", () => {
  it("rejects unknown target_format", async () => {
    const out = await fileConvertTool.execute({
      input_path: "/tmp/x.md",
      target_format: "exe",
    });
    expect(JSON.parse(out).error).toMatch(/target_format must be one of/);
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it("rejects target incompatible with source (e.g. .epub → jpeg)", async () => {
    const out = await fileConvertTool.execute({
      input_path: "/tmp/book.epub",
      target_format: "jpeg",
    });
    expect(JSON.parse(out).error).toMatch(/not supported for \.epub/);
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it("rejects unknown source extension", async () => {
    const out = await fileConvertTool.execute({
      input_path: "/tmp/mystery.xyz",
      target_format: "txt",
    });
    expect(JSON.parse(out).error).toMatch(/unsupported source extension/);
    expect(mocks.execFile).not.toHaveBeenCalled();
  });
});

describe("file_convert error handling", () => {
  it("surfaces ENOENT with apt-install instructions", async () => {
    execFileOnce({ code: "ENOENT" });
    const out = await fileConvertTool.execute({
      input_path: "/tmp/x.md",
      target_format: "html",
    });
    expect(JSON.parse(out).error).toMatch(/binary not installed: pandoc/);
    expect(JSON.parse(out).error).toMatch(/apt install/);
  });

  it("surfaces SIGTERM timeout with LibreOffice hint", async () => {
    execFileOnce({ killed: true, signal: "SIGTERM" });
    const out = await fileConvertTool.execute({
      input_path: "/workspace/slow.odt",
      target_format: "pdf",
    });
    expect(JSON.parse(out).error).toMatch(/timed out/);
    expect(JSON.parse(out).error).toMatch(/cold-start/);
  });

  it("surfaces non-zero exit with binary name", async () => {
    execFileOnce({ exitCode: 1, stderr: "some error" });
    const out = await fileConvertTool.execute({
      input_path: "/tmp/x.md",
      target_format: "html",
    });
    const err = JSON.parse(out);
    expect(err.error).toMatch(/conversion failed/);
    expect(err.binary).toBe("pandoc");
  });

  it("flags missing output even when binary exited cleanly", async () => {
    execFileOnce(); // success
    // Default existsSync returns true; override for the produced-file check.
    mocks.existsSync
      .mockReturnValueOnce(true) // input exists
      .mockReturnValueOnce(false); // output does NOT exist
    const out = await fileConvertTool.execute({
      input_path: "/tmp/x.md",
      target_format: "html",
    });
    expect(JSON.parse(out).error).toMatch(
      /exited cleanly but produced no output/,
    );
  });
});

describe("file_convert security — shell injection resistance", () => {
  it("never invokes a shell; argv passed verbatim to execFile", async () => {
    let seen: { argv: string[] } | null = null;
    execFileOnce({
      captureArgv: (_bin, argv) => {
        seen = { argv };
      },
    });

    // Even if a user sneaks shell metacharacters into a filename, they should
    // flow into argv as a literal string — not interpreted.
    await fileConvertTool.execute({
      input_path: "/tmp/weird; rm -rf .md",
      target_format: "html",
    });

    // One argv element contains the literal filename; no shell interpretation.
    expect(seen!.argv.some((a) => a.includes("rm -rf"))).toBe(true);
    // execFile was called (not execSync / exec with shell).
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
  });
});

describe("file_convert security — symlink + realpath (audit C1)", () => {
  it("rejects input_path that is itself a symlink", async () => {
    // Symlink returned by lstat; execFile must never be called.
    mocks.lstatSync.mockReturnValueOnce({
      isFile: () => true,
      isSymbolicLink: () => true,
    } as unknown as ReturnType<typeof mocks.lstatSync>);

    const out = await fileConvertTool.execute({
      input_path: "/tmp/link.md",
      target_format: "html",
    });

    expect(JSON.parse(out).error).toMatch(/must not be a symlink/);
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it("rejects input_path whose realpath escapes the sandbox", async () => {
    // Non-symlink leaf but realpath resolves through an intermediate link
    // pointing OUT of /tmp, e.g. /tmp/evil/passwd → /etc/passwd.
    mocks.realpathSync.mockReturnValueOnce("/etc/passwd");

    const out = await fileConvertTool.execute({
      input_path: "/tmp/evil/passwd",
      target_format: "txt",
    });

    expect(JSON.parse(out).error).toMatch(/realpath escapes/);
    expect(mocks.execFile).not.toHaveBeenCalled();
  });
});

describe("file_convert video — timestamp validation (audit C2)", () => {
  it("rejects Infinity timestamp and falls back to default 1.0", async () => {
    let seen: { argv: string[] } | null = null;
    execFileOnce({
      captureArgv: (_bin, argv) => {
        seen = { argv };
      },
    });

    await fileConvertTool.execute({
      input_path: "/tmp/clip.mp4",
      target_format: "jpeg",
      timestamp_sec: Infinity,
    });

    // Did NOT pass Infinity to ffmpeg argv.
    expect(seen!.argv).not.toContain("Infinity");
    expect(seen!.argv[1]).toBe("1"); // default 1.0s fallback
  });

  it("rejects NaN and negative timestamps (falls back to default)", async () => {
    for (const bad of [Number.NaN, -1, -0.5]) {
      vi.clearAllMocks();
      mocks.existsSync.mockReturnValue(true);
      mocks.statSync.mockReturnValue({
        isFile: () => true,
        size: 1234,
      } as unknown as ReturnType<typeof mocks.statSync>);
      mocks.lstatSync.mockReturnValue({
        isFile: () => true,
        isSymbolicLink: () => false,
      } as unknown as ReturnType<typeof mocks.lstatSync>);
      mocks.realpathSync.mockImplementation((p: string) => p);

      let seen: { argv: string[] } | null = null;
      execFileOnce({
        captureArgv: (_bin, argv) => {
          seen = { argv };
        },
      });

      await fileConvertTool.execute({
        input_path: "/tmp/clip.mp4",
        target_format: "jpeg",
        timestamp_sec: bad as number,
      });

      expect(seen!.argv[1]).toBe("1"); // always defaults
    }
  });
});
