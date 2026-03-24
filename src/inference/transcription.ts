/**
 * Voice Transcription — Whisper-compatible API client.
 *
 * Same pattern as crm-azteca/crm/src/transcription.ts.
 * Works with OpenAI, Groq, or any Whisper-compatible endpoint.
 * Sends audio as multipart/form-data, returns { text, confidence }.
 *
 * Configured via WHISPER_API_URL, WHISPER_API_KEY, WHISPER_MODEL env vars.
 * Gracefully disabled when env vars are missing.
 */

import fs from "fs";
import path from "path";

export interface TranscriptionResult {
  text: string;
  /** 0.0–1.0 confidence score (estimated from avg_logprob when available) */
  confidence: number;
}

interface WhisperVerboseResponse {
  text: string;
  segments?: Array<{ avg_logprob?: number }>;
}

const WHISPER_TIMEOUT_MS = 30_000;

/** Check if Whisper transcription is configured. */
export function isTranscriptionConfigured(): boolean {
  return !!(process.env.WHISPER_API_URL && process.env.WHISPER_API_KEY);
}

/**
 * Transcribe an audio file using a Whisper-compatible API.
 *
 * @param filepath Absolute path to the audio file
 * @param apiUrl   Whisper endpoint (default: WHISPER_API_URL env)
 * @param apiKey   Bearer token (default: WHISPER_API_KEY env)
 * @param model    Model name (default: WHISPER_MODEL env or "whisper-1")
 */
export async function transcribe(
  filepath: string,
  apiUrl = process.env.WHISPER_API_URL ?? "",
  apiKey = process.env.WHISPER_API_KEY ?? "",
  model = process.env.WHISPER_MODEL ?? "whisper-1",
): Promise<TranscriptionResult> {
  if (!apiUrl || !apiKey) {
    throw new Error("Whisper not configured: WHISPER_API_URL/KEY missing");
  }

  if (!fs.existsSync(filepath)) {
    throw new Error(`Audio file not found: ${filepath}`);
  }

  const fileBuffer = fs.readFileSync(filepath);
  const filename = path.basename(filepath);
  const ext = path.extname(filepath).slice(1);

  const mimeMap: Record<string, string> = {
    ogg: "audio/ogg",
    opus: "audio/ogg",
    oga: "audio/ogg",
    mp4: "audio/mp4",
    m4a: "audio/mp4",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    webm: "audio/webm",
  };
  const mimeType = mimeMap[ext] || "audio/ogg";

  // Build multipart/form-data manually (zero deps)
  const boundary = `----whisper${Date.now()}${Math.random().toString(36).slice(2)}`;
  const parts: Buffer[] = [];

  // file field
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
    ),
  );
  parts.push(fileBuffer);
  parts.push(Buffer.from("\r\n"));

  // model field
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`,
    ),
  );

  // language hint (Spanish)
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nes\r\n`,
    ),
  );

  // verbose_json for confidence estimation
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\nverbose_json\r\n`,
    ),
  );

  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(parts);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WHISPER_TIMEOUT_MS);

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `Whisper API ${response.status}: ${errorText.slice(0, 200)}`,
      );
    }

    const data = (await response.json()) as WhisperVerboseResponse;

    let confidence = 0.8;
    if (data.segments?.length) {
      const avgLogprob =
        data.segments.reduce((sum, s) => sum + (s.avg_logprob ?? -0.3), 0) /
        data.segments.length;
      confidence = Math.max(0, Math.min(1, 1 + avgLogprob));
    }

    console.log(
      `[transcription] ${path.basename(filepath)} → ${data.text.length} chars, confidence=${(confidence * 100).toFixed(0)}%`,
    );

    return { text: data.text.trim(), confidence };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Transcribe a Buffer directly (saves to /tmp, transcribes, cleans up).
 * Convenience wrapper for channel handlers that already have the audio in memory.
 */
export async function transcribeBuffer(
  buffer: Buffer,
  ext = "ogg",
): Promise<TranscriptionResult | null> {
  if (!isTranscriptionConfigured()) return null;

  const tmpPath = `/tmp/voice-${Date.now()}.${ext}`;
  try {
    fs.writeFileSync(tmpPath, buffer);
    return await transcribe(tmpPath);
  } catch (err) {
    console.warn(
      `[transcription] Failed: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* cleanup best-effort */
    }
  }
}
