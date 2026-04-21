/**
 * Composition protocol — hyperframes pattern #1, engine-agnostic.
 *
 * Defines a contract any video composition (slideshow, overlay, storyboard
 * manifest) must satisfy so the renderer can iterate over frames or scenes
 * without knowing which protocol produced them. Enables future engines
 * (e.g. Remotion in v7.4.3) to slot in without touching the renderer.
 */

import type { TransitionName } from "./transitions.js";

/**
 * A single scene in a composition. Scene durations are pre-quantized to
 * frame boundaries before they become part of a manifest.
 */
export interface SceneSpec {
  /** Scene ordinal, zero-indexed. */
  index: number;
  /** Duration in seconds (already quantized to frame grid). */
  durationSec: number;
  /** Narration text. */
  text: string;
  /** Image query or asset key for this scene's visual. */
  imageQuery?: string;
  /** Absolute path to a pre-generated image file (overrides imageQuery). */
  imagePath?: string;
  /** Transition to the NEXT scene. `undefined` for the last scene. */
  transitionToNext?: TransitionName;
  /** Transition duration in seconds. Defaults to 0.5 if unset. */
  transitionDurationSec?: number;
}

export interface MediaAssetRef {
  kind: "image" | "audio" | "video";
  /** Absolute path on disk. */
  path: string;
  /** Bytes; optional metadata. */
  size?: number;
}

/**
 * The engine-agnostic composition manifest. Storyboard pipeline (S2a) emits
 * these; `video_compose_manifest` consumes them.
 */
export interface VideoCompositionManifest {
  /** Protocol version — bump when breaking changes land. */
  version: 1;
  /** Human-readable title for the composition. */
  title: string;
  /** Render profile. */
  template: "landscape" | "portrait" | "square";
  /** Frame rate. Quantization grid is locked to this. */
  fps: 24 | 30 | 60;
  /** Ordered list of scenes. */
  scenes: SceneSpec[];
  /** BCP-47 language tag for TTS selection. */
  language: string;
  /** Optional: which edge-tts voice to use (overrides language default). */
  voice?: string;
  /** Optional: background video asset for overlay mode. */
  backgroundAsset?: string;
  /** Optional: background music asset. */
  backgroundMusicAsset?: string;
  /** Optional: brand DNA profile id from ads_brand_profiles. */
  brandProfileId?: number;
}

/**
 * Compute total duration (scene durations + transition durations).
 * Transitions overlap scene tails so their duration counts once.
 */
export function manifestDuration(manifest: VideoCompositionManifest): number {
  let total = 0;
  for (const scene of manifest.scenes) total += scene.durationSec;
  // Transitions overlap — don't double-count scene tail, but the LAST scene
  // with no outgoing transition contributes its full duration. Scenes with a
  // transition contribute (duration - transitionDuration) as their "non-overlap"
  // portion plus the transition itself once. Mathematically equivalent to the
  // sum of scene durations for non-overlapping transitions.
  return total;
}

/**
 * Whitelist prefixes for `SceneSpec.imagePath` — prevents arbitrary-file-read
 * via ffmpeg `-i` on caller-supplied absolute paths. Hostile LLMs could
 * otherwise inject `/etc/passwd` or similar into a manifest.
 */
const IMAGE_PATH_ALLOWED_PREFIXES = [
  "/tmp/video-jobs/",
  "/tmp/video-previews/",
  "/tmp/video-backgrounds/",
];

/**
 * Reject paths with shell/concat-file/quote/null-byte injection vectors.
 * Semicolon/pipe/redirect chars are intentionally NOT blocked — the current
 * consumers all use `execFileSync` (no shell expansion) and concat-file
 * single-quoting. Adding those here would reject legit paths containing
 * those chars while buying no real safety.
 */
const IMAGE_PATH_FORBIDDEN_CHARS = /[\n\r'"`$\\\0]/;

/** Sanity-length cap on any optional string field. */
const MAX_STRING_FIELD = 500;

function isSafeImagePath(p: unknown): p is string {
  if (typeof p !== "string" || p.length === 0) return false;
  if (p.length > 1024) return false;
  if (!p.startsWith("/")) return false; // must be absolute
  if (p.includes("..")) return false; // no traversal
  if (IMAGE_PATH_FORBIDDEN_CHARS.test(p)) return false;
  return IMAGE_PATH_ALLOWED_PREFIXES.some((prefix) => p.startsWith(prefix));
}

/**
 * Validate a manifest's structural invariants. Throws on failure.
 *
 * Strict allowlist over every field that can reach an external surface
 * (ffmpeg, DB, downstream LLM prompt). Optional fields typecheck when
 * present. `imagePath`/`backgroundAsset` go through `isSafeImagePath` to
 * defeat prompt-injected arbitrary-file-read (v7.4 S1 Round-1 C1).
 */
export function validateManifest(manifest: VideoCompositionManifest): void {
  if (manifest == null || typeof manifest !== "object") {
    throw new Error(`validateManifest: manifest must be an object`);
  }
  if (manifest.version !== 1) {
    throw new Error(
      `validateManifest: unsupported version ${manifest.version}`,
    );
  }
  if (typeof manifest.title !== "string" || manifest.title.length === 0) {
    throw new Error(`validateManifest: title is required`);
  }
  if (manifest.title.length > 200) {
    throw new Error(`validateManifest: title exceeds 200 chars`);
  }
  if (!["landscape", "portrait", "square"].includes(manifest.template)) {
    throw new Error(`validateManifest: invalid template ${manifest.template}`);
  }
  if (![24, 30, 60].includes(manifest.fps)) {
    throw new Error(`validateManifest: unsupported fps ${manifest.fps}`);
  }
  if (typeof manifest.language !== "string" || manifest.language.length === 0) {
    throw new Error(`validateManifest: language is required`);
  }
  if (manifest.language.length > 16) {
    throw new Error(`validateManifest: language exceeds 16 chars`);
  }

  // Optional scalars
  if (manifest.voice !== undefined) {
    if (typeof manifest.voice !== "string" || manifest.voice.length > 80) {
      throw new Error(`validateManifest: voice invalid or too long`);
    }
  }
  if (manifest.backgroundAsset !== undefined) {
    if (!isSafeImagePath(manifest.backgroundAsset)) {
      throw new Error(`validateManifest: backgroundAsset fails safety checks`);
    }
  }
  if (manifest.backgroundMusicAsset !== undefined) {
    if (!isSafeImagePath(manifest.backgroundMusicAsset)) {
      throw new Error(
        `validateManifest: backgroundMusicAsset fails safety checks`,
      );
    }
  }
  if (manifest.brandProfileId !== undefined) {
    if (
      !Number.isInteger(manifest.brandProfileId) ||
      manifest.brandProfileId < 1
    ) {
      throw new Error(
        `validateManifest: brandProfileId must be a positive integer`,
      );
    }
  }

  if (!Array.isArray(manifest.scenes) || manifest.scenes.length === 0) {
    throw new Error(`validateManifest: scenes must be a non-empty array`);
  }
  if (manifest.scenes.length > 120) {
    throw new Error(`validateManifest: scene count exceeds 120`);
  }
  manifest.scenes.forEach((scene, i) => {
    if (scene == null || typeof scene !== "object") {
      throw new Error(`validateManifest: scene ${i} must be an object`);
    }
    if (scene.index !== i) {
      throw new Error(`validateManifest: scene ${i} has index=${scene.index}`);
    }
    if (!Number.isFinite(scene.durationSec) || scene.durationSec <= 0) {
      throw new Error(`validateManifest: scene ${i} invalid durationSec`);
    }
    if (scene.durationSec > 60) {
      throw new Error(`validateManifest: scene ${i} duration exceeds 60s cap`);
    }
    if (typeof scene.text !== "string" || scene.text.length === 0) {
      throw new Error(`validateManifest: scene ${i} missing text`);
    }
    if (scene.text.length > 2000) {
      throw new Error(`validateManifest: scene ${i} text exceeds 2000 chars`);
    }
    if (scene.imageQuery !== undefined) {
      if (
        typeof scene.imageQuery !== "string" ||
        scene.imageQuery.length > MAX_STRING_FIELD
      ) {
        throw new Error(
          `validateManifest: scene ${i} imageQuery invalid or too long`,
        );
      }
    }
    if (scene.imagePath !== undefined && !isSafeImagePath(scene.imagePath)) {
      throw new Error(
        `validateManifest: scene ${i} imagePath fails safety checks (must be absolute under /tmp/video-jobs|video-previews|video-backgrounds, no traversal or shell metachars)`,
      );
    }
    if (scene.transitionToNext !== undefined) {
      if (
        typeof scene.transitionToNext !== "string" ||
        scene.transitionToNext.length > 40
      ) {
        throw new Error(
          `validateManifest: scene ${i} transitionToNext invalid`,
        );
      }
    }
    if (scene.transitionDurationSec !== undefined) {
      if (
        !Number.isFinite(scene.transitionDurationSec) ||
        scene.transitionDurationSec <= 0 ||
        scene.transitionDurationSec > 5
      ) {
        throw new Error(
          `validateManifest: scene ${i} transitionDurationSec must be in (0, 5]`,
        );
      }
    }
  });
}
