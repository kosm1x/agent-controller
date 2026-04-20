/**
 * Tests for infographic_generate tool.
 *
 * Mocks @antv/infographic/ssr (renderToString) + @antv/infographic
 * (getTemplates) + inference.infer + fs writes, so tests run fast and
 * deterministically without the real AntV DOM shim or LLM.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  renderToString: vi.fn(),
  getTemplates: vi.fn(),
  infer: vi.fn(),
  writeFileSync: vi.fn(),
  statSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock("@antv/infographic/ssr", () => ({
  renderToString: mocks.renderToString,
}));
vi.mock("@antv/infographic", () => ({
  getTemplates: mocks.getTemplates,
}));

vi.mock("node:fs", () => ({
  writeFileSync: mocks.writeFileSync,
  statSync: mocks.statSync,
  renameSync: mocks.renameSync,
  unlinkSync: mocks.unlinkSync,
}));

vi.mock("../../inference/adapter.js", () => ({
  infer: mocks.infer,
}));

import { infographicGenerateTool } from "./infographic-generate.js";

const MOCK_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.renderToString.mockResolvedValue(MOCK_SVG);
  mocks.getTemplates.mockReturnValue([
    "list-row-simple-horizontal-arrow",
    "list-column-done-list",
    "list-grid-badge-card",
    "compare-swot",
    "chart-pie-compact-card",
  ]);
  mocks.infer.mockResolvedValue({
    content: `infographic list-row-simple-horizontal-arrow
theme dark
data
  lists
    - label Step 1
      desc Start
`,
  });
  mocks.statSync.mockReturnValue({
    size: MOCK_SVG.length,
  } as unknown as ReturnType<typeof mocks.statSync>);
  mocks.writeFileSync.mockImplementation(() => undefined);
  mocks.renameSync.mockImplementation(() => undefined);
  mocks.unlinkSync.mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("infographic_generate — dispatch", () => {
  it("data-mode short-circuits LLM and passes options object to renderToString", async () => {
    let seen: unknown;
    mocks.renderToString.mockImplementationOnce(async (opts) => {
      seen = opts;
      return MOCK_SVG;
    });

    const result = await infographicGenerateTool.execute({
      description: "ignored when data is present",
      format: undefined,
      data: {
        lists: [
          { label: "A", desc: "one" },
          { label: "B", desc: "two" },
        ],
      },
      template: "list-row-simple-horizontal-arrow",
      theme: "dark",
      output_path: "/tmp/out.svg",
    });

    expect(mocks.infer).not.toHaveBeenCalled();
    expect(seen).toEqual({
      data: {
        lists: [
          { label: "A", desc: "one" },
          { label: "B", desc: "two" },
        ],
      },
      template: "list-row-simple-horizontal-arrow",
      theme: "dark",
    });
    expect(result).toContain("data-mode");
  });

  it("DSL-mode short-circuits LLM and passes raw string", async () => {
    let seen: { opts: unknown; init: unknown } | null = null;
    mocks.renderToString.mockImplementationOnce(async (opts, init) => {
      seen = { opts, init };
      return MOCK_SVG;
    });

    const dsl = `infographic list-row-simple-horizontal-arrow
theme dark
data
  lists
    - label A
      desc 1
`;
    const result = await infographicGenerateTool.execute({
      description: dsl,
      theme: "dark",
    });

    expect(mocks.infer).not.toHaveBeenCalled();
    expect(typeof seen!.opts).toBe("string");
    expect(seen!.opts).toContain("list-row-simple-horizontal-arrow");
    // init must carry theme
    expect((seen!.init as { theme: string }).theme).toBe("dark");
    expect(result).toContain("dsl-mode");
  });

  it("LLM-mode converts NL → DSL then renders", async () => {
    let seen: unknown;
    mocks.renderToString.mockImplementationOnce(async (opts) => {
      seen = opts;
      return MOCK_SVG;
    });

    const result = await infographicGenerateTool.execute({
      description: "KPI grid showing Revenue, Users, Uptime for Q4",
      theme: "dark",
      output_path: "/tmp/kpi.svg",
    });

    expect(mocks.infer).toHaveBeenCalledTimes(1);
    expect(typeof seen).toBe("string");
    expect(seen).toContain("infographic");
    expect(result).toContain("llm-mode");
    expect(result).toContain("output: /tmp/kpi.svg");
  });

  it("emit=source returns DSL text without rendering (LLM mode)", async () => {
    const result = (await infographicGenerateTool.execute({
      description: "Show a comparison of A vs B",
      emit: "source",
    })) as string;

    expect(mocks.infer).toHaveBeenCalledTimes(1);
    expect(mocks.renderToString).not.toHaveBeenCalled();
    expect(result).toContain("(dsl source");
    expect(result).toContain("infographic");
  });

  it("emit=source with data returns options JSON (data mode)", async () => {
    const result = (await infographicGenerateTool.execute({
      description: "ignored",
      data: { lists: [{ label: "X", desc: "Y" }] },
      template: "list-row-simple-horizontal-arrow",
      emit: "source",
    })) as string;

    expect(mocks.renderToString).not.toHaveBeenCalled();
    expect(result).toContain("(options source, mode=data)");
    expect(result).toContain('"data"');
  });

  it("strips markdown fences from LLM DSL output", async () => {
    mocks.infer.mockResolvedValueOnce({
      content:
        "```\ninfographic compare-swot\ndata\n  swot\n    s Strength\n```",
    });
    let seen: string | undefined;
    mocks.renderToString.mockImplementationOnce(async (opts) => {
      seen = opts as string;
      return MOCK_SVG;
    });

    await infographicGenerateTool.execute({
      description: "SWOT for project X",
    });

    expect(seen!.startsWith("infographic compare-swot")).toBe(true);
    expect(seen).not.toContain("```");
  });
});

describe("infographic_generate — validation", () => {
  it("rejects empty description without data", async () => {
    const out = (await infographicGenerateTool.execute({
      description: "   ",
    })) as string;
    expect(JSON.parse(out).error).toMatch(/description required/);
    expect(mocks.infer).not.toHaveBeenCalled();
  });

  it("rejects description over MAX_DESCRIPTION_CHARS (8000)", async () => {
    const out = (await infographicGenerateTool.execute({
      description: "x".repeat(8001),
    })) as string;
    expect(JSON.parse(out).error).toMatch(/description too long/);
  });

  it("accepts description at exactly 8000 chars (boundary)", async () => {
    const prefix = "infographic list-row-simple-horizontal-arrow\n";
    const exactly8000 = prefix + "x".repeat(8000 - prefix.length);
    expect(exactly8000.length).toBe(8000);
    const out = (await infographicGenerateTool.execute({
      description: exactly8000,
    })) as string;
    expect(out).not.toMatch(/description too long/);
  });

  it("rejects unknown theme", async () => {
    const out = (await infographicGenerateTool.execute({
      description: "x",
      theme: "rainbow",
    })) as string;
    expect(JSON.parse(out).error).toMatch(/theme must be one of/);
  });

  it("rejects unknown emit mode", async () => {
    const out = (await infographicGenerateTool.execute({
      description: "x",
      emit: "stream",
    })) as string;
    expect(JSON.parse(out).error).toMatch(/emit must be one of/);
  });

  it("rejects unknown template (not in AntV catalog)", async () => {
    const out = (await infographicGenerateTool.execute({
      description: "x",
      template: "made-up-template-name",
    })) as string;
    expect(JSON.parse(out).error).toMatch(
      /template "made-up-template-name" not found/,
    );
    expect(mocks.renderToString).not.toHaveBeenCalled();
  });

  it("accepts a template present in the catalog", async () => {
    await infographicGenerateTool.execute({
      description: "anything",
      template: "list-grid-badge-card",
    });
    expect(mocks.renderToString).toHaveBeenCalledTimes(1);
  });
});

describe("infographic_generate — path validation", () => {
  it("rejects relative output_path", async () => {
    const out = (await infographicGenerateTool.execute({
      description: "anything",
      output_path: "relative/path.svg",
    })) as string;
    expect(JSON.parse(out).error).toMatch(/absolute/);
  });

  it("rejects output_path with .. traversal", async () => {
    const out = (await infographicGenerateTool.execute({
      description: "anything",
      output_path: "/tmp/../etc/out.svg",
    })) as string;
    expect(JSON.parse(out).error).toMatch(/canonical/);
  });

  it("rejects output_path outside allow-list", async () => {
    const out = (await infographicGenerateTool.execute({
      description: "anything",
      output_path: "/etc/out.svg",
    })) as string;
    expect(JSON.parse(out).error).toMatch(/must be under/);
  });

  it("rejects bare /tmp directory path", async () => {
    const out = (await infographicGenerateTool.execute({
      description: "anything",
      output_path: "/tmp",
    })) as string;
    expect(JSON.parse(out).error).toMatch(/must be under/);
  });
});

describe("infographic_generate — error handling", () => {
  it("surfaces renderToString errors with dispatch-mode tag", async () => {
    mocks.renderToString.mockRejectedValueOnce(new Error("SSR render timeout"));
    const out = (await infographicGenerateTool.execute({
      description:
        "infographic list-row-simple-horizontal-arrow\ndata\n  lists\n    - label x\n",
    })) as string;
    const err = JSON.parse(out);
    expect(err.error).toMatch(/renderToString failed: SSR render timeout/);
    expect(err.mode).toBe("dsl");
  });

  it("surfaces LLM errors before renderToString runs", async () => {
    mocks.infer.mockRejectedValueOnce(new Error("inference blew up"));
    const out = (await infographicGenerateTool.execute({
      description: "any NL prompt that is not DSL",
    })) as string;
    expect(JSON.parse(out).error).toMatch(/LLM DSL generation failed/);
    expect(mocks.renderToString).not.toHaveBeenCalled();
  });
});

describe("infographic_generate — output write + rename", () => {
  it("writes to tmp then renames to requested path", async () => {
    await infographicGenerateTool.execute({
      description:
        "infographic list-column-done-list\ndata\n  lists\n    - label x\n",
      output_path: "/tmp/final.svg",
    });
    expect(mocks.writeFileSync).toHaveBeenCalledTimes(1);
    expect(mocks.renameSync).toHaveBeenCalledTimes(1);
    const [fromPath, toPath] = mocks.renameSync.mock.calls[0];
    expect(fromPath).toMatch(/^\/tmp\/infographic-tmp-[0-9a-f-]+\.svg$/);
    expect(toPath).toBe("/tmp/final.svg");
  });

  it("falls back to direct write when renameSync fails (cross-fs)", async () => {
    mocks.renameSync.mockImplementationOnce(() => {
      throw new Error("EXDEV: cross-device link not permitted");
    });

    await infographicGenerateTool.execute({
      description:
        "infographic list-column-done-list\ndata\n  lists\n    - label x\n",
      output_path: "/workspace/out.svg",
    });

    // writeFileSync called twice: tmp + final. Also unlinkSync fired
    // (best-effort tmp cleanup).
    expect(mocks.writeFileSync).toHaveBeenCalledTimes(2);
    expect(mocks.writeFileSync.mock.calls[1][0]).toBe("/workspace/out.svg");
    expect(mocks.unlinkSync).toHaveBeenCalledTimes(1);
  });

  it("defaults output_path to /tmp/infographic-<uuid>.svg when omitted", async () => {
    const result = (await infographicGenerateTool.execute({
      description:
        "infographic list-column-done-list\ndata\n  lists\n    - label x\n",
    })) as string;
    const match = result.match(/output: (\/tmp\/infographic-[0-9a-f-]+\.svg)/);
    expect(match).not.toBeNull();
  });
});

describe("infographic_generate — dimensions", () => {
  it("passes valid width + height to renderToString init", async () => {
    let seen: {
      init: { width?: number; height?: number; theme?: string };
    } | null = null;
    mocks.renderToString.mockImplementationOnce(async (_opts, init) => {
      seen = {
        init: init as { width?: number; height?: number; theme?: string },
      };
      return MOCK_SVG;
    });

    await infographicGenerateTool.execute({
      description:
        "infographic list-row-simple-horizontal-arrow\ndata\n  lists\n    - label x\n",
      width: 1200,
      height: 600,
    });

    expect(seen!.init.width).toBe(1200);
    expect(seen!.init.height).toBe(600);
  });

  it("ignores non-finite / negative width/height (guards against Infinity-style injection)", async () => {
    let seen: { init: Record<string, unknown> } | null = null;
    mocks.renderToString.mockImplementationOnce(async (_opts, init) => {
      seen = { init: init as Record<string, unknown> };
      return MOCK_SVG;
    });

    await infographicGenerateTool.execute({
      description:
        "infographic list-row-simple-horizontal-arrow\ndata\n  lists\n    - label x\n",
      width: Infinity,
      height: -500,
    });

    // Neither set on init
    expect(seen!.init.width).toBeUndefined();
    expect(seen!.init.height).toBeUndefined();
  });
});
