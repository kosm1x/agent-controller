/**
 * AI Writing Humanization Tool (v6.3 W1)
 *
 * Detects and removes AI writing patterns using the avoid-ai-writing
 * framework (109 tiered words, 36 pattern categories).
 * Two modes: "detect" (audit) and "rewrite" (edit).
 */

import type { Tool } from "../types.js";

const HUMANIZE_PROMPT = `You are a writing quality auditor. Analyze the text for AI-generated writing patterns and either detect issues or rewrite to sound human.

## Detection Rules

### Tier 1 Words (ALWAYS flag):
delve, landscape, tapestry, realm, paradigm, embark, beacon, testament to, robust, comprehensive, cutting-edge, leverage, pivotal, underscores, meticulous, seamless, game-changer, utilize, nestled, vibrant, thriving, showcasing, deep dive, unpack, bustling, intricate, complexities, ever-evolving, holistic, actionable, impactful, synergy, interplay, commence, ascertain, endeavor

### Chatbot Artifacts (ALWAYS remove):
"I hope this helps", "Great question!", "Certainly!", "Absolutely!", "Feel free to reach out", "Let me think step by step", "Breaking this down", "Here's my thought process", "In conclusion", "In summary"

### Structural Signals:
- Uniform sentence length (all 15-25 words) = robotic
- More than 3 headings per 300 words
- Em dashes: target zero, max 1 per 1000 words
- "Moreover", "Furthermore", "Additionally" → use "and/also"

### For REWRITE mode:
- Replace flagged words with natural alternatives
- Mix sentence length: short punchy (3-8 words) with flowing (20+)
- Keep natural disfluency — don't over-polish
- Preserve the original meaning exactly

### For DETECT mode:
- List each issue with line reference
- Categorize: vocabulary / structure / chatbot artifact
- Give a 1-10 humanness score (10 = fully human)`;

export const humanizeTextTool: Tool = {
  name: "humanize_text",
  definition: {
    type: "function",
    function: {
      name: "humanize_text",
      description: `Detect and remove AI writing patterns from text.

USE WHEN:
- User asks to "humanize", "clean up", or "make it sound natural"
- Before publishing content to WordPress, social media, or email
- Reviewing AI-generated drafts

Two modes:
- detect: audit text, report issues + humanness score (no changes)
- rewrite: fix all issues, return cleaned version`,
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "Text to analyze or rewrite",
          },
          mode: {
            type: "string",
            enum: ["detect", "rewrite"],
            description:
              "detect = audit only, rewrite = fix issues (default: rewrite)",
          },
        },
        required: ["text"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const text = args.text as string;
    if (!text) return JSON.stringify({ error: "text is required" });

    const mode = (args.mode as string) || "rewrite";

    try {
      const { infer } = await import("../../inference/adapter.js");

      const result = await infer(
        {
          messages: [
            { role: "system", content: HUMANIZE_PROMPT },
            {
              role: "user",
              content: `Mode: ${mode.toUpperCase()}\n\nText:\n${text}`,
            },
          ],
          temperature: 0.4,
          max_tokens: Math.max(500, Math.round(text.length * 1.5)),
        },
        { providerName: "fallback" },
      );

      return JSON.stringify({
        mode,
        result: result.content ?? "No output generated.",
        original_length: text.length,
      });
    } catch (err) {
      return JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
};
