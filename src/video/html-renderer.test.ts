import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import {
  validateViewport,
  renderHtmlComposition,
  blockExternalRoute,
  FRAME_ROOT,
} from "./html-renderer.js";
import type { ParsedHtmlComposition } from "./html-parser.js";

const TMP_HTML_DIR = "/root/tmp-video-html";
const jobId = `html-renderer-test-${Date.now()}`;

function sampleComposition(
  overrides: Partial<ParsedHtmlComposition> = {},
): ParsedHtmlComposition {
  const htmlPath = join(TMP_HTML_DIR, `${jobId}.html`);
  mkdirSync(TMP_HTML_DIR, { recursive: true });
  writeFileSync(
    htmlPath,
    `<html><body><div data-start="0" data-duration="1"></div></body></html>`,
  );
  return {
    htmlPath,
    totalDurationSec: 1,
    dataDrivenDurationSec: 1,
    elements: [
      { tag: "div", startSec: 0, durationSec: 1, trackIndex: 0, layer: 0 },
    ],
    hasSeekFn: false,
    ...overrides,
  };
}

describe("html-renderer — blockExternalRoute handler (R1 R3 fix)", () => {
  function mockRoute(url: string) {
    const abort = vi.fn().mockResolvedValue(undefined);
    const continueFn = vi.fn().mockResolvedValue(undefined);
    return {
      route: {
        request: () => ({ url: () => url }),
        abort,
        continue: continueFn,
      },
      abort,
      continueFn,
    };
  }

  it("allows data: URIs", async () => {
    const handler = blockExternalRoute();
    const { route, abort, continueFn } = mockRoute(
      "data:image/png;base64,iVBORw0KG",
    );
    await handler(route);
    expect(continueFn).toHaveBeenCalledTimes(1);
    expect(abort).not.toHaveBeenCalled();
  });

  it("aborts https: URLs", async () => {
    const handler = blockExternalRoute();
    const { route, abort, continueFn } = mockRoute(
      "https://evil.example.com/x",
    );
    await handler(route);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(continueFn).not.toHaveBeenCalled();
  });

  it("aborts http: URLs", async () => {
    const handler = blockExternalRoute();
    const { route, abort } = mockRoute("http://10.0.0.1/exfil");
    await handler(route);
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("aborts ws:/wss: URLs", async () => {
    const handler = blockExternalRoute();
    const ws = mockRoute("ws://evil.com/socket");
    await handler(ws.route);
    expect(ws.abort).toHaveBeenCalledTimes(1);
    const wss = mockRoute("wss://evil.com/socket");
    await handler(wss.route);
    expect(wss.abort).toHaveBeenCalledTimes(1);
  });

  it("allows exactly the pinned composition file:// URL", async () => {
    const handler = blockExternalRoute("/root/tmp-video-html/ok.html");
    const { route, abort, continueFn } = mockRoute(
      "file:///root/tmp-video-html/ok.html",
    );
    await handler(route);
    expect(continueFn).toHaveBeenCalledTimes(1);
    expect(abort).not.toHaveBeenCalled();
  });

  it("aborts any other file:// URL even under the allowlist dir", async () => {
    const handler = blockExternalRoute("/root/tmp-video-html/ok.html");
    for (const url of [
      "file:///root/.ssh/id_rsa",
      "file:///etc/passwd",
      "file:///root/tmp-video-html/other.html",
      "file:///root/tmp-video-html/ok.html?a=1",
    ]) {
      const { route, abort } = mockRoute(url);
      await handler(route);
      expect(abort, `should abort ${url}`).toHaveBeenCalledTimes(1);
    }
  });

  it("aborts all file:// URLs when no allowedFilePath provided", async () => {
    const handler = blockExternalRoute();
    const { route, abort } = mockRoute("file:///root/.ssh/id_rsa");
    await handler(route);
    expect(abort).toHaveBeenCalledTimes(1);
  });
});

describe("html-renderer — validateViewport", () => {
  it("accepts typical dimensions", () => {
    expect(() => validateViewport(1920, 1080)).not.toThrow();
    expect(() => validateViewport(1080, 1920)).not.toThrow();
    expect(() => validateViewport(1080, 1080)).not.toThrow();
  });

  it("rejects non-integer", () => {
    expect(() => validateViewport(1920.5, 1080)).toThrow(/integers/);
  });

  it("rejects too small", () => {
    expect(() => validateViewport(100, 100)).toThrow(/≥320/);
  });

  it("rejects too large", () => {
    expect(() => validateViewport(3000, 1080)).toThrow(/≤1920/);
    expect(() => validateViewport(1080, 3000)).toThrow(/≤1920/);
  });
});

describe("html-renderer — jobId guard (C3 fix)", () => {
  // Inlined light compositional fixture to avoid pulling in the suite's mock setup.
  const composition = {
    htmlPath: "/root/tmp-video-html/noop.html",
    totalDurationSec: 1,
    dataDrivenDurationSec: 1,
    elements: [
      {
        tag: "div",
        startSec: 0,
        durationSec: 1,
        trackIndex: 0,
        layer: 0,
      },
    ],
    hasSeekFn: false,
  };

  it("rejects jobId containing path traversal", async () => {
    await expect(
      renderHtmlComposition(composition, "../../root/.ssh", {
        fps: 24,
        width: 640,
        height: 480,
      }),
    ).rejects.toThrow(/jobId must match/);
  });

  it("rejects empty jobId", async () => {
    await expect(
      renderHtmlComposition(composition, "", {
        fps: 24,
        width: 640,
        height: 480,
      }),
    ).rejects.toThrow(/jobId must match/);
  });

  it("rejects jobId with shell metachars", async () => {
    await expect(
      renderHtmlComposition(composition, "abcd; rm -rf /", {
        fps: 24,
        width: 640,
        height: 480,
      }),
    ).rejects.toThrow(/jobId must match/);
  });
});

// Mock playwright via vi.hoisted so fake browser is deterministic across tests.
const mocks = vi.hoisted(() => {
  const screenshotMock = vi.fn();
  const evaluateMock = vi.fn();
  const gotoMock = vi.fn();
  const routeMock = vi.fn();
  const newPageMock = vi.fn();
  const newContextMock = vi.fn();
  const closeMock = vi.fn();
  const launchMock = vi.fn();
  return {
    screenshotMock,
    evaluateMock,
    gotoMock,
    routeMock,
    newPageMock,
    newContextMock,
    closeMock,
    launchMock,
  };
});

vi.mock("playwright", () => ({
  chromium: {
    launch: mocks.launchMock,
  },
}));

// Mock execFileSync for ffmpeg step so no real binary runs.
vi.mock("child_process", async () => {
  const actual =
    await vi.importActual<typeof import("child_process")>("child_process");
  return {
    ...actual,
    execFileSync: vi.fn((cmd: string, args: string[]) => {
      if (cmd === "ffmpeg") {
        // Simulate ffmpeg creating the output file.
        const outputIdx = args.length - 1;
        const outputPath = args[outputIdx];
        writeFileSync(outputPath, Buffer.from([0x00, 0x01, 0x02]));
        return Buffer.from("");
      }
      return Buffer.from("");
    }),
  };
});

describe("html-renderer — renderHtmlComposition (mocked browser)", () => {
  beforeEach(() => {
    mocks.screenshotMock.mockReset();
    mocks.evaluateMock.mockReset();
    mocks.gotoMock.mockReset();
    mocks.routeMock.mockReset();
    mocks.newPageMock.mockReset();
    mocks.newContextMock.mockReset();
    mocks.closeMock.mockReset();
    mocks.launchMock.mockReset();

    mocks.screenshotMock.mockImplementation(async (opts: { path: string }) => {
      writeFileSync(opts.path, Buffer.from([0xff]));
    });
    mocks.evaluateMock.mockResolvedValue(undefined);
    mocks.gotoMock.mockResolvedValue(undefined);
    mocks.routeMock.mockResolvedValue(undefined);
    mocks.closeMock.mockResolvedValue(undefined);
    mocks.newPageMock.mockResolvedValue({
      goto: mocks.gotoMock,
      evaluate: mocks.evaluateMock,
      screenshot: mocks.screenshotMock,
    });
    mocks.newContextMock.mockResolvedValue({
      newPage: mocks.newPageMock,
      route: mocks.routeMock,
    });
    mocks.launchMock.mockResolvedValue({
      newContext: mocks.newContextMock,
      close: mocks.closeMock,
    });
  });

  afterEach(() => {
    const dir = join(FRAME_ROOT, jobId);
    if (existsSync(dir)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* noop */
      }
    }
  });

  it("renders N frames for totalDurationSec × fps", async () => {
    const comp = sampleComposition({ totalDurationSec: 2 });
    const outputPath = `/tmp/video-jobs/${jobId}-A.mp4`;
    const result = await renderHtmlComposition(comp, `${jobId}-A`, {
      fps: 24,
      width: 640,
      height: 480,
      outputPath,
    });
    expect(result.frameCount).toBe(48);
    expect(mocks.screenshotMock).toHaveBeenCalledTimes(48);
    expect(result.outputPath).toBe(outputPath);
    expect(existsSync(outputPath)).toBe(true);
    rmSync(outputPath, { force: true });
  });

  it("uses snap Chromium executablePath", async () => {
    await renderHtmlComposition(sampleComposition(), `${jobId}-B`, {
      fps: 24,
      width: 640,
      height: 480,
    });
    expect(mocks.launchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        executablePath: "/snap/bin/chromium",
      }),
    );
  });

  it("newContext locks down service workers + downloads (R1 C2 regression guard)", async () => {
    await renderHtmlComposition(sampleComposition(), `${jobId}-SW`, {
      fps: 24,
      width: 640,
      height: 480,
    });
    expect(mocks.newContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceWorkers: "block",
        acceptDownloads: false,
      }),
    );
  });

  it("rejects bad fps", async () => {
    await expect(
      renderHtmlComposition(sampleComposition(), `${jobId}-C`, {
        fps: 15 as 24,
        width: 640,
        height: 480,
      }),
    ).rejects.toThrow(/fps must be 24/);
  });

  it("rejects zero totalDurationSec", async () => {
    await expect(
      renderHtmlComposition(
        sampleComposition({ totalDurationSec: 0 }),
        `${jobId}-D`,
        { fps: 24, width: 640, height: 480 },
      ),
    ).rejects.toThrow(/totalDurationSec must be > 0/);
  });

  it("cleans up frame dir by default", async () => {
    const j = `${jobId}-E`;
    const outputPath = `/tmp/video-jobs/${j}.mp4`;
    await renderHtmlComposition(sampleComposition(), j, {
      fps: 24,
      width: 640,
      height: 480,
      outputPath,
    });
    const frameDir = join(FRAME_ROOT, j);
    expect(existsSync(frameDir)).toBe(false);
    rmSync(outputPath, { force: true });
  });

  it("keeps frame dir when keepFrames=true", async () => {
    const j = `${jobId}-F`;
    const outputPath = `/tmp/video-jobs/${j}.mp4`;
    await renderHtmlComposition(sampleComposition(), j, {
      fps: 24,
      width: 640,
      height: 480,
      outputPath,
      keepFrames: true,
    });
    const frameDir = join(FRAME_ROOT, j);
    expect(existsSync(frameDir)).toBe(true);
    rmSync(frameDir, { recursive: true, force: true });
    rmSync(outputPath, { force: true });
  });

  it("aborts when wall-clock cap exceeded", async () => {
    // Make screenshot slow so cap fires.
    mocks.screenshotMock.mockImplementation(async (opts: { path: string }) => {
      await new Promise((r) => setTimeout(r, 80));
      writeFileSync(opts.path, Buffer.from([0xff]));
    });
    await expect(
      renderHtmlComposition(
        sampleComposition({ totalDurationSec: 5 }),
        `${jobId}-G`,
        {
          fps: 24,
          width: 640,
          height: 480,
          wallClockCapSec: 0.3,
        },
      ),
    ).rejects.toThrow(/wall-clock cap/);
  }, 10_000);

  it("throws when no frames rendered", async () => {
    // Make screenshot throw on first call; aborted flag won't set so
    // frameCount stays 0 after break handling in the finally.
    mocks.screenshotMock.mockRejectedValue(new Error("screenshot kaboom"));
    await expect(
      renderHtmlComposition(sampleComposition(), `${jobId}-H`, {
        fps: 24,
        width: 640,
        height: 480,
      }),
    ).rejects.toThrow(/screenshot kaboom|no frames/);
  });

  it("registers route handler before navigation", async () => {
    await renderHtmlComposition(sampleComposition(), `${jobId}-I`, {
      fps: 24,
      width: 640,
      height: 480,
    });
    expect(mocks.routeMock).toHaveBeenCalledWith("**/*", expect.any(Function));
    // The goto should have been called after route registration.
    const routeOrder = mocks.routeMock.mock.invocationCallOrder[0];
    const gotoOrder = mocks.gotoMock.mock.invocationCallOrder[0];
    expect(routeOrder).toBeLessThan(gotoOrder);
  });
});
