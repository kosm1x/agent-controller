/**
 * HTML-as-Composition renderer — v7.4.3.
 *
 * Launches Playwright against the snap Chromium binary (Stage 0 finding: the
 * bundled chrome-headless-shell crashes on this VPS, but snap Chromium works
 * at ~140ms/frame). For each frame t in the computed timeline:
 *   1. Evaluate `window.__hf?.seek?.(t)` in the page context
 *   2. page.screenshot(path: frame-NNNNNN.png)
 * Then ffmpeg concatenates the PNG sequence into an MP4.
 *
 * Network is blocked at the route handler — only file:// + data: URIs load.
 * Runs under a wall-clock cap enforced by a setTimeout + process kill.
 *
 * Exposes a narrow seam: `renderHtmlComposition()` takes a parsed composition
 * and returns the MP4 path. The tool wrapper handles DB rows and job-state.
 */

import { execFileSync } from "child_process";
import { mkdirSync, rmSync, existsSync, statSync } from "fs";
import { join } from "path";
import { formatFrameTime } from "./frame-clock.js";
import type { ParsedHtmlComposition } from "./html-parser.js";

/** Playwright executable path — the ONLY path proven to survive on this VPS. */
export const SNAP_CHROMIUM_PATH = "/snap/bin/chromium";

/** Intermediate frame dir — /tmp is AppArmor-blocked for snap Chromium. */
export const FRAME_ROOT = "/root/tmp-video-frames";

/** Per-job wall-clock cap (seconds). Hard kill if exceeded. */
const DEFAULT_WALL_CLOCK_CAP_SEC = 300;

/** Hard ceiling on viewport dimensions (each axis). */
const MAX_VIEWPORT = 1920;

/**
 * jobId allowlist — defense-in-depth against path-injection via the exported
 * `renderHtmlComposition` seam. Today the only caller is `videoHtmlComposeTool`
 * which passes `randomUUID().slice(0,8)` (8 hex chars), but the function is a
 * public export; any future caller that feeds user-derived input must pass
 * through this gate. Matches the pattern in `videoJobCleanupTool`.
 */
const SAFE_JOB_ID = /^[A-Za-z0-9_-]{4,36}$/;

export interface RenderOptions {
  fps: 24 | 30 | 60;
  width: number;
  height: number;
  /** Optional output path override; otherwise /tmp/video-jobs/{jobId}.mp4. */
  outputPath?: string;
  /** Preserve frames/ dir after render (debugging only). */
  keepFrames?: boolean;
  /** Wall-clock cap override. */
  wallClockCapSec?: number;
}

export interface RenderResult {
  outputPath: string;
  frameCount: number;
  elapsedMs: number;
  perFrameAvgMs: number;
}

/**
 * Assertive viewport validation. Throws on out-of-range values.
 */
export function validateViewport(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new Error("viewport dimensions must be integers");
  }
  if (width < 320 || height < 320) {
    throw new Error("viewport dimensions must be ≥320");
  }
  if (width > MAX_VIEWPORT || height > MAX_VIEWPORT) {
    throw new Error(`viewport dimensions must be ≤${MAX_VIEWPORT}`);
  }
}

/**
 * Route handler factory. Allows only `data:` URLs and a single pinned
 * `file://` URL (the composition HTML itself). Everything else aborts.
 *
 * Live-smoke finding (R1 W6 false-positive correction): Playwright's
 * `context.route('**\/*', ...)` DOES intercept `file://` navigation
 * requests — contrary to the R1 audit claim. So we must explicitly allow
 * the compositions's own file path, but no other file:// references. An
 * author that writes `<img src="file:///root/.ssh/id_rsa">` will see the
 * image 404 because that URL does not match `allowedFilePath`.
 */
export function blockExternalRoute(allowedFilePath?: string) {
  const allowedFileUrl = allowedFilePath ? `file://${allowedFilePath}` : null;
  return async (route: {
    request: () => { url: () => string };
    abort: () => Promise<void>;
    continue: () => Promise<void>;
  }) => {
    const url = route.request().url();
    if (url.startsWith("data:")) {
      await route.continue();
    } else if (allowedFileUrl && url === allowedFileUrl) {
      await route.continue();
    } else {
      await route.abort();
    }
  };
}

/**
 * Render a parsed HTML composition into an MP4. Throws on failure.
 *
 * Design notes:
 * - Playwright `launch` with `executablePath: SNAP_CHROMIUM_PATH` — critical.
 * - No global require on `playwright`; dynamic import keeps module loadable
 *   in test environments that don't need the browser.
 * - Frame filenames pad to 6 digits — supports up to 999999 frames
 *   (far more than the 120s × 60fps = 7200 ceiling).
 */
export async function renderHtmlComposition(
  composition: ParsedHtmlComposition,
  jobId: string,
  opts: RenderOptions,
): Promise<RenderResult> {
  if (!SAFE_JOB_ID.test(jobId)) {
    throw new Error(
      `jobId must match ${SAFE_JOB_ID.source} (defense-in-depth vs path injection)`,
    );
  }
  validateViewport(opts.width, opts.height);
  if (![24, 30, 60].includes(opts.fps)) {
    throw new Error(`fps must be 24/30/60, got ${opts.fps}`);
  }
  if (composition.totalDurationSec <= 0) {
    throw new Error("composition totalDurationSec must be > 0");
  }

  const frameDir = join(FRAME_ROOT, jobId);
  if (existsSync(frameDir)) {
    rmSync(frameDir, { recursive: true, force: true });
  }
  mkdirSync(frameDir, { recursive: true });

  const outputPath = opts.outputPath ?? join("/tmp/video-jobs", `${jobId}.mp4`);
  mkdirSync(join("/tmp/video-jobs"), { recursive: true });

  const wallClockCapSec = opts.wallClockCapSec ?? DEFAULT_WALL_CLOCK_CAP_SEC;
  const startMs = Date.now();

  // Dynamic import to avoid eager playwright load at module eval time.
  const playwright: typeof import("playwright") = await import("playwright");
  const browser = await playwright.chromium.launch({
    headless: true,
    executablePath: SNAP_CHROMIUM_PATH,
    args: [
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-background-networking",
    ],
  });

  // W2 fix: cleanup frame dir on ANY error path below so failures don't leak
  // thousands of PNGs onto /root/tmp-video-frames/.
  const cleanupFramesOnError = () => {
    if (!opts.keepFrames) {
      try {
        rmSync(frameDir, { recursive: true, force: true });
      } catch {
        /* noop */
      }
    }
  };

  let abortTimer: NodeJS.Timeout | undefined;
  let aborted = false;
  const abortPromise = new Promise<never>((_, reject) => {
    abortTimer = setTimeout(() => {
      aborted = true;
      browser
        .close()
        .catch(() => {
          /* noop */
        })
        .finally(() => {
          reject(
            new Error(`render exceeded wall-clock cap of ${wallClockCapSec}s`),
          );
        });
    }, wallClockCapSec * 1000);
  });

  let frameCount = 0;
  const renderPromise = (async () => {
    try {
      const context = await browser.newContext({
        viewport: { width: opts.width, height: opts.height },
        acceptDownloads: false,
        // C2 fix: without this flag a hostile composition can register a SW
        // and proxy fetch traffic that bypasses the route handler.
        serviceWorkers: "block",
      });
      await context.route("**/*", blockExternalRoute(composition.htmlPath));

      const page = await context.newPage();
      await page.goto(`file://${composition.htmlPath}`, {
        waitUntil: "load",
      });

      // Ensure fonts settled before first frame (string-form avoids DOM-lib
      // typing requirement; Playwright evaluates this in the page context).
      await page
        .evaluate("document.fonts && document.fonts.ready")
        .catch(() => {
          /* noop — environments without fonts API proceed without blocking */
        });

      const frameDurationSec = 1 / opts.fps;
      const totalFrames = Math.floor(
        composition.totalDurationSec * opts.fps + 1e-6,
      );

      for (let i = 0; i < totalFrames; i++) {
        if (aborted) break;
        const t = i * frameDurationSec;
        const quantized = Number(formatFrameTime(t, opts.fps));
        // String-form page.evaluate avoids pulling DOM types into the Node
        // TS lib. The expression runs in the page, where window/__hf exist.
        await page.evaluate(
          `(function(t){ var hf = window.__hf; if (hf && typeof hf.seek === 'function') hf.seek(t); })(${quantized})`,
        );
        const framePath = join(
          frameDir,
          `frame-${String(i).padStart(6, "0")}.png`,
        );
        await page.screenshot({ path: framePath, type: "png" });
        frameCount++;
      }
    } finally {
      if (abortTimer) clearTimeout(abortTimer);
      try {
        await browser.close();
      } catch {
        /* noop */
      }
    }
  })();

  try {
    await Promise.race([renderPromise, abortPromise]);
  } catch (err) {
    cleanupFramesOnError();
    throw err;
  }

  if (frameCount === 0) {
    cleanupFramesOnError();
    throw new Error("no frames rendered (aborted before first screenshot)");
  }

  // Concat PNG sequence → MP4.
  // Use the glob-style -framerate + -i pattern. yuv420p for QuickTime compat.
  try {
    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-framerate",
        String(opts.fps),
        "-i",
        join(frameDir, "frame-%06d.png"),
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-r",
        String(opts.fps),
        "-movflags",
        "+faststart",
        outputPath,
      ],
      { stdio: "pipe", timeout: 120_000 },
    );
  } catch (err) {
    cleanupFramesOnError();
    throw new Error(
      `ffmpeg concat failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!existsSync(outputPath) || statSync(outputPath).size === 0) {
    cleanupFramesOnError();
    throw new Error(`ffmpeg produced no output at ${outputPath}`);
  }

  if (!opts.keepFrames) {
    try {
      rmSync(frameDir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }

  const elapsedMs = Date.now() - startMs;
  return {
    outputPath,
    frameCount,
    elapsedMs,
    perFrameAvgMs: Math.round(elapsedMs / frameCount),
  };
}
