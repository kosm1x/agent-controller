/**
 * HuggingFace media generation — image, speech, video via Pro-compatible routes.
 *
 * Routing:
 * - Image:  HF Inference API (router.huggingface.co, included with Pro)
 * - Speech: Gradio Space — ResembleAI/Chatterbox (free via ZeroGPU)
 * - Video:  Gradio Space — alexnasa/ltx-2-TURBO (free via ZeroGPU)
 *
 * All tasks work with a HF Pro subscription — no extra credits needed.
 * Requires HUGGINGFACE_TOKEN env var.
 */

import { writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Tool } from "../types.js";

const MEDIA_DIR = "/tmp/hf_media";
const TIMEOUT_MS = 120_000;

// Gradio Space base URLs (all free with HF Pro via ZeroGPU)
const SPACES = {
  speech: "https://resembleai-chatterbox.hf.space/gradio_api",
  video: "https://alexnasa-ltx-2-turbo.hf.space/gradio_api",
  music: "https://ace-step-ace-step.hf.space/gradio_api",
};

function getToken(): string | null {
  return process.env.HUGGINGFACE_TOKEN ?? null;
}

function ensureDir(): void {
  if (!existsSync(MEDIA_DIR)) mkdirSync(MEDIA_DIR, { recursive: true });
}

function saveBuffer(buffer: Buffer, ext: string): string {
  ensureDir();
  const filename = `hf-${Date.now()}.${ext}`;
  const filePath = join(MEDIA_DIR, filename);
  writeFileSync(filePath, buffer);
  return filePath;
}

// ---------------------------------------------------------------------------
// Gradio Space helper — submit + poll SSE + download file
// ---------------------------------------------------------------------------

interface GradioResult {
  filePath: string;
}

async function callGradioSpace(
  spaceBaseUrl: string,
  endpoint: string,
  data: unknown[],
  ext: string,
  token: string,
  timeoutMs = TIMEOUT_MS,
): Promise<GradioResult> {
  // Step 1: Submit
  const submitResp = await fetch(`${spaceBaseUrl}/call${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ data }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!submitResp.ok) {
    const errorText = await submitResp.text().catch(() => "");
    throw new Error(
      `Space submit failed (${submitResp.status}): ${errorText.slice(0, 300)}`,
    );
  }

  const { event_id } = (await submitResp.json()) as { event_id: string };
  if (!event_id) throw new Error("Space returned no event_id");

  // Step 2: Poll SSE stream for completion
  const resultResp = await fetch(
    `${spaceBaseUrl}/call${endpoint}/${event_id}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    },
  );

  const resultText = await resultResp.text();

  // Parse SSE for "event: complete"
  const completeMatch = resultText.match(
    /event:\s*complete\s*\ndata:\s*(\[.*?\])\s*$/s,
  );
  if (!completeMatch) {
    if (resultText.includes("event: error")) {
      throw new Error(
        "Space generation failed — it may be sleeping or overloaded. Try again in a moment.",
      );
    }
    throw new Error(`Unexpected Space response: ${resultText.slice(0, 300)}`);
  }

  const parsed = JSON.parse(completeMatch[1]) as Array<unknown>;
  const fileInfo = parsed[0] as { url?: string } | null;
  const fileUrl = fileInfo?.url;
  if (!fileUrl) throw new Error("Generation completed but no file URL");

  // Step 3: Download file
  const dlResp = await fetch(fileUrl, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!dlResp.ok) throw new Error(`File download failed: ${dlResp.status}`);

  const buffer = Buffer.from(await dlResp.arrayBuffer());
  return { filePath: saveBuffer(buffer, ext) };
}

// ---------------------------------------------------------------------------
// Image — HF Inference API (sync, included with Pro)
// ---------------------------------------------------------------------------

async function generateImage(
  token: string,
  model: string,
  prompt: string,
  params: Record<string, unknown>,
): Promise<string> {
  const url = `https://router.huggingface.co/hf-inference/models/${model}`;
  const body: Record<string, unknown> = { inputs: prompt };
  if (Object.keys(params).length > 0) body.parameters = params;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`HF API ${response.status}: ${errorText.slice(0, 300)}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 100) {
    throw new Error("Response too small — generation may have failed");
  }

  return saveBuffer(buffer, "png");
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const hfGenerateTool: Tool = {
  name: "hf_generate",
  requiresConfirmation: true,
  riskTier: "medium",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "hf_generate",
      description: `Generate media (image, speech, video, music) using HuggingFace. All tasks work with Pro subscription — no extra credits.

USE WHEN:
- The user asks to create audio/speech, produce a video, or make music (ONLY tool for these)
- The user wants artistic image styles: anime, oil painting, 3D render, vector art, illustrations (FLUX is better for these)
- The user explicitly asks for HuggingFace, FLUX, or Stable Diffusion
- The user says "genera una imagen", "crea un audio", "haz un video", "genera música", "text to speech", "TTS"

USE gemini_image INSTEAD WHEN:
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
3. Share the file via Telegram, upload to WordPress (wp_media_upload), or use in other tools

PROMPT TIPS:
- Images: Be specific with style ("photorealistic", "oil painting"), lighting, composition
- Music tags: genre + mood + instruments ("pop electronic upbeat synth drums")
- Music lyrics: Use [verse], [chorus], [bridge] sections with timestamped or plain text
- Use negative_prompt to exclude: "blurry, text, watermark" (image/video)

MODELS (image only — override with model parameter):
- "black-forest-labs/FLUX.1-schnell" (fast, default)
- "black-forest-labs/FLUX.1-dev" (higher quality)
- "stabilityai/stable-diffusion-xl-base-1.0"

DO NOT narrate generation — call this tool. If it fails, report the actual error.`,
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            enum: ["image", "speech", "video", "music"],
            description:
              'What to generate: "image", "speech", "video", or "music"',
          },
          prompt: {
            type: "string",
            description:
              'The text prompt. For speech: text to speak (max 300 chars). For music: genre/mood/instrument tags (e.g. "pop electronic upbeat synth"). For image/video: visual description.',
          },
          model: {
            type: "string",
            description:
              "HuggingFace model ID (image only). Default: FLUX.1-schnell.",
          },
          negative_prompt: {
            type: "string",
            description:
              'Elements to exclude (image/video). Example: "blurry, text, watermark"',
          },
          width: {
            type: "number",
            description:
              "Width in pixels (image: default 1024, video: default 832, must be multiple of 32).",
          },
          height: {
            type: "number",
            description:
              "Height in pixels (image: default 1024, video: default 480, must be multiple of 32).",
          },
          guidance_scale: {
            type: "number",
            description:
              "CFG scale (image/video). Higher = closer to prompt. Default: 7.5.",
          },
          duration: {
            type: "number",
            description:
              "Duration in seconds. Video: default 3. Music: default 15 (range 5-285).",
          },
          lyrics: {
            type: "string",
            description:
              'Lyrics for music task. Use [verse], [chorus], [bridge] section markers. Example: "[verse]\\nHello world\\n[chorus]\\nLa la la"',
          },
          camera: {
            type: "string",
            enum: [
              "No LoRA",
              "Static",
              "Zoom In",
              "Zoom Out",
              "Slide Left",
              "Slide Right",
              "Slide Down",
              "Slide Up",
            ],
            description: 'Camera control for video. Default: "No LoRA".',
          },
        },
        required: ["task", "prompt"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const token = getToken();
    if (!token) {
      return JSON.stringify({
        error:
          "No HuggingFace token. Set HUGGINGFACE_TOKEN in .env (get one at huggingface.co/settings/tokens).",
      });
    }

    const task = args.task as string;
    const prompt = args.prompt as string;
    if (!task || !prompt) {
      return JSON.stringify({ error: "task and prompt are required" });
    }

    try {
      let filePath: string;

      if (task === "image") {
        const model =
          (args.model as string) ?? "black-forest-labs/FLUX.1-schnell";
        const params: Record<string, unknown> = {};
        if (args.guidance_scale) params.guidance_scale = args.guidance_scale;
        if (args.negative_prompt) params.negative_prompt = args.negative_prompt;
        if (args.width) params.width = args.width;
        if (args.height) params.height = args.height;
        filePath = await generateImage(token, model, prompt, params);
      } else if (task === "speech") {
        // Chatterbox: [text, ref_audio, exaggeration, temperature, seed, cfg_pace, vad_trim]
        const { filePath: fp } = await callGradioSpace(
          SPACES.speech,
          "/generate_tts_audio",
          [prompt.slice(0, 300), null, 0.5, 0.8, 0, 0.5, false],
          "wav",
          token,
        );
        filePath = fp;
      } else if (task === "video") {
        // LTX-2-TURBO: [first_frame, last_frame, prompt, duration, motion_ref,
        //               negative_prompt, enhance_prompt, seed, randomize_seed,
        //               height, width, camera_lora, audio]
        const duration = (args.duration as number) ?? 3;
        const height = (args.height as number) ?? 480;
        const width = (args.width as number) ?? 832;
        const negPrompt = (args.negative_prompt as string) ?? "";
        const camera = (args.camera as string) ?? "No LoRA";
        const { filePath: fp } = await callGradioSpace(
          SPACES.video,
          "/generate_video",
          [
            null,
            null,
            prompt,
            duration,
            null,
            negPrompt,
            true,
            0,
            true,
            height,
            width,
            camera,
            null,
          ],
          "mp4",
          token,
          300_000, // 5 min timeout for video
        );
        filePath = fp;
      } else if (task === "music") {
        // ACE-Step: [duration, tags, lyrics, steps, guidance, scheduler, cfg_type,
        //   granularity, seeds, guidance_interval, guidance_decay, min_guidance,
        //   erg_tag, erg_lyric, erg_diffusion, oss_steps, guidance_text,
        //   guidance_lyric, audio2audio, ref_strength, ref_audio, lora]
        const dur = (args.duration as number) ?? 15;
        const lyrics = (args.lyrics as string) ?? "";
        const { filePath: fp } = await callGradioSpace(
          SPACES.music,
          "/__call__",
          [
            dur,
            prompt,
            lyrics,
            27,
            5.0,
            "euler",
            "cfg",
            1.0,
            "",
            0.5,
            0.0,
            2.5,
            true,
            true,
            true,
            "",
            0.0,
            0.0,
            false,
            0.5,
            null,
            "none",
          ],
          "mp3",
          token,
          120_000,
        );
        filePath = fp;
      } else {
        return JSON.stringify({
          error: `Unknown task "${task}". Use "image", "speech", "video", or "music".`,
        });
      }

      const sizeKB = Math.round(statSync(filePath).size / 1024);

      return JSON.stringify({
        success: true,
        task,
        file_path: filePath,
        size_kb: sizeKB,
        prompt_used: prompt.slice(0, 200),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({
        error: `HF generation failed: ${message}`,
        task,
      });
    }
  },
};

// ---------------------------------------------------------------------------
// hf_spaces — search/discover HuggingFace Spaces
// ---------------------------------------------------------------------------

export const hfSpacesTool: Tool = {
  name: "hf_spaces",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "hf_spaces",
      description: `Search and discover running HuggingFace Spaces. By default only shows running Gradio Spaces compatible with Pro subscription (ZeroGPU/GPU/CPU).

USE WHEN:
- The user asks to find a specific type of AI tool (image editor, video generator, music maker, etc.)
- You need to discover what Spaces are available for a task
- The user says "busca un space para...", "find a space for...", "qué herramientas hay en HuggingFace"

Returns: name, likes, hardware, created date, and URL for each matching Space.`,
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              'Search query. Examples: "text to speech", "image editing", "video generation", "music", "background removal"',
          },
          sort: {
            type: "string",
            enum: ["likes", "created_at", "trending"],
            description: 'Sort order. Default: "likes" (most popular).',
          },
          limit: {
            type: "number",
            description: "Max results to return. Default: 10. Max: 30.",
          },
          filter: {
            type: "string",
            description:
              'Filter tag. Examples: "mcp-server", "zerogpu", "text-to-image". Default: none.',
          },
          hardware: {
            type: "string",
            enum: ["any", "zerogpu", "gpu", "cpu"],
            description:
              'Hardware filter. Default: "any" (zerogpu + gpu + cpu). Use "zerogpu" for GPU Spaces free with Pro.',
          },
          running_only: {
            type: "boolean",
            description: "Only show currently running Spaces. Default: true.",
          },
          sdk: {
            type: "string",
            enum: ["gradio", "streamlit", "docker", "static"],
            description:
              'SDK filter. Default: "gradio" (has API endpoints). Use "docker" for custom backends.',
          },
        },
        required: ["query"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const token = getToken();
    if (!token) {
      return JSON.stringify({ error: "No HUGGINGFACE_TOKEN configured." });
    }

    const query = args.query as string;
    const sort = (args.sort as string) ?? "likes";
    const limit = Math.min((args.limit as number) ?? 10, 30);
    const filter = args.filter as string | undefined;
    const sdk = (args.sdk as string) ?? "gradio";
    const runningOnly = (args.running_only as boolean) ?? true;
    const hardware = (args.hardware as string) ?? "any";

    const params = new URLSearchParams({
      search: query,
      sort,
      direction: "-1",
      limit: String(limit),
      sdk,
    });
    if (filter) params.set("filter", filter);
    if (runningOnly) params.set("includeNonRunning", "false");

    // Hardware filtering — HF API supports multiple hardware params
    if (hardware === "any") {
      params.append("hardware", "zerogpu");
      params.append("hardware", "gpu");
      params.append("hardware", "cpu");
    } else {
      params.set("hardware", hardware);
    }

    try {
      // expand[]=runtime to get hardware + stage info
      const url = `https://huggingface.co/api/spaces?${params.toString()}&${encodeURI("expand[]=runtime")}`;
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      });

      if (!resp.ok) {
        throw new Error(`HF API ${resp.status}`);
      }

      const spaces = (await resp.json()) as Array<Record<string, unknown>>;

      const results = spaces.map((s) => {
        const runtime = (s.runtime as Record<string, unknown>) ?? {};
        const hw = (runtime.hardware as Record<string, unknown>) ?? {};
        const createdAt = s.createdAt as string | undefined;
        const stage = runtime.stage as string | undefined;
        return {
          id: s.id,
          likes: s.likes,
          hardware: (hw.requested ?? hw.current ?? "unknown") as string,
          stage: stage ?? "unknown",
          created: createdAt?.slice(0, 10),
          url: `https://huggingface.co/spaces/${s.id}`,
        };
      });

      return JSON.stringify({ query, count: results.length, spaces: results });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: `Search failed: ${message}` });
    }
  },
};
