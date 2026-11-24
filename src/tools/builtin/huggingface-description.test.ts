import { describe, it, expect, vi, beforeEach } from "vitest";

// This file reads the tool's description string and calls no handler. Every
// function export of both file-module specifiers ("fs" and "node:fs") is
// replaced for the whole file by a stub that throws.
// The global fetch is replaced by a stub that throws, set before the imports
// and again before each test.
const stubbed = vi.hoisted(() => (real: Record<string, unknown>) => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(real))
    out[k] =
      typeof v === "function"
        ? vi.fn(() => {
            throw new Error(`fs ${k} is a stub in this file`);
          })
        : v;
  out.default = out;
  return out;
});
vi.mock("fs", async (importOriginal) =>
  stubbed(await importOriginal<Record<string, unknown>>()),
);
vi.mock("node:fs", async (importOriginal) =>
  stubbed(await importOriginal<Record<string, unknown>>()),
);
const fetchStub = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("fetch is a stub in this file");
  }),
);
vi.hoisted(() => vi.stubGlobal("fetch", fetchStub));
beforeEach(() => {
  vi.stubGlobal("fetch", fetchStub);
});

import * as fs from "fs";
import * as nodeFs from "node:fs";
import { hfGenerateTool, hfSpacesTool } from "./huggingface.js";

const DESCRIPTION = `Search and discover running HuggingFace Spaces. By default only shows running Gradio Spaces compatible with Pro subscription (ZeroGPU/GPU/CPU).

USE WHEN:
- The user asks to find a specific type of AI tool (image editor, video generator, music maker, etc.)
- You need to discover what Spaces are available for a task
- The user says "busca un space para...", "find a space for...", "qué herramientas hay en HuggingFace"

DO NOT USE WHEN:
- You want media made: this tool only lists Spaces and runs none of them — use hf_generate when it is among your tools.
- You want models or datasets: this tool searches only the HuggingFace Spaces listing.

Returns: name, likes, hardware, created date, and URL for each matching Space.`;

describe("hf_spaces — description text", () => {
  it("every function export of both fs specifiers is a throwing mock, and fetch is the throwing stub", () => {
    for (const mod of [fs, nodeFs]) {
      const fns = Object.entries(mod).filter(([, v]) => typeof v === "function");
      expect(fns.length).toBeGreaterThan(0);
      for (const [name, fn] of fns) expect(vi.isMockFunction(fn), name).toBe(true);
      expect(() => (mod.writeFileSync as () => unknown)()).toThrow(/is a stub/);
    }
    expect(globalThis.fetch).toBe(fetchStub);
    expect(() => (globalThis.fetch as () => unknown)()).toThrow(/is a stub/);
  });

  it("the whole description, with its not-for block", () => {
    expect(hfSpacesTool.definition.function.description).toBe(DESCRIPTION);
  });
});

// Description pins: the tool's whole description text as registered.
describe("tool description texts", () => {
  it("hf_generate: the whole description", () => {
    expect(hfGenerateTool.definition.function.description).toBe(`Generate media (image, speech, video, music) using HuggingFace. All tasks work with Pro subscription — no extra credits.

USE WHEN:
- The user asks to create audio/speech, produce a video, or make music
- The user wants artistic image styles: anime, oil painting, 3D render, vector art, illustrations (FLUX is better for these)
- The user explicitly asks for HuggingFace, FLUX, or Stable Diffusion
- The user says "genera una imagen", "crea un audio", "haz un video", "genera música", "text to speech", "TTS"

USE gemini_image, when it is among your tools, INSTEAD WHEN:
- The user needs photorealistic images or editorial photography for WordPress blog posts
- The user needs aspect ratio control or 2K resolution

TASK TYPES:
- "image": Text-to-image via Inference API. ~3-5s. Default: FLUX.1-schnell. Returns PNG file path.
- "speech": Text-to-speech via Chatterbox Space. ~5s. English. High quality natural voice. Returns WAV file path.
- "video": Text-to-video via LTX-2-TURBO Space. ~15-60s. Returns MP4 file path. Supports camera control LoRA.
- "music": Text-to-music via ACE-Step Space. ~3-10s. Returns MP3 file path. Supports lyrics in [verse]/[chorus] format.

WORKFLOW:
1. Call hf_generate with task, prompt, and optional parameters
2. Tool returns a local file path to the generated media
3. Share the file via Telegram, upload to WordPress (wp_media_upload, when it is among your tools), or use in other tools

PROMPT TIPS:
- Images: Be specific with style ("photorealistic", "oil painting"), lighting, composition
- Music tags: genre + mood + instruments ("pop electronic upbeat synth drums")
- Music lyrics: Use [verse], [chorus], [bridge] sections with timestamped or plain text
- Use negative_prompt to exclude: "blurry, text, watermark" (image/video)

MODELS (image only — override with model parameter):
- "black-forest-labs/FLUX.1-schnell" (fast, default)
- "black-forest-labs/FLUX.1-dev" (higher quality)
- "stabilityai/stable-diffusion-xl-base-1.0"

DO NOT narrate generation — call this tool. If it fails, report the actual error.`);
  });
});
