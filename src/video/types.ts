/**
 * Video production types — S5d.
 */

export interface VideoScene {
  /** Narration text for this scene. */
  text: string;
  /** Scene duration in seconds. */
  duration: number;
  /** Search query for Pexels stock image/video. */
  imageQuery: string;
  /** Transition to next scene: fade, cut. */
  transition?: "fade" | "cut";
}

export interface VideoScript {
  title: string;
  scenes: VideoScene[];
  totalDuration: number;
  language: string;
}

export type VideoJobStatus =
  | "pending"
  | "confirmed"
  | "scripting"
  | "generating_assets"
  | "composing"
  | "completed"
  | "failed"
  | "cancelled";

export interface VideoJob {
  jobId: string;
  status: VideoJobStatus;
  topic: string;
  duration: number;
  resolution: string;
  template: "landscape" | "portrait" | "square";
  script?: VideoScript;
  audioFile?: string;
  imageFiles?: string[];
  subtitleFile?: string;
  outputFile?: string;
  errorMessage?: string;
  createdAt: string;
  completedAt?: string;
}

export interface VideoJobRow {
  id: number;
  job_id: string;
  status: string;
  topic: string;
  duration_seconds: number;
  resolution: string;
  template: string;
  script_json: string | null;
  assets_json: string | null;
  output_file: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
  expires_at: string | null;
}

/** Platform render profiles. */
export const VIDEO_PROFILES = {
  landscape: { width: 1920, height: 1080, label: "Landscape 16:9 (YouTube)" },
  portrait: {
    width: 1080,
    height: 1920,
    label: "Portrait 9:16 (TikTok/Reels)",
  },
  square: { width: 1080, height: 1080, label: "Square 1:1 (Instagram)" },
} as const;
