/**
 * Video production tools — S5d + v7.4 S1 + v7.4 S2a.
 * Core: video_create, video_status, video_script, video_tts, video_image, video_list_profiles, video_list_voices, video_background_download.
 * v7.4 S1: video_transition_preview, video_compose_manifest, video_job_cancel, video_job_cleanup.
 */

import { randomUUID } from "crypto";
import { execFileSync } from "child_process";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import type { Tool } from "../types.js";
import { getDatabase, writeWithRetry } from "../../db/index.js";
import { toMexTime } from "../../lib/timezone.js";
import type { VideoJobRow } from "../../video/types.js";
import { VIDEO_PROFILES } from "../../video/types.js";
import {
  resolveTransition,
  TRANSITION_NAMES,
  type TransitionName,
} from "../../video/transitions.js";
import {
  validateManifest,
  type VideoCompositionManifest,
} from "../../video/composition-protocol.js";

const MAX_CONCURRENT_JOBS = 2;

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function createJob(
  jobId: string,
  topic: string,
  duration: number,
  template: string,
): void {
  const db = getDatabase();
  const expiresAt = new Date(Date.now() + 24 * 3600_000).toISOString();
  writeWithRetry(() =>
    db
      .prepare(
        `INSERT INTO video_jobs (job_id, topic, duration_seconds, template, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(jobId, topic, duration, template, expiresAt),
  );
}

function updateJob(
  jobId: string,
  updates: Partial<{
    status: string;
    script_json: string;
    assets_json: string;
    output_file: string;
    error_message: string;
    completed_at: string;
  }>,
): void {
  const db = getDatabase();
  const ALLOWED_COLUMNS = new Set([
    "status",
    "script_json",
    "assets_json",
    "output_file",
    "error_message",
    "completed_at",
  ]);
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, val] of Object.entries(updates)) {
    if (!ALLOWED_COLUMNS.has(key)) continue; // skip unknown columns
    sets.push(`${key} = ?`);
    values.push(val);
  }
  if (sets.length === 0) return;
  values.push(jobId);
  writeWithRetry(() =>
    db
      .prepare(`UPDATE video_jobs SET ${sets.join(", ")} WHERE job_id = ?`)
      .run(...values),
  );
}

function getJob(jobId: string): VideoJobRow | undefined {
  const db = getDatabase();
  return db.prepare("SELECT * FROM video_jobs WHERE job_id = ?").get(jobId) as
    | VideoJobRow
    | undefined;
}

// ---------------------------------------------------------------------------
// video_create — main orchestrator
// ---------------------------------------------------------------------------

export const videoCreateTool: Tool = {
  name: "video_create",
  requiresConfirmation: true,
  riskTier: "medium",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "video_create",
      description: `Create a video from a topic description. Full pipeline: script → TTS → images → compose → MP4.

USE WHEN:
- User asks "hazme un video sobre..."
- User wants a video explainer, presentation, or content piece

Requires confirmation before starting. Returns a job ID to check progress with video_status.
Duration: 15-120 seconds. Template: landscape (YouTube), portrait (TikTok/Reels), square (Instagram).

Modes:
- slideshow (default): static image per scene, concatenated. Simple and fast.
- overlay: images overlaid on background video with timed visibility. Produces professional-looking content.

OVERLAY MODE WORKFLOW:
1. First: video_background_download name:"ocean-waves" (or any catalog name)
2. Then: video_create topic:"..." mode:"overlay" background:"ocean-waves" template:"portrait"
3. Optional: voice:"es-MX-JorgeNeural" for male voice (use video_list_voices to browse)

The overlay engine uses per-scene TTS with individual timing, so each image appears exactly when its narration plays.`,
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description:
              "What the video is about (e.g. 'Inteligencia artificial en México')",
          },
          duration: {
            type: "number",
            description:
              "Video duration in seconds (default: 60, range: 15-120)",
          },
          template: {
            type: "string",
            enum: ["landscape", "portrait", "square"],
            description:
              "Aspect ratio: landscape (16:9), portrait (9:16), square (1:1). Default: landscape.",
          },
          language: {
            type: "string",
            description: "Narration language (default: es for Spanish)",
          },
          mode: {
            type: "string",
            enum: ["slideshow", "overlay"],
            description:
              "Composition mode. slideshow (default): static images. overlay: images over background video with timed visibility.",
          },
          voice: {
            type: "string",
            description:
              "Edge-tts voice name (e.g. es-MX-JorgeNeural). Use video_list_voices to see options.",
          },
          background: {
            type: "string",
            description:
              "Background name for overlay mode (e.g. ocean-waves). Must be pre-downloaded via video_background_download.",
          },
        },
        required: ["topic"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const topic = args.topic as string;
    if (!topic) return JSON.stringify({ error: "topic is required" });

    // Lazy cleanup of expired jobs (24h TTL)
    try {
      const expired = getDatabase()
        .prepare(
          "SELECT job_id FROM video_jobs WHERE expires_at < datetime('now') AND status IN ('completed','failed')",
        )
        .all() as Array<{ job_id: string }>;
      for (const { job_id } of expired) {
        import("../../video/composer.js")
          .then((m) => m.cleanupJob(job_id))
          .catch(() => {});
        getDatabase()
          .prepare("DELETE FROM video_jobs WHERE job_id = ?")
          .run(job_id);
      }
    } catch {
      /* non-fatal */
    }

    // Concurrency gate
    const activeCount = (
      getDatabase()
        .prepare(
          "SELECT COUNT(*) as cnt FROM video_jobs WHERE status IN ('scripting','generating_assets','composing')",
        )
        .get() as { cnt: number }
    ).cnt;
    if (activeCount >= MAX_CONCURRENT_JOBS) {
      return JSON.stringify({
        error: `Too many active video jobs (${activeCount}/${MAX_CONCURRENT_JOBS}). Wait for current jobs to finish.`,
      });
    }

    const duration = Math.min(120, Math.max(15, Number(args.duration) || 60));
    const template = (args.template as string) || "landscape";
    const language = (args.language as string) || "es";
    const mode = (args.mode as string) || "slideshow";
    const voice = args.voice as string | undefined;
    const background = args.background as string | undefined;
    const jobId = randomUUID().slice(0, 8);

    createJob(jobId, topic, duration, template);

    // Run pipeline async (don't block the tool response)
    runPipeline(jobId, topic, duration, template, language, {
      mode: mode as "slideshow" | "overlay",
      voice,
      background,
    }).catch((err) => {
      console.error(`[video] Pipeline failed for ${jobId}:`, err);
      updateJob(jobId, {
        status: "failed",
        error_message: err instanceof Error ? err.message : String(err),
      });
    });

    return JSON.stringify({
      jobId,
      status: "pending",
      message: `Video job ${jobId} started. Use video_status to check progress.`,
      topic,
      duration,
      template,
    });
  },
};

async function runPipeline(
  jobId: string,
  topic: string,
  duration: number,
  template: string,
  language: string,
  options?: {
    mode?: "slideshow" | "overlay";
    voice?: string;
    background?: string;
  },
): Promise<void> {
  const workDir = join("/tmp", "video-jobs", jobId);
  mkdirSync(workDir, { recursive: true });

  // Step 1: Generate script
  updateJob(jobId, { status: "scripting" });
  const { generateScript } = await import("../../video/script-generator.js");
  const script = await generateScript(topic, duration, language);
  updateJob(jobId, { script_json: JSON.stringify(script) });

  // Step 2: Generate assets
  updateJob(jobId, { status: "generating_assets" });
  const { fetchImage } = await import("../../video/images.js");
  const { generateSubtitles } = await import("../../video/subtitles.js");

  const subtitleFile = join(workDir, "subtitles.srt");
  const templateTyped = template as "landscape" | "portrait" | "square";
  const mode = options?.mode ?? "slideshow";

  // Fetch images for each scene (shared by both modes)
  await Promise.all(
    script.scenes.map((scene, i) =>
      fetchImage(
        scene.imageQuery,
        join(workDir, `scene-${String(i).padStart(3, "0")}.jpg`),
        template === "portrait" ? 1080 : 1920,
        template === "portrait" ? 1920 : 1080,
      ),
    ),
  );
  const imageFiles = script.scenes.map((_, i) =>
    join(workDir, `scene-${String(i).padStart(3, "0")}.jpg`),
  );

  generateSubtitles(script, subtitleFile);

  let outputFile: string;

  if (mode === "overlay") {
    // V3 overlay mode: per-scene TTS + background subclip + timed overlays
    const { generatePerSceneTTS } = await import("../../video/tts.js");
    const { extractSubclip, getCachedMeta } =
      await import("../../video/backgrounds.js");

    // Per-scene TTS with voice selection
    const ttsResult = await generatePerSceneTTS(script.scenes, workDir, {
      language,
      voice: options?.voice,
    });

    // Extract background subclip matching total TTS duration
    const bgName = options?.background ?? "ocean-waves";
    const bgMeta = getCachedMeta(bgName);
    if (!bgMeta) {
      throw new Error(
        `Background "${bgName}" not cached. Run video_background_download first.`,
      );
    }
    const bgSubclip = join(workDir, "bg-subclip.mp4");
    const subclipResult = extractSubclip(
      bgName,
      ttsResult.totalDuration,
      bgSubclip,
    );
    if (!subclipResult) {
      throw new Error(
        `Failed to extract subclip from "${bgName}". Video may be too short.`,
      );
    }

    updateJob(jobId, {
      assets_json: JSON.stringify({
        audio: ttsResult.files,
        images: imageFiles,
        subtitles: subtitleFile,
        background: bgSubclip,
        durations: ttsResult.durations,
      }),
    });

    // Compose with overlay engine
    updateJob(jobId, { status: "composing" });
    const { composeOverlayVideo } = await import("../../video/composer.js");
    outputFile = composeOverlayVideo({
      jobId,
      backgroundVideo: bgSubclip,
      imageFiles,
      audioFiles: ttsResult.files,
      durations: ttsResult.durations,
      template: templateTyped,
    });
  } else {
    // Slideshow mode (original, backward-compatible)
    const { generateNarration } = await import("../../video/tts.js");
    const audioFile = join(workDir, "narration.mp3");
    const fullText = script.scenes.map((s) => s.text).join(". ");
    const audioPath = await generateNarration(
      fullText,
      audioFile,
      language,
      options?.voice,
    );

    updateJob(jobId, {
      assets_json: JSON.stringify({
        audio: audioPath,
        images: imageFiles,
        subtitles: subtitleFile,
      }),
    });

    updateJob(jobId, { status: "composing" });
    const { composeVideo } = await import("../../video/composer.js");
    outputFile = composeVideo({
      jobId,
      script,
      imageFiles,
      audioFile: audioPath,
      subtitleFile,
      template: templateTyped,
    });
  }

  updateJob(jobId, {
    status: "completed",
    output_file: outputFile,
    completed_at: new Date().toISOString(),
  });

  console.log(`[video] Job ${jobId} completed (${mode}): ${outputFile}`);
}

// ---------------------------------------------------------------------------
// video_status
// ---------------------------------------------------------------------------

export const videoStatusTool: Tool = {
  name: "video_status",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "video_status",
      description: `Check the status of a video production job.

USE WHEN:
- After calling video_create, to check if the video is ready
- User asks "ya está mi video?"

Returns: status, output file path (when completed), or error message (when failed).`,
      parameters: {
        type: "object",
        properties: {
          job_id: {
            type: "string",
            description: "The job ID returned by video_create",
          },
        },
        required: ["job_id"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const jobId = args.job_id as string;
    if (!jobId) return JSON.stringify({ error: "job_id is required" });

    const job = getJob(jobId);
    if (!job) return JSON.stringify({ error: `Job ${jobId} not found` });

    const result: Record<string, unknown> = {
      jobId: job.job_id,
      status: job.status,
      topic: job.topic,
      duration: job.duration_seconds,
      template: job.template,
      createdAt: toMexTime(job.created_at),
    };

    if (job.output_file) result.outputFile = job.output_file;
    if (job.error_message) result.error = job.error_message;
    if (job.completed_at) result.completedAt = toMexTime(job.completed_at);

    return JSON.stringify(result);
  },
};

// ---------------------------------------------------------------------------
// video_script — script-only generation
// ---------------------------------------------------------------------------

export const videoScriptTool: Tool = {
  name: "video_script",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "video_script",
      description: `Generate a video script without rendering. For previewing/editing before committing to a full render.

USE WHEN:
- User wants to see the script before creating the video
- Planning video content structure`,
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "Video topic" },
          duration: {
            type: "number",
            description: "Duration in seconds (default: 60)",
          },
          language: { type: "string", description: "Language (default: es)" },
        },
        required: ["topic"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const topic = args.topic as string;
    if (!topic) return JSON.stringify({ error: "topic is required" });

    const duration = Math.min(120, Math.max(15, Number(args.duration) || 60));
    const language = (args.language as string) || "es";

    try {
      const { generateScript } =
        await import("../../video/script-generator.js");
      const script = await generateScript(topic, duration, language);
      return JSON.stringify(script, null, 2);
    } catch (err) {
      return JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
};

// ---------------------------------------------------------------------------
// video_tts — standalone TTS
// ---------------------------------------------------------------------------

export const videoTtsTool: Tool = {
  name: "video_tts",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "video_tts",
      description: `Generate narration audio from text using TTS (v6.2 V1).

USE WHEN:
- Need a voice-over audio file from text
- Testing narration before full video render

Supports 324 edge-tts voices. Use video_list_voices to see available options.
Long texts (>2000 chars) are automatically split at sentence boundaries with silence gaps.`,
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to convert to speech" },
          language: {
            type: "string",
            description:
              "Language code (default: es). Used to select default voice if voice not specified.",
          },
          voice: {
            type: "string",
            description:
              "Edge-tts voice name (e.g. es-MX-DaliaNeural, en-US-BrianNeural). Use video_list_voices to see options.",
          },
        },
        required: ["text"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const text = args.text as string;
    if (!text) return JSON.stringify({ error: "text is required" });

    const language = (args.language as string) || "es";
    const voice = args.voice as string | undefined;
    const outputPath = join("/tmp", `tts-${Date.now()}.mp3`);

    try {
      const { generateNarration, probeAudioDuration } =
        await import("../../video/tts.js");
      const path = await generateNarration(text, outputPath, language, voice);
      const duration = probeAudioDuration(path);
      return JSON.stringify({
        path,
        duration_seconds: Math.round(duration * 10) / 10,
        voice:
          voice ??
          (language === "es" ? "es-MX-DaliaNeural" : "en-US-AriaNeural"),
        text: text.slice(0, 100),
      });
    } catch (err) {
      return JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
};

export const videoListVoicesTool: Tool = {
  name: "video_list_voices",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "video_list_voices",
      description: `List available TTS voices for video narration.

USE WHEN:
- User wants to hear available voice options
- Choosing a voice for video_tts or video_create

Returns voice names, genders, and locales. Filter by language to narrow results.`,
      parameters: {
        type: "object",
        properties: {
          language: {
            type: "string",
            description:
              "Language filter prefix (e.g. 'es' for Spanish, 'en' for English). Omit to list all 324 voices.",
          },
        },
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    try {
      const { listVoices } = await import("../../video/tts.js");
      const language = args.language as string | undefined;
      const voices = listVoices(language);
      if (voices.length === 0) {
        return JSON.stringify({
          error: "No voices found. Is edge-tts installed?",
        });
      }
      return JSON.stringify({
        count: voices.length,
        filter: language ?? "all",
        voices: voices.map((v) => `${v.name} (${v.gender})`),
      });
    } catch (err) {
      return JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
};

// ---------------------------------------------------------------------------
// video_image — standalone image fetch
// ---------------------------------------------------------------------------

export const videoImageTool: Tool = {
  name: "video_image",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "video_image",
      description: `Fetch a stock image from Pexels for a given query.

USE WHEN:
- Need a stock image for a specific concept
- Testing image queries before full video render`,
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Search query (e.g. 'artificial intelligence technology')",
          },
        },
        required: ["query"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const query = args.query as string;
    if (!query) return JSON.stringify({ error: "query is required" });

    const outputPath = join("/tmp", `image-${Date.now()}.jpg`);

    try {
      const { fetchImage } = await import("../../video/images.js");
      const path = await fetchImage(query, outputPath);
      return JSON.stringify({ path, query });
    } catch (err) {
      return JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
};

// ---------------------------------------------------------------------------
// video_list_profiles — static data
// ---------------------------------------------------------------------------

export const videoListProfilesTool: Tool = {
  name: "video_list_profiles",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "video_list_profiles",
      description: `List available video render profiles (aspect ratios and resolutions).

USE WHEN:
- User asks what video formats are available
- Before creating a video, to show options`,
      parameters: { type: "object", properties: {} },
    },
  },

  async execute(): Promise<string> {
    return JSON.stringify(VIDEO_PROFILES, null, 2);
  },
};

// ---------------------------------------------------------------------------
// video_background_download — background media library (v6.2 V2)
// ---------------------------------------------------------------------------

export const videoBackgroundDownloadTool: Tool = {
  name: "video_background_download",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "video_background_download",
      description: `Download and cache a background video for overlay composition.

USE WHEN:
- Preparing background footage for a video with overlay mode
- Pre-caching backgrounds before a batch of video renders

Available backgrounds: ocean-waves, city-timelapse, abstract-particles, nature-forest, clouds-sky.
Or provide a custom Pexels/YouTube URL.

Videos are cached in /tmp/video-backgrounds/ — subsequent calls for the same name skip the download.`,
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "Background name from catalog (ocean-waves, city-timelapse, abstract-particles, nature-forest, clouds-sky) or a custom name for URL downloads.",
          },
          url: {
            type: "string",
            description:
              "Custom video URL (Pexels or YouTube). Not needed if using a catalog name.",
          },
        },
        required: ["name"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const name = args.name as string;
    if (!name) return JSON.stringify({ error: "name is required" });

    try {
      const {
        BACKGROUND_CATALOG,
        downloadBackground,
        listCachedBackgrounds,
        isCached,
      } = await import("../../video/backgrounds.js");

      // Check catalog first
      const catalogEntry = BACKGROUND_CATALOG.find(
        (e: { name: string }) => e.name === name,
      );
      const url = (args.url as string) ?? catalogEntry?.url;
      const credit = catalogEntry?.credit ?? "Custom";

      if (!url) {
        // List available backgrounds
        const cached = listCachedBackgrounds();
        return JSON.stringify({
          error: `Background "${name}" not in catalog and no URL provided.`,
          catalog: BACKGROUND_CATALOG.map(
            (e: { name: string; description: string }) =>
              `${e.name}: ${e.description}`,
          ),
          cached: cached.map(
            (c: { name: string; durationSeconds: number }) =>
              `${c.name} (${Math.round(c.durationSeconds)}s)`,
          ),
        });
      }

      if (isCached(name)) {
        return JSON.stringify({
          status: "already_cached",
          name,
          message: "Background already downloaded and cached.",
        });
      }

      const result = downloadBackground(name, url, credit);
      if (!result) {
        return JSON.stringify({
          error: `Failed to download background "${name}". Check the URL.`,
        });
      }

      return JSON.stringify({
        status: "downloaded",
        name: result.name,
        duration_seconds: Math.round(result.durationSeconds),
        credit: result.credit,
        path: result.filePath,
      });
    } catch (err) {
      return JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
};

// ---------------------------------------------------------------------------
// v7.4 S1 — video_transition_preview
// ---------------------------------------------------------------------------

export const videoTransitionPreviewTool: Tool = {
  name: "video_transition_preview",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "video_transition_preview",
      description: `Render a 2-second sample MP4 demonstrating a named transition between two solid-color test cards.

USE WHEN:
- User wants to see what a specific transition looks like
- Comparing transitions before committing to one in a storyboard

Available transitions: fade, wipeleft, wiperight, circleopen, circlecrop, pixelize, dissolve, radial (8 native ffmpeg xfade);
plus domain-warp, ridged-burn, gravitational-lens, chromatic-radial-split, sdf-iris, rgb-displacement (6 GL-only, fall back to dissolve until v7.4.4).

Returns the path to a small MP4 under /tmp/video-previews/.`,
      parameters: {
        type: "object",
        properties: {
          transition: {
            type: "string",
            enum: [...TRANSITION_NAMES],
            description: "Transition name",
          },
          duration: {
            type: "number",
            description:
              "Transition duration in seconds (default 1.0, range 0.2–3.0)",
          },
        },
        required: ["transition"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const transition = args.transition as TransitionName;
    if (!transition) return JSON.stringify({ error: "transition is required" });
    const rawDur = Number(args.duration ?? 1.0);
    const duration = Math.max(
      0.2,
      Math.min(3.0, Number.isFinite(rawDur) ? rawDur : 1.0),
    );

    let outPath: string | null = null;
    try {
      const spec = resolveTransition(transition, duration, 1.0);
      const outDir = join("/tmp", "video-previews");
      mkdirSync(outDir, { recursive: true });
      outPath = join(outDir, `transition-${transition}-${Date.now()}.mp4`);

      // Build filter: two 2-second colour cards crossfaded with the resolved xfade.
      const filter = `color=c=red:s=320x180:r=24:d=2[a];color=c=blue:s=320x180:r=24:d=2[b];[a][b]${spec.filterExpr},format=yuv420p[v]`;
      execFileSync(
        "ffmpeg",
        [
          "-y",
          "-f",
          "lavfi",
          "-i",
          "color=c=red:s=320x180:r=24:d=2",
          "-f",
          "lavfi",
          "-i",
          "color=c=blue:s=320x180:r=24:d=2",
          "-filter_complex",
          filter,
          "-map",
          "[v]",
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-pix_fmt",
          "yuv420p",
          outPath,
        ],
        { timeout: 30_000, stdio: "pipe" },
      );

      return JSON.stringify({
        path: outPath,
        transition,
        xfadeName: spec.xfadeName,
        native: spec.native,
        duration_seconds: duration,
      });
    } catch (err) {
      // Clean up partial/orphan MP4 on timeout or ffmpeg error — prevents
      // /tmp/video-previews/ bloat across repeated failures.
      if (outPath) {
        try {
          rmSync(outPath, { force: true });
        } catch {
          /* non-fatal */
        }
      }
      return JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
};

// ---------------------------------------------------------------------------
// v7.4 S1 — video_compose_manifest
// ---------------------------------------------------------------------------

const MAX_MANIFEST_JSON_BYTES = 256 * 1024; // 256 KB

export const videoComposeManifestTool: Tool = {
  name: "video_compose_manifest",
  requiresConfirmation: true,
  riskTier: "medium",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "video_compose_manifest",
      description: `Compose a video from a structured VideoCompositionManifest (engine-agnostic). Prefer this over video_create when you already have a structured scene list.

USE WHEN:
- Caller already has a VideoCompositionManifest (pre-authored or emitted by a storyboard pipeline)
- User wants fine control over scene count, durations, transitions, brand profile

Requires confirmation (cost-bearing). Returns a job_id to track with video_status.`,
      parameters: {
        type: "object",
        properties: {
          manifest: {
            type: "object",
            description:
              "A full VideoCompositionManifest object (version, title, template, fps, scenes[], language). Must be ≤256KB JSON-serialized.",
          },
        },
        required: ["manifest"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const manifest = args.manifest as VideoCompositionManifest | undefined;
    if (!manifest || typeof manifest !== "object") {
      return JSON.stringify({ error: "manifest is required" });
    }

    // Cheap pre-check before stringify (M2 — avoid CPU on hostile scene arrays)
    if (
      Array.isArray((manifest as { scenes?: unknown }).scenes) &&
      (manifest as { scenes: unknown[] }).scenes.length > 150
    ) {
      return JSON.stringify({
        error: "manifest scene count exceeds hard cap of 150",
      });
    }

    let manifestJson: string;
    try {
      manifestJson = JSON.stringify(manifest);
    } catch {
      return JSON.stringify({ error: "manifest is not JSON-serializable" });
    }
    if (Buffer.byteLength(manifestJson, "utf8") > MAX_MANIFEST_JSON_BYTES) {
      return JSON.stringify({
        error: `manifest exceeds ${MAX_MANIFEST_JSON_BYTES} bytes cap`,
      });
    }

    try {
      validateManifest(manifest);
    } catch (err) {
      return JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Concurrency gate — reuse same MAX_CONCURRENT_JOBS as video_create
    const activeCount = (
      getDatabase()
        .prepare(
          "SELECT COUNT(*) as cnt FROM video_jobs WHERE status IN ('scripting','generating_assets','composing')",
        )
        .get() as { cnt: number }
    ).cnt;
    if (activeCount >= MAX_CONCURRENT_JOBS) {
      return JSON.stringify({
        error: `Too many active video jobs (${activeCount}/${MAX_CONCURRENT_JOBS}). Wait for current jobs to finish.`,
      });
    }

    const jobId = randomUUID().slice(0, 8);
    const totalDuration = manifest.scenes.reduce(
      (acc, s) => acc + s.durationSec,
      0,
    );
    const db = getDatabase();
    const expiresAt = new Date(Date.now() + 24 * 3600_000).toISOString();

    writeWithRetry(() =>
      db
        .prepare(
          `INSERT INTO video_jobs (job_id, topic, duration_seconds, template, manifest_json, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          jobId,
          manifest.title,
          Math.round(totalDuration),
          manifest.template,
          manifestJson,
          expiresAt,
        ),
    );

    // Fire-and-forget pipeline from manifest — reuses runPipeline via a
    // manifest-aware adapter (see runManifestPipeline below).
    runManifestPipeline(jobId, manifest).catch((err) => {
      console.error(`[video] Manifest pipeline failed for ${jobId}:`, err);
      updateJob(jobId, {
        status: "failed",
        error_message: err instanceof Error ? err.message : String(err),
      });
    });

    return JSON.stringify({
      jobId,
      status: "pending",
      title: manifest.title,
      scene_count: manifest.scenes.length,
      total_duration_seconds: Math.round(totalDuration),
      message: `Manifest job ${jobId} started. Use video_status to check progress.`,
    });
  },
};

async function runManifestPipeline(
  jobId: string,
  manifest: VideoCompositionManifest,
): Promise<void> {
  const workDir = join("/tmp", "video-jobs", jobId);
  mkdirSync(workDir, { recursive: true });

  // Step 1: Convert manifest scenes into a VideoScript shape (reuse slideshow path)
  updateJob(jobId, { status: "scripting" });
  const script = {
    title: manifest.title,
    scenes: manifest.scenes.map((s) => ({
      text: s.text,
      duration: s.durationSec,
      imageQuery: s.imageQuery ?? manifest.title,
      transition: "fade" as const,
    })),
    totalDuration: manifest.scenes.reduce((acc, s) => acc + s.durationSec, 0),
    language: manifest.language,
  };
  updateJob(jobId, { script_json: JSON.stringify(script) });

  // Step 2: Generate assets
  updateJob(jobId, { status: "generating_assets" });
  const { fetchImage } = await import("../../video/images.js");
  const { generateSubtitles } = await import("../../video/subtitles.js");

  const subtitleFile = join(workDir, "subtitles.srt");

  await Promise.all(
    manifest.scenes.map((scene, i) =>
      scene.imagePath
        ? Promise.resolve(scene.imagePath)
        : fetchImage(
            scene.imageQuery ?? manifest.title,
            join(workDir, `scene-${String(i).padStart(3, "0")}.jpg`),
            manifest.template === "portrait" ? 1080 : 1920,
            manifest.template === "portrait" ? 1920 : 1080,
          ),
    ),
  );
  const imageFiles = manifest.scenes.map(
    (s, i) =>
      s.imagePath ?? join(workDir, `scene-${String(i).padStart(3, "0")}.jpg`),
  );

  generateSubtitles(script, subtitleFile);

  const { generateNarration } = await import("../../video/tts.js");
  const audioFile = join(workDir, "narration.mp3");
  const fullText = manifest.scenes.map((s) => s.text).join(". ");
  const audioPath = await generateNarration(
    fullText,
    audioFile,
    manifest.language,
    manifest.voice,
  );

  updateJob(jobId, {
    assets_json: JSON.stringify({
      audio: audioPath,
      images: imageFiles,
      subtitles: subtitleFile,
    }),
  });

  updateJob(jobId, { status: "composing" });
  const { composeVideo } = await import("../../video/composer.js");
  const outputFile = composeVideo({
    jobId,
    script,
    imageFiles,
    audioFile: audioPath,
    subtitleFile,
    template: manifest.template,
  });

  updateJob(jobId, {
    status: "completed",
    output_file: outputFile,
    completed_at: new Date().toISOString(),
  });

  console.log(`[video] Manifest job ${jobId} completed: ${outputFile}`);
}

// ---------------------------------------------------------------------------
// v7.4 S1 — video_job_cancel
// ---------------------------------------------------------------------------

export const videoJobCancelTool: Tool = {
  name: "video_job_cancel",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "video_job_cancel",
      description: `Mark a video job as cancelled. NOTE: currently only marks the DB row — does NOT yet kill the underlying ffmpeg child (v7.4 S1 limitation). Running ffmpeg processes will complete or time out at the 2-min ffmpeg-step cap. Pid-kill wiring lands in v7.4 S1.1 when the composer is migrated from execFileSync to spawn.

USE WHEN:
- User asks to stop a video render (note the caveat above)
- A job is stuck in a non-terminal state (scripting/generating_assets/composing) and the operator wants the DB row marked cancelled

No-op if the job is already completed/failed/cancelled. Returns {ok:false} if the job does not exist.`,
      parameters: {
        type: "object",
        properties: {
          job_id: {
            type: "string",
            description:
              "The job ID returned by video_create or video_compose_manifest",
          },
        },
        required: ["job_id"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const jobId = args.job_id as string;
    if (!jobId) return JSON.stringify({ error: "job_id is required" });

    const row = getJob(jobId) as
      | (VideoJobRow & { ffmpeg_pid: number | null })
      | undefined;
    if (!row)
      return JSON.stringify({ ok: false, error: `Job ${jobId} not found` });

    const terminalStates = new Set(["completed", "failed", "cancelled"]);
    if (terminalStates.has(row.status)) {
      return JSON.stringify({
        ok: true,
        alreadyTerminal: true,
        status: row.status,
      });
    }

    // Attempt to kill ffmpeg pid if present (SIGTERM, non-fatal on failure)
    let killed = false;
    const pid = row.ffmpeg_pid;
    if (typeof pid === "number" && pid > 0) {
      try {
        process.kill(pid, "SIGTERM");
        killed = true;
      } catch {
        // process may have exited already — non-fatal
      }
    }

    updateJob(jobId, {
      status: "cancelled",
      error_message: "Cancelled by operator",
      completed_at: new Date().toISOString(),
    });

    return JSON.stringify({
      ok: true,
      jobId,
      pid_killed: killed,
      cancelled_at: new Date().toISOString(),
    });
  },
};

// ---------------------------------------------------------------------------
// v7.4 S1 — video_job_cleanup
// ---------------------------------------------------------------------------

export const videoJobCleanupTool: Tool = {
  name: "video_job_cleanup",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "video_job_cleanup",
      description: `Remove expired/terminal video job working directories and DB rows. Ops hygiene — frees disk space.

USE WHEN:
- Operator wants to reclaim disk
- Disk is tight and /tmp/video-jobs/ has many leftover directories

Default: removes jobs that are completed/failed/cancelled AND older than 24h. Returns counts.`,
      parameters: {
        type: "object",
        properties: {
          older_than_hours: {
            type: "number",
            description:
              "Only remove jobs older than this (default 24, min 1, max 720)",
          },
        },
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const raw = Number(args.older_than_hours ?? 24);
    if (!Number.isFinite(raw) || raw < 1 || raw > 720) {
      return JSON.stringify({
        error: "older_than_hours must be a finite number in [1, 720]",
      });
    }
    const hours = Math.floor(raw);

    const db = getDatabase();
    const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();

    const candidates = db
      .prepare(
        `SELECT job_id FROM video_jobs
         WHERE status IN ('completed','failed','cancelled')
           AND (completed_at IS NULL OR completed_at < ?)`,
      )
      .all(cutoff) as Array<{ job_id: string }>;

    let removedCount = 0;
    let bytesFreed = 0;

    // Defense-in-depth: reject job_ids that could escape /tmp/video-jobs/
    // even though createJob currently always writes UUID slices.
    const SAFE_JOB_ID = /^[a-f0-9-]{4,36}$/;

    for (const { job_id } of candidates) {
      if (!SAFE_JOB_ID.test(job_id)) continue;
      const workDir = join("/tmp", "video-jobs", job_id);
      if (existsSync(workDir)) {
        try {
          // Tally bytes (best-effort; skip if fails)
          try {
            const stat = execFileSync("du", ["-sb", workDir], {
              encoding: "utf-8",
              timeout: 5_000,
            });
            const match = stat.match(/^(\d+)/);
            if (match) bytesFreed += parseInt(match[1], 10);
          } catch {
            /* non-fatal */
          }
          rmSync(workDir, { recursive: true, force: true });
        } catch {
          /* non-fatal */
        }
      }
      try {
        db.prepare("DELETE FROM video_jobs WHERE job_id = ?").run(job_id);
        removedCount++;
      } catch {
        /* non-fatal */
      }
    }

    return JSON.stringify({
      older_than_hours: hours,
      removed_count: removedCount,
      bytes_freed: bytesFreed,
    });
  },
};
