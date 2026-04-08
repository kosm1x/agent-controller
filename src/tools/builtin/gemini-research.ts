/**
 * Gemini Research Tools — document analysis, grounded Q&A, and podcast generation.
 *
 * Three tools:
 *   1. gemini_upload    — Upload documents to Gemini Files API (48h persistence)
 *   2. gemini_research  — Deep document analysis (Q&A, summaries, study guides, etc.)
 *   3. gemini_audio_overview — Podcast-style audio overview with two AI hosts
 *
 * All use raw fetch (no SDK), API key auth (env or user_facts), and
 * track uploaded files in SQLite for cross-tool referencing.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, basename, extname } from "node:path";
import type { Tool } from "../types.js";
import { getUserFacts } from "../../db/user-facts.js";
import {
  ensureGeminiFilesTable,
  upsertGeminiFile,
  updateGeminiFileState,
  listActiveGeminiFiles,
  getGeminiFile,
  cleanupExpiredGeminiFiles,
  type GeminiFileRow,
} from "../../db/gemini-files.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE = "https://generativelanguage.googleapis.com";
const UPLOAD_URL = `${API_BASE}/upload/v1beta/files`;
const GENERATE_URL = (model: string) =>
  `${API_BASE}/v1beta/models/${model}:generateContent`;
const FILE_GET_URL = (name: string) => `${API_BASE}/v1beta/${name}`;

const DEFAULT_MODEL = "gemini-2.5-flash";
const TTS_MODEL = "gemini-2.5-flash-preview-tts";
const AUDIO_DIR = "/tmp/gemini_audio";

const UPLOAD_TIMEOUT_MS = 120_000;
const GENERATE_TIMEOUT_MS = 180_000;
const TTS_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 2_000;
const POLL_MAX_MS = 60_000;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function getApiKey(): string | null {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  try {
    const facts = getUserFacts("projects");
    const fact = facts.find((f) => f.key === "gemini_api_key");
    if (fact) return fact.value;
  } catch {
    /* DB not ready */
  }
  return null;
}

const MIME_MAP: Record<string, string> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
  ".csv": "text/csv",
  ".json": "application/json",
  ".xml": "application/xml",
  ".js": "text/javascript",
  ".ts": "text/x-typescript",
  ".py": "text/x-python",
  ".go": "text/x-go",
  ".java": "text/x-java-source",
  ".c": "text/x-c",
  ".cpp": "text/x-c++src",
  ".rs": "text/x-rust",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".webm": "video/webm",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function detectMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return MIME_MAP[ext] ?? "application/octet-stream";
}

async function pollFileState(
  apiKey: string,
  fileName: string,
): Promise<{ state: string; uri: string }> {
  const deadline = Date.now() + POLL_MAX_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    try {
      const resp = await fetch(`${FILE_GET_URL(fileName)}?key=${apiKey}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) continue;
      const data = (await resp.json()) as Record<string, unknown>;
      const state = data.state as string;
      if (state === "ACTIVE" || state === "FAILED") {
        return { state, uri: (data.uri as string) ?? "" };
      }
    } catch {
      /* retry */
    }
  }
  return { state: "TIMEOUT", uri: "" };
}

function writeWavHeader(
  pcm: Buffer,
  sampleRate: number,
  channels: number,
  bitsPerSample: number,
): Buffer {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // subchunk1 size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function resolveFiles(fileNames: string[] | undefined): GeminiFileRow[] {
  ensureGeminiFilesTable();
  cleanupExpiredGeminiFiles();

  if (!fileNames || fileNames.length === 0) {
    return listActiveGeminiFiles();
  }

  const results: GeminiFileRow[] = [];
  for (const name of fileNames) {
    const file = getGeminiFile(name);
    if (
      file &&
      file.state === "ACTIVE" &&
      file.expires_at > new Date().toISOString()
    ) {
      results.push(file);
    }
  }
  return results;
}

/** Format-specific system instructions for gemini_research. */
const FORMAT_INSTRUCTIONS: Record<string, string> = {
  answer:
    "Answer the following question about the provided documents. Be thorough and cite specific sections, page numbers, or passages from the source material when possible.",
  summary:
    "Provide a comprehensive executive summary of the provided documents. Cover the main themes, key findings, conclusions, and implications. Use clear section headers.",
  study_guide:
    "Create a detailed study guide covering all key concepts, definitions, important details, and relationships between ideas in the provided documents. Include section headers, bullet points, and highlight critical terms.",
  briefing:
    "Create a concise 1-page briefing suitable for an executive audience. Lead with the bottom line, then supporting evidence. Use bullet points. Maximum 500 words.",
  quiz: "Generate 10 comprehension questions with answers based on the provided documents. Mix question types: multiple choice, short answer, and true/false. Include the source passage for each answer.",
  flashcards:
    "Generate 20 flashcard pairs for spaced-repetition study. Format each as:\n\nQ: [question]\nA: [answer]\n\nCover key concepts, definitions, dates, and relationships from the documents.",
  outline:
    "Create a detailed hierarchical outline capturing the structure and key points of the provided documents. Use Roman numerals (I, II, III) for top-level sections, letters (A, B, C) for subsections, and numbers (1, 2, 3) for details.",
};

// ---------------------------------------------------------------------------
// Tool 1: gemini_upload
// ---------------------------------------------------------------------------

export const geminiUploadTool: Tool = {
  name: "gemini_upload",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "gemini_upload",
      description: `Upload a document to Gemini for research and analysis. Returns a file reference for use with gemini_research and gemini_audio_overview.

USE WHEN:
- The user wants to analyze, summarize, or ask questions about a document (PDF, text, code, audio, video)
- The user shares a file path or URL and says "analyze this", "study this", "investigate this document"
- Preparing documents for gemini_research or gemini_audio_overview
- The user says "sube este documento", "analiza este archivo", "carga esto para investigar"

WHEN NOT TO USE:
- For simple PDF reading (use pdf_read instead — faster, no upload needed)
- For images to generate (use gemini_image instead)
- When the user just wants to read a web page (use web_read)

BEHAVIOR:
- Uploads to Gemini Files API (files persist 48 hours, then auto-expire)
- Tracks uploads in a local database so gemini_research can reference them
- Supports: PDF, TXT, MD, code files, images (PNG/JPG/WEBP), audio (MP3/WAV/OGG), video (MP4/MOV)
- Source can be a local file path OR a URL (file will be downloaded first)
- Returns the file name for use in subsequent gemini_research calls

EDGE CASES:
- Max file size: 2GB via resumable upload; most documents are well under this
- Files expire after 48h — re-upload if needed after expiration
- Processing may take a few seconds for large files (auto-polled)`,
      parameters: {
        type: "object",
        properties: {
          source: {
            type: "string",
            description:
              "Local file path (/path/to/document.pdf) or URL (https://example.com/report.pdf) of the document to upload.",
          },
          display_name: {
            type: "string",
            description:
              "Human-readable name for this document. Defaults to the filename if omitted.",
          },
        },
        required: ["source"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const apiKey = getApiKey();
    if (!apiKey) {
      return JSON.stringify({
        success: false,
        error:
          "No Gemini API key. Set GEMINI_API_KEY env var or store via user_fact_set (category: projects, key: gemini_api_key).",
      });
    }

    const source = args.source as string;
    let displayName = (args.display_name as string) ?? "";
    let filePath: string;

    // Download URL to /tmp if needed
    if (source.startsWith("http://") || source.startsWith("https://")) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
        const resp = await fetch(source, { signal: controller.signal });
        clearTimeout(timer);
        if (!resp.ok) {
          return JSON.stringify({
            success: false,
            error: `Failed to download ${source}: HTTP ${resp.status}`,
          });
        }
        const buf = Buffer.from(await resp.arrayBuffer());
        const urlFilename = basename(new URL(source).pathname) || "download";
        filePath = join("/tmp", `gemini-dl-${Date.now()}-${urlFilename}`);
        writeFileSync(filePath, buf);
        if (!displayName) displayName = urlFilename;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({
          success: false,
          error: msg.includes("aborted")
            ? `Download timed out after ${UPLOAD_TIMEOUT_MS / 1000}s`
            : `Download failed: ${msg}`,
        });
      }
    } else {
      filePath = source;
      if (!displayName) displayName = basename(source);
    }

    // Read file
    let fileBuffer: Buffer;
    try {
      fileBuffer = readFileSync(filePath);
    } catch (err) {
      return JSON.stringify({
        success: false,
        error: `Cannot read file: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    const mimeType = detectMimeType(filePath);

    // Build multipart/related upload
    const boundary = `----gemini${Date.now()}${Math.random().toString(36).slice(2)}`;
    const metadataJson = JSON.stringify({
      file: { displayName },
    });

    const parts: Buffer[] = [];
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadataJson}\r\n`,
      ),
    );
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    );
    parts.push(fileBuffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(parts);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);

    try {
      const resp = await fetch(`${UPLOAD_URL}?key=${apiKey}`, {
        method: "POST",
        headers: {
          "Content-Type": `multipart/related; boundary=${boundary}`,
          "Content-Length": String(body.length),
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);

      const data = (await resp.json()) as Record<string, unknown>;

      if (!resp.ok) {
        const error = data.error as Record<string, unknown> | undefined;
        return JSON.stringify({
          success: false,
          error: `Upload error ${resp.status}: ${(error?.message as string) ?? JSON.stringify(data).slice(0, 300)}`,
        });
      }

      const file = data.file as Record<string, unknown>;
      const name = file.name as string;
      let uri = file.uri as string;
      const state = file.state as string;
      const sizeBytes = (file.sizeBytes as number) ?? fileBuffer.length;
      const expiresAt =
        (file.expirationTime as string) ??
        new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

      // Poll if still processing
      let finalState = state;
      if (state === "PROCESSING") {
        const poll = await pollFileState(apiKey, name);
        finalState = poll.state;
        if (poll.uri) uri = poll.uri;
        if (finalState !== "ACTIVE") {
          updateGeminiFileState(name, finalState);
        }
      }

      // Track in SQLite
      upsertGeminiFile({
        name,
        displayName,
        uri,
        mimeType,
        sizeBytes,
        state: finalState,
        expiresAt,
      });

      return JSON.stringify({
        success: finalState === "ACTIVE",
        name,
        display_name: displayName,
        uri,
        mime_type: mimeType,
        size_bytes: sizeBytes,
        state: finalState,
        expires_at: expiresAt,
        note:
          finalState === "ACTIVE"
            ? "File ready. Use this name in gemini_research or gemini_audio_overview."
            : finalState === "TIMEOUT"
              ? "File still processing. Try gemini_research in a minute — it auto-checks state."
              : `File processing failed (state: ${finalState}).`,
      });
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({
        success: false,
        error: msg.includes("aborted")
          ? `Upload timed out after ${UPLOAD_TIMEOUT_MS / 1000}s`
          : `Upload failed: ${msg}`,
      });
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 2: gemini_research
// ---------------------------------------------------------------------------

export const geminiResearchTool: Tool = {
  name: "gemini_research",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "gemini_research",
      description: `Deep document analysis using Gemini AI with uploaded documents. Produces Q&A answers, summaries, study guides, briefings, quizzes, flashcards, or outlines.

USE WHEN:
- The user asks questions about previously uploaded documents (via gemini_upload)
- The user wants a summary, study guide, briefing, or outline from their documents
- The user says "qué dice el documento sobre...", "resume los documentos", "hazme un quiz", "prepárame flashcards"
- The user wants to cross-reference multiple uploaded documents
- Deep analysis that goes beyond what pdf_read provides (multi-doc Q&A, structured outputs)

WHEN NOT TO USE:
- No documents have been uploaded yet (tell user to upload first with gemini_upload)
- For simple single-page reading (use pdf_read or web_read)
- For image generation (use gemini_image)
- For podcast/audio generation (use gemini_audio_overview)

BEHAVIOR:
- References files by their Gemini name (from gemini_upload) or uses all active uploads when files omitted
- Uses Gemini 2.5 Flash (1M token context) by default — handles even very large documents
- format="answer" for Q&A, "summary" for executive summaries, "study_guide" for study material, "briefing" for concise briefings, "quiz" for comprehension tests, "flashcards" for spaced repetition cards, "outline" for structured outlines
- Automatically filters out expired files

EDGE CASES:
- If all referenced files have expired, returns an error asking user to re-upload
- The "model" parameter allows switching to gemini-2.5-pro for more complex analysis (costs more)`,
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "The research question or instruction. Be specific for best results. E.g., 'What are the key findings in chapter 3?' or 'Compare the methodologies used in both papers'.",
          },
          format: {
            type: "string",
            enum: [
              "answer",
              "summary",
              "study_guide",
              "briefing",
              "quiz",
              "flashcards",
              "outline",
            ],
            description:
              'Output format. Default: "answer". Use "summary" for executive summary, "study_guide" for study material, "briefing" for 1-page briefing, "quiz" for comprehension questions, "flashcards" for Q&A cards, "outline" for hierarchical outline.',
          },
          files: {
            type: "array",
            items: { type: "string" },
            description:
              "Gemini file names to analyze (from gemini_upload results). Omit or pass empty array to use ALL active uploads.",
          },
          model: {
            type: "string",
            enum: ["gemini-2.5-flash", "gemini-2.5-pro"],
            description:
              'Model to use. Default: "gemini-2.5-flash" (fast, cheap). Use "gemini-2.5-pro" for complex multi-document reasoning.',
          },
        },
        required: ["query"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const apiKey = getApiKey();
    if (!apiKey) {
      return JSON.stringify({
        success: false,
        error:
          "No Gemini API key. Set GEMINI_API_KEY env var or store via user_fact_set (category: projects, key: gemini_api_key).",
      });
    }

    const query = args.query as string;
    const format = (args.format as string) ?? "answer";
    const fileNames = args.files as string[] | undefined;
    const model = (args.model as string) ?? DEFAULT_MODEL;

    const files = resolveFiles(fileNames);
    if (files.length === 0) {
      return JSON.stringify({
        success: false,
        error:
          "No active files available. Upload documents first with gemini_upload.",
        files_available: 0,
      });
    }

    // Build content parts: file references + query
    const fileParts = files.map((f) => ({
      fileData: { fileUri: f.uri, mimeType: f.mime_type },
    }));

    const systemInstruction =
      FORMAT_INSTRUCTIONS[format] ?? FORMAT_INSTRUCTIONS.answer;

    const requestBody = {
      systemInstruction: {
        parts: [{ text: systemInstruction }],
      },
      contents: [
        {
          parts: [...fileParts, { text: query }],
        },
      ],
      generationConfig: {
        temperature: format === "answer" ? 0.3 : 0.5,
        maxOutputTokens: format === "briefing" ? 2048 : 8192,
      },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GENERATE_TIMEOUT_MS);

    try {
      const resp = await fetch(`${GENERATE_URL(model)}?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      clearTimeout(timer);

      const data = (await resp.json()) as Record<string, unknown>;

      if (!resp.ok) {
        const error = data.error as Record<string, unknown> | undefined;
        return JSON.stringify({
          success: false,
          error: `Gemini error ${resp.status}: ${(error?.message as string) ?? JSON.stringify(data).slice(0, 300)}`,
        });
      }

      const candidates = data.candidates as
        | Array<Record<string, unknown>>
        | undefined;
      if (!candidates?.length) {
        return JSON.stringify({
          success: false,
          error:
            "No response generated. The prompt may have been safety-filtered.",
        });
      }

      const content = candidates[0].content as Record<string, unknown>;
      const parts = content?.parts as Array<Record<string, unknown>>;
      const text = parts
        ?.map((p) => p.text as string)
        .filter(Boolean)
        .join("\n");

      const usage = data.usageMetadata as Record<string, unknown> | undefined;

      return JSON.stringify({
        success: true,
        format,
        model,
        files_used: files.map((f) => f.display_name),
        content: text || "(empty response)",
        tokens_used: usage?.totalTokenCount ?? null,
      });
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({
        success: false,
        error: msg.includes("aborted")
          ? `Timed out after ${GENERATE_TIMEOUT_MS / 1000}s. Try a shorter query or use gemini-2.5-flash.`
          : `Research failed: ${msg}`,
      });
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 3: gemini_audio_overview
// ---------------------------------------------------------------------------

const PODCAST_SYSTEM_PROMPT = (
  length: string,
  language: string,
  focus: string | undefined,
) => {
  const wordTargets: Record<string, number> = {
    brief: 1500,
    standard: 3000,
    deep: 6000,
  };
  const target = wordTargets[length] ?? 3000;
  const lang = language === "es" ? "Spanish" : "English";
  const focusLine = focus ? `\nFocus particularly on: ${focus}` : "";

  return `You are a podcast script writer. Create an engaging two-host podcast discussion about the provided documents.

HOSTS:
- Speaker A (Host): Leads the conversation, asks insightful questions, provides context
- Speaker B (Expert): Provides deeper analysis, shares interesting details, makes connections

RULES:
- Write in ${lang}
- Target approximately ${target} words total
- Make it conversational and engaging — this will be converted to audio
- Include natural transitions, reactions, and follow-up questions
- Cover the most important and interesting aspects of the documents
- End with key takeaways${focusLine}

OUTPUT FORMAT — Return ONLY valid JSON (no markdown fences):
{"turns":[{"speaker":"A","text":"..."},{"speaker":"B","text":"..."}]}`;
};

export const geminiAudioOverviewTool: Tool = {
  name: "gemini_audio_overview",
  requiresConfirmation: true,
  riskTier: "medium",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "gemini_audio_overview",
      description: `Generate a podcast-style audio overview from uploaded documents. Two AI hosts discuss the content in a natural, engaging conversation — similar to Google NotebookLM Audio Overviews.

USE WHEN:
- The user wants a podcast or audio summary of their documents
- The user says "hazme un podcast", "genera un audio overview", "quiero escuchar un resumen", "convierte esto en podcast"
- The user wants to learn document content by listening rather than reading
- After uploading documents with gemini_upload

WHEN NOT TO USE:
- No documents have been uploaded (tell user to upload first with gemini_upload)
- For simple text-to-speech of arbitrary text (this is for document-based podcast generation)
- For music or sound effects (use hf_generate)
- For document reading/Q&A (use gemini_research)

BEHAVIOR:
- Step 1: Analyzes documents and generates a two-host podcast script
- Step 2: Converts script to multi-speaker audio using Gemini TTS
- Returns an audio file path (WAV) and the transcript
- Length options: "brief" (~5 min), "standard" (~10 min), "deep" (~20 min)
- Audio is saved to /tmp/gemini_audio/ (persists until system cleanup)

EDGE CASES:
- Generation takes 30-120 seconds depending on length
- Audio is WAV format (24kHz, mono) — suitable for direct playback or upload
- If TTS fails, the script/transcript is still returned so the content isn't lost`,
      parameters: {
        type: "object",
        properties: {
          files: {
            type: "array",
            items: { type: "string" },
            description:
              "Gemini file names to cover in the podcast. Omit to use all active uploads.",
          },
          length: {
            type: "string",
            enum: ["brief", "standard", "deep"],
            description:
              'Podcast length. "brief" (~5 min), "standard" (~10 min, default), "deep" (~20 min).',
          },
          language: {
            type: "string",
            enum: ["en", "es"],
            description:
              'Podcast language. "en" for English (default), "es" for Spanish.',
          },
          focus: {
            type: "string",
            description:
              'Optional focus area or angle. E.g., "Focus on the practical implications" or "Emphasize the historical context".',
          },
        },
        required: [],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const apiKey = getApiKey();
    if (!apiKey) {
      return JSON.stringify({
        success: false,
        error:
          "No Gemini API key. Set GEMINI_API_KEY env var or store via user_fact_set (category: projects, key: gemini_api_key).",
      });
    }

    const fileNames = args.files as string[] | undefined;
    const length = (args.length as string) ?? "standard";
    const language = (args.language as string) ?? "en";
    const focus = args.focus as string | undefined;

    const files = resolveFiles(fileNames);
    if (files.length === 0) {
      return JSON.stringify({
        success: false,
        error:
          "No active files available. Upload documents first with gemini_upload.",
      });
    }

    // --- Step 1: Generate podcast script ---
    const fileParts = files.map((f) => ({
      fileData: { fileUri: f.uri, mimeType: f.mime_type },
    }));

    const scriptBody = {
      systemInstruction: {
        parts: [{ text: PODCAST_SYSTEM_PROMPT(length, language, focus) }],
      },
      contents: [
        {
          parts: [
            ...fileParts,
            {
              text: "Create a podcast discussion about these documents.",
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.8,
        maxOutputTokens: 16384,
        responseMimeType: "application/json",
      },
    };

    const scriptController = new AbortController();
    const scriptTimer = setTimeout(
      () => scriptController.abort(),
      GENERATE_TIMEOUT_MS,
    );

    let scriptText: string;
    let turns: Array<{ speaker: string; text: string }>;

    try {
      const resp = await fetch(`${GENERATE_URL(DEFAULT_MODEL)}?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(scriptBody),
        signal: scriptController.signal,
      });
      clearTimeout(scriptTimer);

      const data = (await resp.json()) as Record<string, unknown>;

      if (!resp.ok) {
        const error = data.error as Record<string, unknown> | undefined;
        return JSON.stringify({
          success: false,
          error: `Script generation failed (${resp.status}): ${(error?.message as string) ?? "Unknown error"}`,
        });
      }

      const candidates = data.candidates as
        | Array<Record<string, unknown>>
        | undefined;
      if (!candidates?.length) {
        return JSON.stringify({
          success: false,
          error: "No script generated. Content may have been safety-filtered.",
        });
      }

      const content = candidates[0].content as Record<string, unknown>;
      const parts = content?.parts as Array<Record<string, unknown>>;
      const rawText = parts
        ?.map((p) => p.text as string)
        .filter(Boolean)
        .join("");

      // Parse the JSON script
      if (!rawText) {
        return JSON.stringify({
          success: false,
          error:
            "No script content returned from Gemini. Content may have been safety-filtered.",
        });
      }
      const parsed = JSON.parse(rawText) as {
        turns: Array<{ speaker: string; text: string }>;
      };
      turns = parsed.turns;
      scriptText = turns.map((t) => `[${t.speaker}] ${t.text}`).join("\n\n");
    } catch (err) {
      clearTimeout(scriptTimer);
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({
        success: false,
        error: msg.includes("aborted")
          ? `Script generation timed out after ${GENERATE_TIMEOUT_MS / 1000}s`
          : `Script generation failed: ${msg}`,
      });
    }

    // --- Step 2: TTS with multi-speaker voices ---
    // Build the script text with speaker tags for multi-speaker TTS
    const ttsText = turns
      .map((t) => `<speaker name="${t.speaker}">${t.text}</speaker>`)
      .join("\n");

    const ttsBody = {
      contents: [{ parts: [{ text: ttsText }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          multiSpeakerVoiceConfig: {
            speakerVoiceConfigs: [
              {
                speaker: "A",
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: "Kore" },
                },
              },
              {
                speaker: "B",
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: "Puck" },
                },
              },
            ],
          },
        },
      },
    };

    const ttsController = new AbortController();
    const ttsTimer = setTimeout(() => ttsController.abort(), TTS_TIMEOUT_MS);

    try {
      const resp = await fetch(`${GENERATE_URL(TTS_MODEL)}?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ttsBody),
        signal: ttsController.signal,
      });
      clearTimeout(ttsTimer);

      const data = (await resp.json()) as Record<string, unknown>;

      if (!resp.ok) {
        const error = data.error as Record<string, unknown> | undefined;
        return JSON.stringify({
          success: false,
          transcript: scriptText,
          files_used: files.map((f) => f.display_name),
          error: `TTS failed (${resp.status}): ${(error?.message as string) ?? "Unknown error"}`,
          note: "Script generated but TTS failed. Transcript available above.",
        });
      }

      const candidates = data.candidates as
        | Array<Record<string, unknown>>
        | undefined;
      if (!candidates?.length) {
        return JSON.stringify({
          success: false,
          transcript: scriptText,
          files_used: files.map((f) => f.display_name),
          error: "TTS returned no audio data.",
          note: "Script generated but TTS failed. Transcript available above.",
        });
      }

      const content = candidates[0].content as Record<string, unknown>;
      const parts = content?.parts as Array<Record<string, unknown>>;
      const audioPart = parts?.find((p) => p.inlineData);
      if (!audioPart) {
        return JSON.stringify({
          success: false,
          transcript: scriptText,
          files_used: files.map((f) => f.display_name),
          error: "No audio data in TTS response.",
          note: "Script generated but TTS failed. Transcript available above.",
        });
      }

      const inlineData = audioPart.inlineData as {
        data: string;
        mimeType: string;
      };
      const pcmBuffer = Buffer.from(inlineData.data, "base64");

      // Convert PCM to WAV (24kHz, 1 channel, 16-bit)
      const wavBuffer = writeWavHeader(pcmBuffer, 24000, 1, 16);

      if (!existsSync(AUDIO_DIR)) mkdirSync(AUDIO_DIR, { recursive: true });
      const audioFile = join(AUDIO_DIR, `podcast-${Date.now()}.wav`);
      writeFileSync(audioFile, wavBuffer);

      const durationSecs = Math.round(pcmBuffer.length / (24000 * 2));

      return JSON.stringify({
        success: true,
        audio_file: audioFile,
        duration_seconds: durationSecs,
        duration_display: `${Math.floor(durationSecs / 60)}m ${durationSecs % 60}s`,
        transcript: scriptText,
        language,
        length,
        files_used: files.map((f) => f.display_name),
      });
    } catch (err) {
      clearTimeout(ttsTimer);
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({
        success: false,
        transcript: scriptText,
        files_used: files.map((f) => f.display_name),
        error: msg.includes("aborted")
          ? `TTS timed out after ${TTS_TIMEOUT_MS / 1000}s`
          : `TTS failed: ${msg}`,
        note: "Script generated but TTS failed. Transcript available above.",
      });
    }
  },
};
