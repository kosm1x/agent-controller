/**
 * HTML motion catalog — v7.4.3.
 *
 * Static reference library of CSS/keyframe motion patterns used when authoring
 * HTML-as-Composition compositions. Same shape as `cinema-prompts.ts` (v7.4 S2a)
 * and `creative-frameworks.ts` (v7.3 P4a): non-LLM, non-mutating reference data.
 *
 * The storyboard / HTML-author agent reads `prompt_fragment` when producing
 * HTML compositions so motion choices are anchored to a canonical vocabulary.
 * Consumers MUST feed `prompt_fragment` (and `css` where appropriate) verbatim
 * into prompts — not just `.id`. Dead-data drift was caught in v7.4 S2a R2 W1.
 */

export interface HtmlMotionPattern {
  id: string;
  label: string;
  /** Short descriptor appended to an LLM prompt. */
  prompt_fragment: string;
  /** Canonical CSS snippet. Paste verbatim; no runtime substitution. */
  css: string;
  /** When this pattern is most appropriate. */
  best_for: string[];
}

/**
 * 16 curated motion patterns. All pure CSS — no GSAP required (GSAP bundle
 * deferred to v7.4.3.2). Each entry is self-contained and composable.
 */
export const HTML_MOTION_PATTERNS: readonly HtmlMotionPattern[] = [
  {
    id: "fade-in",
    label: "Fade in",
    prompt_fragment: "element fades from 0 to full opacity over ~500ms",
    css: "@keyframes fade-in { from { opacity: 0 } to { opacity: 1 } } .fade-in { animation: fade-in 0.5s ease-out forwards }",
    best_for: ["First appearance", "Subtle reveal", "Text overlays"],
  },
  {
    id: "fade-out",
    label: "Fade out",
    prompt_fragment: "element fades from full opacity to 0 over ~500ms",
    css: "@keyframes fade-out { from { opacity: 1 } to { opacity: 0 } } .fade-out { animation: fade-out 0.5s ease-in forwards }",
    best_for: ["Last appearance", "Scene exit"],
  },
  {
    id: "slide-in-left",
    label: "Slide in from left",
    prompt_fragment:
      "element slides in horizontally from the left edge over ~600ms",
    css: "@keyframes slide-in-left { from { transform: translateX(-100%); opacity: 0 } to { transform: translateX(0); opacity: 1 } } .slide-in-left { animation: slide-in-left 0.6s cubic-bezier(.2,.8,.2,1) forwards }",
    best_for: ["Sidebar reveal", "Caption entry", "Column content"],
  },
  {
    id: "slide-in-right",
    label: "Slide in from right",
    prompt_fragment: "element slides in from the right edge over ~600ms",
    css: "@keyframes slide-in-right { from { transform: translateX(100%); opacity: 0 } to { transform: translateX(0); opacity: 1 } } .slide-in-right { animation: slide-in-right 0.6s cubic-bezier(.2,.8,.2,1) forwards }",
    best_for: ["Counter-balance to left slide", "Call-to-action reveal"],
  },
  {
    id: "slide-in-up",
    label: "Slide up from below",
    prompt_fragment:
      "element slides vertically upward into view with soft bounce",
    css: "@keyframes slide-in-up { from { transform: translateY(40px); opacity: 0 } to { transform: translateY(0); opacity: 1 } } .slide-in-up { animation: slide-in-up 0.55s cubic-bezier(.2,.8,.2,1) forwards }",
    best_for: ["Hero text", "Lower-third callout"],
  },
  {
    id: "scale-pop",
    label: "Scale pop",
    prompt_fragment: "element scales from 0.8 to 1 with a light bounce",
    css: "@keyframes scale-pop { 0% { transform: scale(0.8); opacity: 0 } 60% { transform: scale(1.05); opacity: 1 } 100% { transform: scale(1); opacity: 1 } } .scale-pop { animation: scale-pop 0.5s ease-out forwards }",
    best_for: ["Product shot", "Icon reveal", "Stat emphasis"],
  },
  {
    id: "scale-zoom",
    label: "Scale zoom (Ken Burns style)",
    prompt_fragment:
      "element slowly zooms from scale 1 to 1.15 over full duration",
    css: "@keyframes scale-zoom { from { transform: scale(1) } to { transform: scale(1.15) } } .scale-zoom { animation: scale-zoom 5s linear forwards }",
    best_for: ["Background images", "Documentary feel", "Long holds"],
  },
  {
    id: "rotate-in",
    label: "Rotate in",
    prompt_fragment: "element rotates from -15° to 0° while fading in",
    css: "@keyframes rotate-in { from { transform: rotate(-15deg) scale(0.9); opacity: 0 } to { transform: rotate(0) scale(1); opacity: 1 } } .rotate-in { animation: rotate-in 0.6s cubic-bezier(.2,.8,.2,1) forwards }",
    best_for: ["Playful entry", "Badge reveal"],
  },
  {
    id: "blur-in",
    label: "Blur in",
    prompt_fragment:
      "element transitions from blurred+faded to crisp over ~700ms",
    css: "@keyframes blur-in { from { filter: blur(16px); opacity: 0 } to { filter: blur(0); opacity: 1 } } .blur-in { animation: blur-in 0.7s ease-out forwards }",
    best_for: ["Editorial reveal", "Focus transitions"],
  },
  {
    id: "typewriter",
    label: "Typewriter",
    prompt_fragment:
      "monospace text reveal using steps() animation; wrap in <span> with overflow:hidden; white-space:nowrap",
    css: "@keyframes typewriter { from { width: 0 } to { width: 100% } } .typewriter { display: inline-block; overflow: hidden; white-space: nowrap; animation: typewriter 2s steps(40, end) forwards }",
    best_for: ["Terminal feel", "Code overlays", "Factoid reveals"],
  },
  {
    id: "pulse",
    label: "Pulse",
    prompt_fragment: "element pulses in scale between 1 and 1.05 (infinite)",
    css: "@keyframes pulse { 0%, 100% { transform: scale(1) } 50% { transform: scale(1.05) } } .pulse { animation: pulse 1.2s ease-in-out infinite }",
    best_for: ["CTA buttons", "Attention callouts", "Live indicators"],
  },
  {
    id: "shake-attention",
    label: "Shake (attention)",
    prompt_fragment: "brief horizontal shake to draw attention",
    css: "@keyframes shake-attention { 0%, 100% { transform: translateX(0) } 25% { transform: translateX(-6px) } 75% { transform: translateX(6px) } } .shake-attention { animation: shake-attention 0.4s ease-in-out 2 }",
    best_for: ["Error emphasis", "Wake-up animation", "Alert moment"],
  },
  {
    id: "counter-up",
    label: "Counter up",
    prompt_fragment:
      "numeric counter using JS-driven seek(t): elem.textContent = Math.floor(t * targetValue / duration)",
    css: ".counter-up { font-variant-numeric: tabular-nums; font-weight: 700 }",
    best_for: ["Stat counters", "Growth metrics", "Revenue reveal"],
  },
  {
    id: "split-reveal",
    label: "Split-text reveal",
    prompt_fragment:
      "wrap each word in a <span> and stagger slide-in-up with --d CSS custom property per word",
    css: "@keyframes split-reveal { from { transform: translateY(24px); opacity: 0 } to { transform: translateY(0); opacity: 1 } } .split-reveal > span { display: inline-block; animation: split-reveal 0.5s ease-out backwards; animation-delay: var(--d, 0s) }",
    best_for: ["Headline treatment", "Mantra reveal", "Lyric overlays"],
  },
  {
    id: "parallax-drift",
    label: "Parallax drift",
    prompt_fragment:
      "slow horizontal drift over full duration for depth cue on background layers",
    css: "@keyframes parallax-drift { from { transform: translateX(0) } to { transform: translateX(-40px) } } .parallax-drift { animation: parallax-drift 8s linear forwards }",
    best_for: ["Background layer", "Depth cue", "Long scenes"],
  },
  {
    id: "lower-third",
    label: "Lower-third banner",
    prompt_fragment:
      "position:absolute; left:0; bottom:10%; slide in from left + fade in",
    css: ".lower-third { position: absolute; left: 0; bottom: 10%; padding: 1rem 2rem; background: rgba(0,0,0,0.8); color: white; animation: slide-in-left 0.6s cubic-bezier(.2,.8,.2,1) forwards }",
    best_for: ["Speaker name", "Location chyron", "Source citation"],
  },
] as const;

/** IDs for testing enum coverage. */
export const HTML_MOTION_IDS: readonly string[] = HTML_MOTION_PATTERNS.map(
  (p) => p.id,
);

/**
 * Lookup helper. Returns undefined if not found — caller decides fallback.
 */
export function getMotionPattern(id: string): HtmlMotionPattern | undefined {
  return HTML_MOTION_PATTERNS.find((p) => p.id === id);
}

/**
 * Render a compact prompt-friendly catalog string. Used by HTML-author LLM
 * prompts to anchor motion choices to a controlled vocabulary.
 */
export function catalogToPrompt(limit = 8): string {
  const entries = HTML_MOTION_PATTERNS.slice(0, limit).map(
    (p) => `  - ${p.id}: ${p.prompt_fragment}`,
  );
  return [
    "Available motion patterns (paste CSS verbatim; no substitution):",
    ...entries,
  ].join("\n");
}

/**
 * Meta-validator — every entry has all required non-empty fields and no
 * `{{...}}` placeholder leaks. Runs in tests (same shape as S2a validators).
 */
export function validateCatalog(): void {
  const PLACEHOLDER = /\{\{.*?\}\}/;
  for (const p of HTML_MOTION_PATTERNS) {
    if (!p.id || typeof p.id !== "string")
      throw new Error(`html-motion: bad id ${JSON.stringify(p)}`);
    if (!p.label || !p.prompt_fragment || !p.css) {
      throw new Error(`html-motion: ${p.id} missing required field`);
    }
    if (!Array.isArray(p.best_for) || p.best_for.length === 0) {
      throw new Error(`html-motion: ${p.id} best_for empty`);
    }
    if (
      PLACEHOLDER.test(p.prompt_fragment) ||
      PLACEHOLDER.test(p.css) ||
      PLACEHOLDER.test(p.label)
    ) {
      throw new Error(`html-motion: ${p.id} contains unresolved placeholder`);
    }
  }
  const ids = new Set<string>();
  for (const p of HTML_MOTION_PATTERNS) {
    if (ids.has(p.id)) throw new Error(`html-motion: duplicate id ${p.id}`);
    ids.add(p.id);
  }
}
