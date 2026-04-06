/**
 * Video production tools — S5d.
 * 6 tools: video_create, video_status, video_script, video_tts, video_image, video_list_profiles.
 */

import { randomUUID } from "crypto";
import { mkdirSync } from "fs";
import { join } from "path";
import type { Tool } from "../types.js";
import { getDatabase, writeWithRetry } from "../../db/index.js";
import type { VideoJobRow } from "../../video/types.js";
import { VIDEO_PROFILES } from "../../video/types.js";

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
  definition: {
    type: "function",
    function: {
      name: "video_create",
      description: `Create a video from a topic description. Full pipeline: script → TTS → images → compose → MP4.

USE WHEN:
- User asks "hazme un video sobre..."
- User wants a video explainer, presentation, or content piece

Requires confirmation before starting. Returns a job ID to check progress with video_status.
Duration: 15-120 seconds. Template: landscape (YouTube), portrait (TikTok/Reels), square (Instagram).`,
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
    const jobId = randomUUID().slice(0, 8);

    createJob(jobId, topic, duration, template);

    // Run pipeline async (don't block the tool response)
    runPipeline(jobId, topic, duration, template, language).catch((err) => {
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
): Promise<void> {
  const workDir = join("/tmp", "video-jobs", jobId);
  mkdirSync(workDir, { recursive: true });

  // Step 1: Generate script
  updateJob(jobId, { status: "scripting" });
  const { generateScript } = await import("../../video/script-generator.js");
  const script = await generateScript(topic, duration, language);
  updateJob(jobId, { script_json: JSON.stringify(script) });

  // Step 2: Generate assets in parallel
  updateJob(jobId, { status: "generating_assets" });
  const { generateNarration } = await import("../../video/tts.js");
  const { fetchImage } = await import("../../video/images.js");
  const { generateSubtitles } = await import("../../video/subtitles.js");

  const audioFile = join(workDir, "narration.mp3");
  const subtitleFile = join(workDir, "subtitles.srt");

  // Full narration text
  const fullText = script.scenes.map((s) => s.text).join(". ");

  const [audioPath, , subtitlePath] = await Promise.all([
    generateNarration(fullText, audioFile, language),
    // Fetch images for each scene
    Promise.all(
      script.scenes.map((scene, i) =>
        fetchImage(
          scene.imageQuery,
          join(workDir, `scene-${String(i).padStart(3, "0")}.jpg`),
          template === "portrait" ? 1080 : 1920,
          template === "portrait" ? 1920 : 1080,
        ),
      ),
    ),
    Promise.resolve(generateSubtitles(script, subtitleFile)),
  ]);

  const imageFiles = script.scenes.map((_, i) =>
    join(workDir, `scene-${String(i).padStart(3, "0")}.jpg`),
  );

  updateJob(jobId, {
    assets_json: JSON.stringify({
      audio: audioPath,
      images: imageFiles,
      subtitles: subtitlePath,
    }),
  });

  // Step 3: Compose video
  updateJob(jobId, { status: "composing" });
  const { composeVideo } = await import("../../video/composer.js");
  const outputFile = composeVideo({
    jobId,
    script,
    imageFiles,
    audioFile: audioPath,
    subtitleFile: subtitlePath,
    template: template as "landscape" | "portrait" | "square",
  });

  updateJob(jobId, {
    status: "completed",
    output_file: outputFile,
    completed_at: new Date().toISOString(),
  });

  console.log(`[video] Job ${jobId} completed: ${outputFile}`);
}

// ---------------------------------------------------------------------------
// video_status
// ---------------------------------------------------------------------------

export const videoStatusTool: Tool = {
  name: "video_status",
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
      createdAt: job.created_at,
    };

    if (job.output_file) result.outputFile = job.output_file;
    if (job.error_message) result.error = job.error_message;
    if (job.completed_at) result.completedAt = job.completed_at;

    return JSON.stringify(result);
  },
};

// ---------------------------------------------------------------------------
// video_script — script-only generation
// ---------------------------------------------------------------------------

export const videoScriptTool: Tool = {
  name: "video_script",
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
