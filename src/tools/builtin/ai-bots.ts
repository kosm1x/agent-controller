/**
 * AI bots reference — 28 user-agent entries for robots.txt auditing.
 *
 * Source: Auriti Labs ai-bots reference (MIT), extended with operator
 * documentation URLs. Used by `seo_robots_audit` to classify robots.txt
 * coverage as training-crawler vs citation-crawler vs both.
 *
 * Purpose taxonomy:
 *   - "training": scrapes pages for LLM pre/post-training. Blocking
 *     prevents your content from being ingested into future models.
 *   - "citation": fetches live to answer a user's query. Blocking prevents
 *     the LLM-backed product from citing you in real-time responses.
 *   - "both": single bot does both (rare; e.g. early GPTBot was dual-use).
 */

export interface AIBot {
  name: string;
  user_agent: string;
  operator: string;
  purpose: "training" | "citation" | "both";
  docs_url: string;
}

export const AI_BOTS: readonly AIBot[] = [
  // OpenAI
  {
    name: "GPTBot",
    user_agent: "GPTBot",
    operator: "OpenAI",
    purpose: "training",
    docs_url: "https://platform.openai.com/docs/gptbot",
  },
  {
    name: "OAI-SearchBot",
    user_agent: "OAI-SearchBot",
    operator: "OpenAI",
    purpose: "citation",
    docs_url: "https://platform.openai.com/docs/bots",
  },
  {
    name: "ChatGPT-User",
    user_agent: "ChatGPT-User",
    operator: "OpenAI",
    purpose: "citation",
    docs_url: "https://platform.openai.com/docs/plugins/bot",
  },
  // Anthropic
  {
    name: "ClaudeBot",
    user_agent: "ClaudeBot",
    operator: "Anthropic",
    purpose: "training",
    docs_url: "https://support.anthropic.com/en/articles/8896518",
  },
  {
    name: "Claude-Web",
    user_agent: "Claude-Web",
    operator: "Anthropic",
    purpose: "citation",
    docs_url: "https://support.anthropic.com/en/articles/8896518",
  },
  {
    name: "anthropic-ai",
    user_agent: "anthropic-ai",
    operator: "Anthropic",
    purpose: "training",
    docs_url: "https://support.anthropic.com/en/articles/8896518",
  },
  // Google
  {
    name: "Google-Extended",
    user_agent: "Google-Extended",
    operator: "Google",
    purpose: "training",
    docs_url:
      "https://developers.google.com/search/docs/crawling-indexing/overview-google-crawlers#google-extended",
  },
  {
    name: "GoogleOther",
    user_agent: "GoogleOther",
    operator: "Google",
    purpose: "both",
    docs_url:
      "https://developers.google.com/search/docs/crawling-indexing/overview-google-crawlers#googleother",
  },
  // Perplexity
  {
    name: "PerplexityBot",
    user_agent: "PerplexityBot",
    operator: "Perplexity",
    purpose: "citation",
    docs_url: "https://docs.perplexity.ai/guides/bots",
  },
  {
    name: "Perplexity-User",
    user_agent: "Perplexity-User",
    operator: "Perplexity",
    purpose: "citation",
    docs_url: "https://docs.perplexity.ai/guides/bots",
  },
  // Microsoft
  {
    name: "Bingbot",
    user_agent: "Bingbot",
    operator: "Microsoft",
    purpose: "both",
    docs_url:
      "https://www.bing.com/webmasters/help/which-crawlers-does-bing-use-8c184ec0",
  },
  {
    name: "MSNBot",
    user_agent: "MSNBot",
    operator: "Microsoft",
    purpose: "training",
    docs_url:
      "https://www.bing.com/webmasters/help/which-crawlers-does-bing-use-8c184ec0",
  },
  // Apple
  {
    name: "Applebot",
    user_agent: "Applebot",
    operator: "Apple",
    purpose: "citation",
    docs_url: "https://support.apple.com/en-us/119829",
  },
  {
    name: "Applebot-Extended",
    user_agent: "Applebot-Extended",
    operator: "Apple",
    purpose: "training",
    docs_url: "https://support.apple.com/en-us/119829",
  },
  // Meta
  {
    name: "FacebookBot",
    user_agent: "FacebookBot",
    operator: "Meta",
    purpose: "citation",
    docs_url: "https://developers.facebook.com/docs/sharing/bot/",
  },
  {
    name: "Meta-ExternalAgent",
    user_agent: "Meta-ExternalAgent",
    operator: "Meta",
    purpose: "both",
    docs_url:
      "https://developers.facebook.com/docs/sharing/webmasters/web-crawlers",
  },
  {
    name: "Meta-ExternalFetcher",
    user_agent: "Meta-ExternalFetcher",
    operator: "Meta",
    purpose: "citation",
    docs_url:
      "https://developers.facebook.com/docs/sharing/webmasters/web-crawlers",
  },
  // ByteDance
  {
    name: "Bytespider",
    user_agent: "Bytespider",
    operator: "ByteDance",
    purpose: "training",
    docs_url: "https://bytespider.byteoversea.com",
  },
  // Common Crawl (used by many model-training pipelines)
  {
    name: "CCBot",
    user_agent: "CCBot",
    operator: "Common Crawl",
    purpose: "training",
    docs_url: "https://commoncrawl.org/faq",
  },
  // Amazon
  {
    name: "Amazonbot",
    user_agent: "Amazonbot",
    operator: "Amazon",
    purpose: "both",
    docs_url: "https://developer.amazon.com/support/amazonbot",
  },
  // DuckDuckGo (uses Bing under the hood but its own crawler exists)
  {
    name: "DuckDuckBot",
    user_agent: "DuckDuckBot",
    operator: "DuckDuckGo",
    purpose: "citation",
    docs_url: "https://duckduckgo.com/duckduckbot",
  },
  // Yandex
  {
    name: "YandexBot",
    user_agent: "YandexBot",
    operator: "Yandex",
    purpose: "both",
    docs_url:
      "https://yandex.com/support/webmaster/robot-workings/user-agent.html",
  },
  // Cohere
  {
    name: "cohere-ai",
    user_agent: "cohere-ai",
    operator: "Cohere",
    purpose: "training",
    docs_url: "https://docs.cohere.com",
  },
  // You.com
  {
    name: "YouBot",
    user_agent: "YouBot",
    operator: "You.com",
    purpose: "citation",
    docs_url: "https://about.you.com/youbot/",
  },
  // AI2 (Allen Institute)
  {
    name: "AI2Bot",
    user_agent: "AI2Bot",
    operator: "Allen Institute for AI",
    purpose: "training",
    docs_url: "https://allenai.org/crawler",
  },
  // Diffbot
  {
    name: "Diffbot",
    user_agent: "Diffbot",
    operator: "Diffbot",
    purpose: "both",
    docs_url: "https://docs.diffbot.com/docs/en/guides-cn-diffbot-crawler",
  },
  // Kagi
  {
    name: "Kagibot",
    user_agent: "Kagibot",
    operator: "Kagi",
    purpose: "citation",
    docs_url: "https://kagi.com/bot",
  },
  // Brave (already a search engine; used for LLM-backed answers)
  {
    name: "BraveBot",
    user_agent: "BraveBot",
    operator: "Brave Software",
    purpose: "citation",
    docs_url: "https://search.brave.com/help/bravebot",
  },
];

/** Case-insensitive lookup by user-agent token. */
export function findBot(userAgent: string): AIBot | undefined {
  const needle = userAgent.trim().toLowerCase();
  return AI_BOTS.find((b) => b.user_agent.toLowerCase() === needle);
}
