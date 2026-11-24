import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Tool } from "../types.js";

// This file only reads the video tools' strings and calls no handler. For the
// whole file every function export of "fs", "node:fs", "fs/promises",
// "node:fs/promises", "child_process" and "node:child_process" is replaced by
// a stub that throws; other exports stay real, "default" points to the stub
// object, and the "promises" property of both fs specifiers points to the
// stubbed promises module. The global fetch is a stub that throws, set before
// the imports and again before each test. Packages loaded from node_modules
// without transformation keep the real built-in modules.
// Every expected text is a literal, including the HTML compose tool's, whose
// description is assembled from catalog constants at load.
const stubbed = vi.hoisted(() => (label: string, real: Record<string, unknown>) => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(real))
    out[k] =
      typeof v === "function"
        ? vi.fn(() => {
            throw new Error(`${label} ${k} is a stub in this file`);
          })
        : v;
  out.default = out;
  return out;
});
vi.mock("fs/promises", async (importOriginal) =>
  stubbed("fs/promises", await importOriginal<Record<string, unknown>>()),
);
vi.mock("node:fs/promises", async (importOriginal) =>
  stubbed("node:fs/promises", await importOriginal<Record<string, unknown>>()),
);
vi.mock("fs", async (importOriginal) => {
  const out = stubbed("fs", await importOriginal<Record<string, unknown>>());
  out.promises = await import("fs/promises");
  return out;
});
vi.mock("node:fs", async (importOriginal) => {
  const out = stubbed("node:fs", await importOriginal<Record<string, unknown>>());
  out.promises = await import("node:fs/promises");
  return out;
});
vi.mock("child_process", async (importOriginal) =>
  stubbed("child_process", await importOriginal<Record<string, unknown>>()),
);
vi.mock("node:child_process", async (importOriginal) =>
  stubbed("node:child_process", await importOriginal<Record<string, unknown>>()),
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
import * as fsPromises from "fs/promises";
import * as nodeFsPromises from "node:fs/promises";
import * as childProcess from "child_process";
import * as nodeChildProcess from "node:child_process";
import {
  videoCreateTool,
  videoStatusTool,
  videoScriptTool,
  videoTtsTool,
  videoListVoicesTool,
  videoImageTool,
  videoListProfilesTool,
  videoBackgroundDownloadTool,
  videoTransitionPreviewTool,
  videoComposeManifestTool,
  videoJobCancelTool,
  videoJobCleanupTool,
  videoStoryboardTool,
  videoBrandApplyTool,
  videoHtmlComposeTool,
} from "./video.js";

const propsOf = (t: Tool): Record<string, { description: string }> =>
  (t.definition.function.parameters as { properties: Record<string, { description: string }> })
    .properties;

const VIDEO_CREATE = `Create a video from a topic description. Full pipeline: script → images → TTS → compose → MP4.

USE WHEN:
- User asks "hazme un video sobre..."
- User wants a video explainer, presentation, or content piece

Returns a job ID to check progress with video_status.
Duration: 15-120 seconds. Template: landscape (YouTube), portrait (TikTok/Reels), square (Instagram).

Modes:
- slideshow (default): static image per scene, concatenated.
- overlay: images overlaid on background video with timed visibility.

OVERLAY MODE WORKFLOW:
1. First: video_background_download name:"ocean-waves" (or any catalog name)
2. Then: video_create topic:"..." mode:"overlay" background:"ocean-waves" template:"portrait"
3. Optional: voice:"es-MX-JorgeNeural" for male voice (use video_list_voices to browse)

The overlay engine uses per-scene TTS with individual timing.

Any other tool named in this description or its parameters is usable only when it is among your tools.

DO NOT USE WHEN:
- You want it made from your own images or script: it writes its own script and fetches each scene's image from a query that script holds; it takes no image files or script. For your own scene text, use video_compose_manifest.
- You want transitions, music, or captions in overlay mode: scenes are joined with plain cuts, no music is added, and only slideshow mode burns in captions.`;

const VIDEO_STATUS = `Check the status of a video production job.

USE WHEN:
- After calling video_create, to check if the video is ready
- User asks "ya está mi video?"

DO NOT USE WHEN:
- You lost the job id or want a list of jobs: it looks up exactly one job_id and lists nothing.
- You want the finished video sent to the user: it returns the file's path on the server and sends nothing.
- You want progress detail: its only progress field is the stage name, with no percentage or time left.

Returns: status, output file path (when completed), or error message (when failed).`;

const VIDEO_SCRIPT = `Generate a video script without rendering.

USE WHEN:
- User wants to see a draft script
- Planning video content structure

DO NOT USE WHEN:
- You want audio, images or a video: it returns the script JSON only (scenes with narration, duration and image query); nothing is rendered and no job is created.
- You want this exact script rendered next: video_create takes no script and writes a new one of its own.
- You need under 15 or over 120 seconds: the duration is clamped to that range without an error.`;

const VIDEO_TTS = `Generate narration audio from text using TTS (v6.2 V1).

USE WHEN:
- Need a voice-over audio file from text
- Testing narration before full video render

Uses edge-tts voices. To see available options, use video_list_voices when it is among your tools.
Long texts (>2000 chars) are automatically split, at sentence boundaries where possible, with silence gaps.

DO NOT USE WHEN:
- You want to send a voice note or audio to the user: it writes the MP3 (and its working files) under /tmp on the server and returns the MP3's path; it sends nothing to the user.
- You must know the narration was spoken: if the speech program fails, it returns a silent MP3 of estimated length with no error, still naming the voice.`;

const VIDEO_LIST_VOICES = `List available TTS voices for video narration.

USE WHEN:
- User wants to know the available voice options
- Choosing a voice for video_tts or video_create

Returns voice names (each begins with its locale) and genders. Filter by language to narrow results.

DO NOT USE WHEN:
- You want to hear a voice: it returns names and genders only, no audio sample.
- You filter by a language name ("Spanish") or in capitals ("ES"): the filter matches the start of the locale exactly (es, es-MX), and a miss returns the "No voices found" error.`;

const VIDEO_IMAGE = `Fetch an image for a given query, from a stock photo search when it can.

USE WHEN:
- Need a stock image for a specific concept
- Testing image queries before full video render

DO NOT USE WHEN:
- You need a real stock photo: when the stock search is not set up, fails or finds nothing, it returns an AI-generated image or a plain dark placeholder, and the result does not say which.
- You want several options or a portrait image: it saves one image only, always asked for in landscape.
- You want the file in a manifest scene: it saves under /tmp outside the folders a manifest image path may name, so that manifest is refused.`;

const VIDEO_LIST_PROFILES = `List available video render profiles (aspect ratios and resolutions).

USE WHEN:
- User asks what video formats are available
- Before creating a video, to show options

DO NOT USE WHEN:
- You want frame rate, length or file-size limits: it returns only the three templates (landscape, portrait, square) with width, height and a label.
- You want the available voices: it lists render templates only; use video_list_voices when it is among your tools.`;

const VIDEO_BACKGROUND_DOWNLOAD = `Download and cache a background video for overlay composition.

USE WHEN:
- Preparing background footage for a video with overlay mode
- Pre-caching backgrounds before a batch of video renders

Available backgrounds: ocean-waves, city-timelapse, abstract-particles, nature-forest, clouds-sky.
Or provide a custom Pexels/YouTube URL.

Videos are cached in /tmp/video-backgrounds/ — subsequent calls for the same name skip the download.

DO NOT USE WHEN:
- You want new footage under a name already cached: the link you give is not downloaded for that name.
- Your link is a page on some other site: the tool takes direct .mp4, .webm or .mov links, Pexels links and links on a short list of video sites; a file over 500 MB is not kept, and a failed download returns only a generic error.
- You want the footage's own sound in the video: overlay mode drops the background's audio.`;

const VIDEO_TRANSITION_PREVIEW = `Render a short sample MP4 demonstrating a named transition between two solid-color test cards.

USE WHEN:
- User wants to see what a specific transition looks like
- Comparing transitions before committing to one in a storyboard

Available transitions: fade, wipeleft, wiperight, circleopen, circlecrop, pixelize, dissolve, radial (8 native ffmpeg xfade);
plus domain-warp, ridged-burn, gravitational-lens, chromatic-radial-split, sdf-iris, rgb-displacement (6 GL-only, fall back to dissolve).

Returns the path to a small MP4 under /tmp/video-previews/.

DO NOT USE WHEN:
- You expect the transition in a rendered video: the topic and manifest renders join scenes with plain cuts, so a transition chosen here or set in a manifest does not appear.
- You want it shown on your own images or clips: it always shows the transition between two plain colour cards at 320x180.`;

const VIDEO_COMPOSE_MANIFEST = `Compose a video from a structured VideoCompositionManifest (engine-agnostic). Prefer this over video_create when you already have a structured scene list.

USE WHEN:
- Caller already has a VideoCompositionManifest (pre-authored or emitted by a storyboard pipeline)
- User wants fine control over scene count and durations

Returns a job_id; to track it, use video_status when it is among your tools.

DO NOT USE WHEN:
- You want the manifest's transitions, frame rate, background footage, music or brand profile used: the render reads only the title, template, language, voice and each scene's text, duration and image, and joins scenes with plain cuts at 24 fps.
- Your scene images sit elsewhere: an image path must be under /tmp/video-jobs/, /tmp/video-previews/ or /tmp/video-backgrounds/, or the manifest is refused.
- You have only a topic or a brief: this tool writes no scenes; use video_storyboard when it is among your tools.`;

const VIDEO_JOB_CANCEL = `Mark a video job as cancelled. NOTE: currently only marks the DB row — does NOT yet kill the underlying ffmpeg child (v7.4 S1 limitation). It does not stop the job's work: if that work is still running, its later steps write their own status over the cancelled mark.

USE WHEN:
- User asks to stop a video render (note the caveat above)
- A job is stuck in a non-terminal state (scripting/generating_assets/composing) and the operator wants the DB row marked cancelled

No-op if the job is already completed/failed/cancelled. Returns {ok:false} if the job does not exist.

DO NOT USE WHEN:
- You want the job's files or its row removed: cancelling deletes nothing, and video_job_cleanup, when it is among your tools, leaves the job alone for at least an hour after the cancel.
- You cancel to free a slot for a new job: the work is not stopped, and a topic or manifest job still running can write a running stage over the cancelled mark, which counts it toward the two-job limit again.`;

const VIDEO_JOB_CLEANUP = `Remove expired/terminal video job working directories and DB rows. Ops hygiene — frees disk space.

USE WHEN:
- Operator wants to reclaim disk
- Disk is tight and /tmp/video-jobs/ has many leftover directories

DO NOT USE WHEN:
- You want to keep a finished video: a removed job loses its row and its folder under /tmp/video-jobs/, which holds the MP4 of a topic or manifest render.
- You want to free space used by backgrounds, previews, single audio or image files, or an HTML job's MP4: it removes only each job's own folder under /tmp/video-jobs/ and its row.
- You want to stop a running job: it skips every job that is not completed, failed or cancelled.

Default: removes completed, failed or cancelled jobs that finished more than 24h ago, and any of them with no recorded finish time at any age (a failed job records none unless it was cancelled first). Returns counts.`;

const VIDEO_STORYBOARD = `Generate a structured VideoCompositionManifest from a brief + duration. Uses the LLM to author scene-by-scene narration, image queries, and transitions. Does NOT render: pass the manifest it returns to video_compose_manifest when it is among your tools.

USE WHEN:
- User wants a video but hasn't authored the manifest themselves
- Draft scenes from a topic/brief

Optional brand_id pulls a profile from ads_brand_profiles (v7.3 P4a) — brand voice and keyword lists — and merges into the prompt.

Links the redaction recognises in the brief are replaced by a placeholder before the brief reaches the LLM. Output is validated via validateManifest.

DO NOT USE WHEN:
- You want the brief's links read: links are never fetched, and those the redaction recognises are replaced by a placeholder; for a brand taken from a website, use ads_brand_dna when it is among your tools and pass the profile id it returns, when it returns one, as brand_id.
- You expect the chosen transitions on screen: the manifest render joins scenes with plain cuts.
- Your brief is long: only its first 4000 characters, counted after the link redaction, reach the model; the rest is dropped without an error.`;

const VIDEO_BRAND_APPLY = `Load a brand profile from ads_brand_profiles (v7.3 P4a) and return a summary the operator can feed into video_storyboard as brand_id. Convenience tool — it does not itself generate a storyboard.

USE WHEN:
- Operator wants to confirm a brand_id is valid before running video_storyboard
- Inspecting what brand voice / lexicon will be injected into the prompt

DO NOT USE WHEN:
- You want a stored profile changed, or a new one made: it only reads one stored profile by its number. For a new profile from the brand's site or text, use ads_brand_dna when it is among your tools.
- You need the brand's colors: the summary holds the tagline, voice and the keyword and avoid lists only, and the storyboard prompt does not use colors either.`;

const VIDEO_HTML_COMPOSE = `Compose a video from an HTML file authored with the composition DSL (data-start / data-duration / data-track-index / data-layer attributes, plus optional window.__hf.duration()/seek() contract). Per-frame renders via headless Chromium (snap binary) then muxes PNG sequence into an MP4.

COST: approximately 140ms per frame on this VPS. 10s @ 24fps ≈ 35s wall-clock, 30s @ 24fps ≈ 100s. Use video_status to poll.

USE WHEN:
- User asks to "render this HTML as a video" / "convert html to mp4" / "hacer un video desde html"
- Caller has a pre-authored composition HTML file under /root/tmp-video-html/

HTML file MUST live under /root/tmp-video-html/ and have .html extension. Network loads are blocked at the route handler — inline all assets as data: URIs. Service Workers are blocked.

Motion vocabulary (CSS-only, GSAP not bundled in v7.4.3 MVP):
  fade-in, fade-out, slide-in-left, slide-in-right, slide-in-up, scale-pop, scale-zoom, rotate-in, blur-in, typewriter, pulse, shake-attention, counter-up, split-reveal, parallax-drift, lower-third

Skill gate — video_html_compose:

USE WHEN
- Operator says "render this HTML as a video" / "convert HTML to MP4" / "hacer un video desde HTML"
- A composition HTML file already exists under /root/tmp-video-html/ with data-start / data-duration attributes (or a window.__hf.duration()/seek() contract)

Any other tool named in this description or its parameters is usable only when it is among your tools.

DO NOT USE WHEN
- Operator wants a video from a topic — use video_create
- Operator wants a vertical overlay video — use video_create with overlay engine
- Operator just wants a screenshot — use screenshot_element

HARD CONSTRAINTS
- File must be under /root/tmp-video-html/ and end with .html
- Network is blocked at the route handler — inline ALL assets as data: URIs
- Service Workers blocked
- <video> source elements unsupported (deferred v7.4.3.3)
- GSAP not bundled (deferred v7.4.3.2) — CSS keyframes only
- Multi-track / layer compositing not yet enforced (deferred v7.4.3.7)

House style — defaults:

FRAME RATE
- 24fps default (cinematic)
- 30fps for kinetic / social-content
- 60fps reserved for screen-recordings

VIEWPORT
- 1920x1080 default (16:9 landscape)
- 1080x1920 portrait (social verticals)
- 1080x1080 square (feed)

SCENE & ELEMENT DURATION
- Element minimum 0.4s (anything shorter reads as a flash)
- Element maximum ~8s on a single screen (longer = lethargic; cut)
- Animation duration 200-600ms typical; 300ms is the sweet spot

EASING
- Default in/out: cubic-bezier(.25,.1,.25,1)
- Material/snappy: cubic-bezier(.4,0,.2,1)
- Avoid linear except for continuous motion (parallax-drift, ticker)

TYPOGRAPHY
- Body minimum 32px; hero 80px+
- Line-height 1.2-1.5; max 80 chars per line
- Use system stack or one webfont; never two display faces

CONTRAST & READABILITY
- WCAG AA minimum: 4.5:1 body, 3:1 large text
- Avoid drop-shadow on text smaller than 48px
- backdrop-filter is unreliable on snap Chromium — prefer solid scrims

MOTION DISCIPLINE
- One motion per element at a time (don't combine fade + scale + slide)
- Don't animate properties that trigger layout (top/left/width); animate transform/opacity

Visual style presets (pick one as the spine; mix sparingly):

EDITORIAL — long-form, "magazine" feel
- Fonts: Playfair Display / Source Serif (serif headings); Inter or system sans for body
- Palette: dark slate (#1a1a1a) bg, ivory (#f5f1e8) text, single warm accent (#d4a64a)
- Motion: typewriter, fade, parallax-drift; transitions ≥ 600ms
- Best for: explainers, profiles, narrative pieces

DOCUMENTARY — restrained, factual
- Fonts: humanist sans (Inter, Source Sans) throughout
- Palette: white-paper bg (#fafafa), charcoal (#222) text, subdued blues (#3a5e8c)
- Motion: fade, slide, counter; transitions 400-500ms
- Best for: reports, talking-head supports, explainer overlays

HYPE — kinetic, social-first
- Fonts: condensed display (Bebas Neue, Anton, Oswald) for hero; Inter for body
- Palette: saturated background (single bold color), white type, one neon accent
- Motion: shake, pulse, scale, split-reveal; transitions 200-300ms
- Best for: drops, hooks, highlight reels

DATA-VIZ — quantitative
- Fonts: JetBrains Mono / IBM Plex Mono (numerals); sans for labels
- Palette: high-contrast neutrals, single semantic color (red=down, green=up, blue=neutral)
- Motion: counter, slide, reveal; transitions 400ms; no decorative motion
- Best for: dashboards, financial recaps, KPI pieces

BRUTALIST — opinionated, raw
- Fonts: system stack (Helvetica, Arial); occasional grotesque (Suisse, Inter Display)
- Palette: pure white / pure black / single primary; thick borders, no gradients
- Motion: hard cuts (no easing), shake on hits, typewriter on body
- Best for: manifestos, design-forward client work

MINIMAL — calm, premium
- Fonts: light sans (Inter Light, Source Sans Light); generous tracking
- Palette: off-white bg, charcoal type, hairline dividers, near-black accent
- Motion: fade only; transitions 600-800ms; long hold times
- Best for: luxury brands, contemplative pieces, opening titles

Example HTML: <style>@keyframes fade-in { from {opacity:0} to {opacity:1} } .fade-in { animation: fade-in 0.5s forwards }</style><h1 class="fade-in" data-start="0" data-duration="2">Hello</h1>

Returns a job_id to track with video_status.`;

describe("video tools — description text", () => {
  it("every function export of the six module specifiers is a mock, and fetch is the stub (checked without calling one)", () => {
    expect(fs.promises).toBe(fsPromises);
    expect(nodeFs.promises).toBe(nodeFsPromises);
    const mods: Record<string, object> = {
      fs,
      "node:fs": nodeFs,
      "fs/promises": fsPromises,
      "node:fs/promises": nodeFsPromises,
      "fs.promises": fs.promises,
      "node:fs.promises": nodeFs.promises,
      child_process: childProcess,
      "node:child_process": nodeChildProcess,
    };
    for (const [label, mod] of Object.entries(mods)) {
      const fns = Object.entries(mod).filter(([, v]) => typeof v === "function");
      expect(fns.length, label).toBeGreaterThan(0);
      for (const [name, fn] of fns) expect(vi.isMockFunction(fn), `${label} ${name}`).toBe(true);
    }
    expect(globalThis.fetch).toBe(fetchStub);
    expect(vi.isMockFunction(globalThis.fetch)).toBe(true);
  });

  it("video_create — the whole description", () => {
    expect(videoCreateTool.definition.function.description).toBe(VIDEO_CREATE);
  });

  it("video_status — the whole description", () => {
    expect(videoStatusTool.definition.function.description).toBe(VIDEO_STATUS);
  });

  it("video_script — the whole description", () => {
    expect(videoScriptTool.definition.function.description).toBe(VIDEO_SCRIPT);
  });

  it("video_tts — the whole description", () => {
    expect(videoTtsTool.definition.function.description).toBe(VIDEO_TTS);
  });

  it("video_list_voices — the whole description", () => {
    expect(videoListVoicesTool.definition.function.description).toBe(VIDEO_LIST_VOICES);
  });

  it("video_image — the whole description", () => {
    expect(videoImageTool.definition.function.description).toBe(VIDEO_IMAGE);
  });

  it("video_list_profiles — the whole description", () => {
    expect(videoListProfilesTool.definition.function.description).toBe(VIDEO_LIST_PROFILES);
  });

  it("video_background_download — the whole description", () => {
    expect(videoBackgroundDownloadTool.definition.function.description).toBe(VIDEO_BACKGROUND_DOWNLOAD);
  });

  it("video_transition_preview — the whole description", () => {
    expect(videoTransitionPreviewTool.definition.function.description).toBe(VIDEO_TRANSITION_PREVIEW);
  });

  it("video_compose_manifest — the whole description", () => {
    expect(videoComposeManifestTool.definition.function.description).toBe(VIDEO_COMPOSE_MANIFEST);
  });

  it("video_job_cancel — the whole description", () => {
    expect(videoJobCancelTool.definition.function.description).toBe(VIDEO_JOB_CANCEL);
  });

  it("video_job_cleanup — the whole description", () => {
    expect(videoJobCleanupTool.definition.function.description).toBe(VIDEO_JOB_CLEANUP);
  });

  it("video_storyboard — the whole description", () => {
    expect(videoStoryboardTool.definition.function.description).toBe(VIDEO_STORYBOARD);
  });

  it("video_brand_apply — the whole description", () => {
    expect(videoBrandApplyTool.definition.function.description).toBe(VIDEO_BRAND_APPLY);
  });

  it("video_html_compose — the whole description", () => {
    expect(videoHtmlComposeTool.definition.function.description).toBe(VIDEO_HTML_COMPOSE);
  });

  it("video_tts — the voice parameter text", () => {
    expect(propsOf(videoTtsTool).voice.description).toBe(
      "Edge-tts voice name (e.g. es-MX-DaliaNeural, en-US-BrianNeural). To see options, use video_list_voices when it is among your tools.",
    );
  });

  it("video_list_voices — the language parameter text", () => {
    expect(propsOf(videoListVoicesTool).language.description).toBe(
      "Language filter prefix (e.g. 'es' for Spanish, 'en' for English). Omit to list all voices.",
    );
  });

  it("video_job_cleanup — the older_than_hours parameter text", () => {
    expect(propsOf(videoJobCleanupTool).older_than_hours.description).toBe(
      "Only remove jobs that finished more than this many hours ago (default 24, min 1, max 720); a completed, failed or cancelled job with no recorded finish time is removed at any age.",
    );
  });

  it("video_storyboard — the brief parameter text", () => {
    expect(propsOf(videoStoryboardTool).brief.description).toBe(
      "Plain-language description of what the video should be about. Max 4000 chars. Links the redaction recognises are replaced by a placeholder.",
    );
  });
});
