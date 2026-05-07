/**
 * HTML composition skill gate — v7.4.3.6.
 *
 * Three catalogs that condition the LLM when authoring HTML for
 * `video_html_compose`. The roadmap names these as "SKILL.md +
 * house-style.md + visual-styles.md"; we ship them as inline TS
 * strings so they travel with the compiled service (no asset-copy
 * step) and so the v7.5 Skill Evolution Engine can mutate them as
 * tuning targets via the `tune_experiments` surface system.
 *
 * Same pattern as `cinema-prompts.ts` (v7.4 S2a) and
 * `motionVocabSection()` (v7.4.3 prior): static catalogs injected
 * into the tool description so the model sees concrete, current
 * guidance rather than relying on training prior.
 */

/** Gate file: when to use `video_html_compose`, when not to, and what NOT to do. */
export const HTML_COMPOSE_SKILL_GATE = `Skill gate — video_html_compose:

USE WHEN
- Operator says "render this HTML as a video" / "convert HTML to MP4" / "hacer un video desde HTML"
- A composition HTML file already exists under /root/tmp-video-html/ with data-start / data-duration attributes (or a window.__hf.duration()/seek() contract)

DO NOT USE WHEN
- Operator wants a slideshow from a script — use video_create
- Operator wants a vertical overlay video — use video_create with overlay engine
- Operator just wants a screenshot — use screenshot_element

HARD CONSTRAINTS
- File must be under /root/tmp-video-html/ and end with .html
- Network is blocked at the route handler — inline ALL assets as data: URIs
- Service Workers blocked
- <video> source elements unsupported (deferred v7.4.3.3)
- GSAP not bundled (deferred v7.4.3.2) — CSS keyframes only
- Multi-track / layer compositing not yet enforced (deferred v7.4.3.7)`;

/** House style: defaults the LLM should follow unless operator overrides. */
export const HTML_COMPOSE_HOUSE_STYLE = `House style — defaults:

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
- Don't animate properties that trigger layout (top/left/width); animate transform/opacity`;

/** Visual styles: pickable presets the operator can request by name. */
export const HTML_COMPOSE_VISUAL_STYLES = `Visual style presets (pick one as the spine; mix sparingly):

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
- Best for: luxury brands, contemplative pieces, opening titles`;

/**
 * Build the skill-gate section to inject into the `video_html_compose` tool
 * description. Same shape as `motionVocabSection()` so the assembled
 * description stays scannable.
 */
export function htmlCompositionSkillSection(): string {
  return [
    HTML_COMPOSE_SKILL_GATE,
    "",
    HTML_COMPOSE_HOUSE_STYLE,
    "",
    HTML_COMPOSE_VISUAL_STYLES,
  ].join("\n");
}

/**
 * Discoverable surface for the v7.5 Skill Evolution Engine. Each entry is a
 * tunable string with a stable `surface` key so the engine can target one
 * catalog at a time without colliding with the others.
 */
export const HTML_COMPOSE_SKILLS = [
  {
    surface: "html-compose-skill-gate",
    label: "When to use video_html_compose",
    content: HTML_COMPOSE_SKILL_GATE,
  },
  {
    surface: "html-compose-house-style",
    label: "House style defaults for HTML composition",
    content: HTML_COMPOSE_HOUSE_STYLE,
  },
  {
    surface: "html-compose-visual-styles",
    label: "Visual style presets for HTML composition",
    content: HTML_COMPOSE_VISUAL_STYLES,
  },
] as const;
