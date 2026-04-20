/**
 * Tests for diagram_generate tool.
 *
 * Mocks execFile + fs writes + the LLM infer() call. Covers dispatch to
 * graphviz vs svg_html, raw-DSL short-circuit, format/type enums, output
 * path validation, error surfaces (ENOENT, timeout), emit=source mode,
 * and description size cap.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  infer: vi.fn(),
  writeFileSync: vi.fn(),
  statSync: vi.fn(),
  existsSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mocks.execFile,
}));

vi.mock("node:fs", () => ({
  writeFileSync: mocks.writeFileSync,
  statSync: mocks.statSync,
  existsSync: mocks.existsSync,
  renameSync: mocks.renameSync,
  unlinkSync: mocks.unlinkSync,
}));

vi.mock("../../inference/adapter.js", () => ({
  infer: mocks.infer,
}));

import { diagramGenerateTool } from "./diagram-generate.js";

function mockDotSuccess(
  opts: {
    captureArgv?: (bin: string, args: string[]) => void;
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
      cb(null, "", "");
      return { pid: 99 } as unknown as ReturnType<typeof mocks.execFile>;
    },
  );
}

function mockDotFailure(
  opts: {
    code?: string;
    killed?: boolean;
    signal?: string;
    exitCode?: number;
  } = {},
) {
  mocks.execFile.mockImplementationOnce(
    (
      _binary: string,
      _args: string[],
      _execOpts: Record<string, unknown>,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
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
      } else {
        const err = new Error(`exit ${opts.exitCode ?? 1}`) as Error & {
          code?: number;
        };
        err.code = opts.exitCode ?? 1;
        cb(err, "", "some stderr");
      }
      return { pid: 99 } as unknown as ReturnType<typeof mocks.execFile>;
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.existsSync.mockReturnValue(true);
  mocks.statSync.mockReturnValue({
    size: 2048,
  } as unknown as ReturnType<typeof mocks.statSync>);
  mocks.writeFileSync.mockImplementation(() => undefined);
  mocks.renameSync.mockImplementation(() => undefined);
  mocks.unlinkSync.mockImplementation(() => undefined);
  mocks.infer.mockResolvedValue({
    content: "digraph mocked { A -> B; }",
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("diagram_generate — graphviz dispatch", () => {
  it("routes NL description through infer → dot with -Tsvg", async () => {
    let seen: { bin: string; argv: string[] } | null = null;
    mockDotSuccess({
      captureArgv: (bin, args) => {
        seen = { bin, argv: args };
      },
    });

    const result = await diagramGenerateTool.execute({
      description: "Show a client → API → DB request flow",
      format: "graphviz",
      output_path: "/tmp/out.svg",
    });

    expect(mocks.infer).toHaveBeenCalledTimes(1);
    expect(seen!.bin).toBe("dot");
    expect(seen!.argv[0]).toBe("-Tsvg");
    expect(seen!.argv[seen!.argv.length - 2]).toBe("-o");
    expect(seen!.argv[seen!.argv.length - 1]).toBe("/tmp/out.svg");
    expect(result).toContain("binary: dot");
    expect(result).toContain("output: /tmp/out.svg");
  });

  it("skips infer() when description is raw DOT (starts with digraph)", async () => {
    let seen: { argv: string[] } | null = null;
    mockDotSuccess({
      captureArgv: (_bin, argv) => {
        seen = { argv };
      },
    });

    await diagramGenerateTool.execute({
      description: "digraph G { A -> B; B -> C; }",
      format: "graphviz",
      output_path: "/tmp/g.svg",
    });

    // LLM NOT called — DSL short-circuit.
    expect(mocks.infer).not.toHaveBeenCalled();
    // The written source file should contain the raw DOT exactly.
    const firstWrite = mocks.writeFileSync.mock.calls[0];
    expect(firstWrite[1]).toBe("digraph G { A -> B; B -> C; }");
    expect(seen!.argv).toContain("-Tsvg");
  });

  it("skips infer() when description starts with 'graph ' (undirected)", async () => {
    mockDotSuccess();
    await diagramGenerateTool.execute({
      description: "graph G { A -- B; }",
      format: "graphviz",
    });
    expect(mocks.infer).not.toHaveBeenCalled();
  });

  it("emit=source returns DSL text without calling dot", async () => {
    const result = (await diagramGenerateTool.execute({
      description: "pipeline components",
      format: "graphviz",
      emit: "source",
    })) as string;

    expect(mocks.infer).toHaveBeenCalledTimes(1);
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(result).toContain("digraph mocked");
  });

  it("strips code fences from LLM output before piping to dot", async () => {
    mocks.infer.mockResolvedValueOnce({
      content: "```dot\ndigraph fenced { A -> B; }\n```",
    });
    mockDotSuccess();

    await diagramGenerateTool.execute({
      description: "foo",
      format: "graphviz",
    });

    const firstWrite = mocks.writeFileSync.mock.calls[0];
    expect(firstWrite[1]).toBe("digraph fenced { A -> B; }");
    expect(firstWrite[1]).not.toContain("```");
  });
});

describe("diagram_generate — svg_html dispatch", () => {
  it("routes NL description through infer, writes HTML, renames to requested path", async () => {
    mocks.infer.mockResolvedValueOnce({
      content: "<!doctype html><html><body><svg></svg></body></html>",
    });

    const result = (await diagramGenerateTool.execute({
      description: "architecture diagram of the service",
      format: "svg_html",
      output_path: "/tmp/arch.html",
    })) as string;

    expect(mocks.infer).toHaveBeenCalledTimes(1);
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(mocks.renameSync).toHaveBeenCalledTimes(1);
    const [fromPath, toPath] = mocks.renameSync.mock.calls[0];
    expect(fromPath).toMatch(/^\/tmp\/diagram-tmp-[0-9a-f-]+\.html$/);
    expect(toPath).toBe("/tmp/arch.html");
    expect(result).toContain("binary: inline");
    expect(result).toContain("output: /tmp/arch.html");
  });

  it("skips infer() when description is raw HTML", async () => {
    await diagramGenerateTool.execute({
      description: "<!doctype html><html></html>",
      format: "svg_html",
    });
    expect(mocks.infer).not.toHaveBeenCalled();
    const firstWrite = mocks.writeFileSync.mock.calls[0];
    expect(firstWrite[1]).toBe("<!doctype html><html></html>");
  });

  it("emit=source returns HTML text without writing", async () => {
    mocks.infer.mockResolvedValueOnce({
      content: "<!doctype html><html><body>inline</body></html>",
    });
    const result = (await diagramGenerateTool.execute({
      description: "sketch it",
      format: "svg_html",
      emit: "source",
    })) as string;

    expect(result).toContain("<!doctype html>");
    expect(mocks.writeFileSync).not.toHaveBeenCalled();
    expect(mocks.renameSync).not.toHaveBeenCalled();
  });
});

describe("diagram_generate — validation", () => {
  it("rejects empty description", async () => {
    const out = (await diagramGenerateTool.execute({
      description: "   ",
      format: "graphviz",
    })) as string;
    expect(JSON.parse(out).error).toMatch(/non-empty/);
    expect(mocks.infer).not.toHaveBeenCalled();
  });

  it("rejects description over 8000 chars", async () => {
    const out = (await diagramGenerateTool.execute({
      description: "x".repeat(8001),
      format: "graphviz",
    })) as string;
    expect(JSON.parse(out).error).toMatch(/description too long/);
    expect(mocks.infer).not.toHaveBeenCalled();
  });

  it("rejects unknown format", async () => {
    const out = (await diagramGenerateTool.execute({
      description: "anything",
      format: "mermaid",
    })) as string;
    expect(JSON.parse(out).error).toMatch(/format must be one of/);
  });

  it("rejects unknown diagram_type", async () => {
    const out = (await diagramGenerateTool.execute({
      description: "anything",
      format: "graphviz",
      diagram_type: "wireframe",
    })) as string;
    expect(JSON.parse(out).error).toMatch(/diagram_type must be one of/);
  });

  it("rejects unknown theme", async () => {
    const out = (await diagramGenerateTool.execute({
      description: "anything",
      format: "graphviz",
      theme: "rainbow",
    })) as string;
    expect(JSON.parse(out).error).toMatch(/theme must be one of/);
  });

  it("rejects unknown emit mode", async () => {
    const out = (await diagramGenerateTool.execute({
      description: "anything",
      format: "graphviz",
      emit: "stream",
    })) as string;
    expect(JSON.parse(out).error).toMatch(/emit must be one of/);
  });

  it("rejects output_path outside /tmp or /workspace", async () => {
    const out = (await diagramGenerateTool.execute({
      description: "anything",
      format: "graphviz",
      output_path: "/etc/passwd.svg",
    })) as string;
    expect(JSON.parse(out).error).toMatch(/output_path must be under/);
  });

  it("rejects relative output_path", async () => {
    const out = (await diagramGenerateTool.execute({
      description: "anything",
      format: "graphviz",
      output_path: "relative/out.svg",
    })) as string;
    expect(JSON.parse(out).error).toMatch(/absolute/);
  });

  it("rejects output_path with .. traversal", async () => {
    const out = (await diagramGenerateTool.execute({
      description: "anything",
      format: "graphviz",
      output_path: "/tmp/../etc/foo.svg",
    })) as string;
    expect(JSON.parse(out).error).toMatch(/canonical/);
  });
});

describe("diagram_generate — error handling", () => {
  it("surfaces ENOENT with apt-install hint", async () => {
    mockDotFailure({ code: "ENOENT" });
    const out = (await diagramGenerateTool.execute({
      description: "digraph G { A -> B; }",
      format: "graphviz",
    })) as string;
    expect(JSON.parse(out).error).toMatch(/apt install graphviz/);
  });

  it("surfaces SIGTERM timeout", async () => {
    mockDotFailure({ killed: true, signal: "SIGTERM" });
    const out = (await diagramGenerateTool.execute({
      description: "digraph G { A -> B; }",
      format: "graphviz",
    })) as string;
    expect(JSON.parse(out).error).toMatch(/timed out/);
  });

  it("flags missing output when dot exits cleanly but no file produced", async () => {
    mockDotSuccess();
    mocks.existsSync.mockReturnValueOnce(false);
    const out = (await diagramGenerateTool.execute({
      description: "digraph G { A -> B; }",
      format: "graphviz",
    })) as string;
    expect(JSON.parse(out).error).toMatch(
      /dot exited cleanly but produced no output/,
    );
  });

  it("surfaces non-zero exit with format tag", async () => {
    mockDotFailure({ exitCode: 2 });
    const out = (await diagramGenerateTool.execute({
      description: "digraph G { A -> B; }",
      format: "graphviz",
    })) as string;
    const err = JSON.parse(out);
    expect(err.error).toMatch(/diagram generation failed/);
    expect(err.format).toBe("graphviz");
  });
});

describe("diagram_generate — security", () => {
  it("execFile is used with arg array (no shell)", async () => {
    let seen: { argv: string[] } | null = null;
    mockDotSuccess({
      captureArgv: (_bin, argv) => {
        seen = { argv };
      },
    });

    // Even with shell metachars in description, nothing hits argv except
    // the source-file path and the output-file path.
    await diagramGenerateTool.execute({
      description: 'digraph G { "; rm -rf /" -> "boom"; }',
      format: "graphviz",
      output_path: "/tmp/smuggle.svg",
    });

    // argv should contain ONLY: -Tsvg, source path, -o, output path.
    expect(seen!.argv).toHaveLength(4);
    expect(seen!.argv[0]).toBe("-Tsvg");
    expect(seen!.argv[2]).toBe("-o");
    // No shell metachars reached argv.
    expect(seen!.argv.some((a) => a.includes("rm -rf"))).toBe(false);
  });

  it("rejects bare directory path /tmp or /workspace (audit W4)", async () => {
    for (const bad of ["/tmp", "/workspace"]) {
      const out = (await diagramGenerateTool.execute({
        description: "digraph G { A -> B; }",
        format: "graphviz",
        output_path: bad,
      })) as string;
      expect(JSON.parse(out).error).toMatch(/output_path must be under/);
    }
  });

  it("looksLikeDot does NOT short-circuit when DSL appears mid-sentence (audit W1)", async () => {
    mockDotSuccess();
    await diagramGenerateTool.execute({
      description: "Build a nice diagram, something like digraph G { A -> B; }",
      format: "graphviz",
    });
    // The description is NL wrapping the DSL snippet, so the anchored
    // `looksLikeDot` regex returns false → LLM IS called.
    expect(mocks.infer).toHaveBeenCalledTimes(1);
  });
});

describe("diagram_generate — boundary + cleanup (audit W5/W6)", () => {
  it("accepts description at exactly MAX_DESCRIPTION_CHARS (8000)", async () => {
    mockDotSuccess();
    const exactly8000 = "digraph G { ".padEnd(7999, "X") + "}";
    expect(exactly8000.length).toBe(8000);
    const out = (await diagramGenerateTool.execute({
      description: exactly8000,
      format: "graphviz",
    })) as string;
    // Exact-boundary length must succeed — the `> MAX` guard is strict `>`.
    expect(out).not.toMatch(/description too long/);
    expect(out).toContain("binary: dot");
  });

  it("svg_html rename-fallback writes directly + cleans up tmp (audit W3/W5)", async () => {
    mocks.infer.mockResolvedValueOnce({
      content: "<!doctype html><html><body>x</body></html>",
    });
    // First renameSync throws (simulates cross-fs EXDEV).
    mocks.renameSync.mockImplementationOnce(() => {
      throw new Error("EXDEV: cross-device link not permitted");
    });

    const result = (await diagramGenerateTool.execute({
      description: "arch",
      format: "svg_html",
      output_path: "/tmp/arch.html",
    })) as string;

    // renameSync attempted once, unlinkSync cleaned up tmp, then
    // writeFileSync wrote directly to output_path.
    expect(mocks.renameSync).toHaveBeenCalledTimes(1);
    // writeFileSync called twice: first for tmpPath, second for final path.
    expect(mocks.writeFileSync).toHaveBeenCalledTimes(2);
    expect(mocks.writeFileSync.mock.calls[1][0]).toBe("/tmp/arch.html");
    expect(result).toContain("output: /tmp/arch.html");
  });
});
