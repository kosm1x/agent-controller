/**
 * v7.12 — svg_html prompt constants.
 *
 * Ported from Cocoon-AI's architecture-diagram-generator skill.md:
 * palette + spacing/layout rules + SVG craft tips (arrow z-ordering,
 * single-file HTML output pattern). ~40 lines of distilled prompt
 * guidance that the LLM composes inline SVG against.
 */

export const COCOON_PALETTE_DARK = `
## Color palette (dark theme, slate-950 base)

Semantic by component type — never hardcode arbitrary hex:

- Background: #0f172a (slate-950)
- Surface / card fill: #1e293b (slate-800)
- Border / outline: #334155 (slate-700)
- Text primary: #e2e8f0 (slate-200)
- Text muted: #94a3b8 (slate-400)
- Accent primary (highlighted component): #38bdf8 (sky-400)
- Accent secondary (data flow edges): #a78bfa (violet-400)
- Success (produced/shipped component): #34d399 (emerald-400)
- Warning (degraded/in-progress): #fbbf24 (amber-400)
- Danger (deprecated/broken path): #f87171 (red-400)

Font family throughout: "JetBrains Mono", "Menlo", "Consolas", monospace.
`.trim();

export const COCOON_PALETTE_LIGHT = `
## Color palette (light theme, zinc-50 base)

- Background: #fafafa (zinc-50)
- Surface / card fill: #ffffff
- Border / outline: #d4d4d8 (zinc-300)
- Text primary: #18181b (zinc-900)
- Text muted: #71717a (zinc-500)
- Accent primary: #0284c7 (sky-600)
- Accent secondary: #7c3aed (violet-600)
- Success: #059669 (emerald-600)
- Warning: #d97706 (amber-600)
- Danger: #dc2626 (red-600)

Font family: "JetBrains Mono", "Menlo", "Consolas", monospace.
`.trim();

export const COCOON_LAYOUT_RULES = `
## Layout rules

- Components are rectangles. Use explicit x/y/width/height pixel coordinates.
- Leave at least 40px vertical spacing between stacked components.
- Leave at least 60px horizontal spacing between side-by-side components.
- Titles/labels: centered within components, 14-16px font size, text-primary.
- Component subtitles (role, type): 11-12px, text-muted.
- Grid: anchor everything to a 20px grid (multiples of 20 for x/y).
- Canvas padding: at minimum 40px on each side of the outermost component.

## SVG craft — arrow z-ordering

Arrows connecting components must visually pass UNDER component fills but OVER
the canvas background. Pattern: draw arrows FIRST, then overlay a white/dark
<rect> at each component's position with fill=surface color, then draw the
component contents on top. This creates the illusion that arrows "enter" and
"exit" components without visible line intersections through the component body.

## Output shape

Produce a SINGLE self-contained HTML file:
- <!doctype html> + <html> + <head> with <title> and inline <style> (for hover
  states, fonts); <body> with a single <svg> and a small legend block beneath.
- Use viewBox="0 0 W H" on the <svg> so the diagram scales; don't hardcode
  width/height attributes at the <svg> level.
- The file must be openable directly in a browser with no external fetches —
  no remote CSS, no remote fonts, no CDN scripts. Fonts via font-family stack
  only (system fallbacks).
`.trim();

/** Full system prompt for svg_html generation. Concatenates palette + layout
 *  + the description-to-SVG task framing. */
export function svgHtmlSystemPrompt(theme: "dark" | "light"): string {
  const palette =
    theme === "light" ? COCOON_PALETTE_LIGHT : COCOON_PALETTE_DARK;
  return `You are a diagram renderer that outputs a single self-contained HTML file with inline SVG. No external dependencies, no markdown fences, no explanation — raw HTML only.

${palette}

${COCOON_LAYOUT_RULES}

Respond with the complete HTML document starting with <!doctype html>. Do not wrap in \`\`\`html fences. Do not add commentary before or after.`;
}
