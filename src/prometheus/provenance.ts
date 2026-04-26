/**
 * Research Provenance — Extraction, classification, and condensation.
 *
 * Pure functions that extract provenance data from ChatMessage[] arrays
 * produced by inferWithTools. Does NOT touch the database — callers persist.
 */

import { createHash } from "crypto";
import { infer } from "../inference/adapter.js";
import type { ChatMessage } from "../inference/adapter.js";
import type { TokenUsage } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEARCH_TOOLS = new Set(["web_search", "exa_search"]);
const FETCH_TOOLS = new Set(["web_read"]);

/** Regex to detect URLs in LLM output text. */
const URL_REGEX = /https?:\/\/[^\s)>"'\]]+/g;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RawProvenance {
  tool_name: string;
  url: string | null;
  query: string | null;
  content_hash: string | null;
  snippet: string | null;
}

export interface ClassifiedProvenance extends RawProvenance {
  status: "verified" | "inferred" | "unverified";
}

export interface ProvenanceExtraction {
  records: RawProvenance[];
  fetchedUrls: Set<string>;
  searchResultUrls: Set<string>;
  searchQueries: string[];
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Extract provenance data from a ChatMessage[] conversation.
 * Iterates assistant tool_calls and their paired tool results to find
 * research tool usage (web_search, exa_search, web_read).
 */
export function extractProvenance(
  messages: ChatMessage[],
): ProvenanceExtraction {
  const records: RawProvenance[] = [];
  const fetchedUrls = new Set<string>();
  const searchResultUrls = new Set<string>();
  const searchQueries: string[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant" || !msg.tool_calls) continue;

    for (const tc of msg.tool_calls) {
      const toolName = tc.function?.name;
      if (!toolName) continue;

      const isSearch = SEARCH_TOOLS.has(toolName);
      const isFetch = FETCH_TOOLS.has(toolName);
      if (!isSearch && !isFetch) continue;

      // Find the paired tool result message
      const resultMsg = messages
        .slice(i + 1)
        .find((m) => m.role === "tool" && m.tool_call_id === tc.id);
      const resultContent =
        typeof resultMsg?.content === "string" ? resultMsg.content : "";

      // Parse tool arguments
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        // Malformed args — skip
      }

      const hash = resultContent
        ? createHash("sha256").update(resultContent).digest("hex").slice(0, 8)
        : null;
      const snippet = resultContent ? resultContent.slice(0, 200) : null;

      if (isSearch) {
        const query = typeof args.query === "string" ? args.query : null;
        if (query) searchQueries.push(query);

        // Parse search result URLs
        try {
          const parsed = JSON.parse(resultContent);
          const results = Array.isArray(parsed.results) ? parsed.results : [];
          for (const r of results) {
            if (typeof r.url === "string") {
              searchResultUrls.add(r.url);
              records.push({
                tool_name: toolName,
                url: r.url,
                query,
                content_hash: hash,
                snippet:
                  typeof r.description === "string"
                    ? r.description.slice(0, 200)
                    : snippet,
              });
            }
          }
        } catch {
          // Could not parse search results — record the query at least
          records.push({
            tool_name: toolName,
            url: null,
            query,
            content_hash: hash,
            snippet,
          });
        }
      } else if (isFetch) {
        const url = typeof args.url === "string" ? args.url : null;
        if (url) fetchedUrls.add(url);

        records.push({
          tool_name: toolName,
          url,
          query: null,
          content_hash: hash,
          snippet,
        });
      }
    }
  }

  return { records, fetchedUrls, searchResultUrls, searchQueries };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Classify provenance records into verified/inferred/unverified based on
 * whether their URLs were fetched, found in search results, or untraced.
 *
 * Also scans the output text for URLs not found in any tool call (unverified).
 */
export function classifySources(
  extraction: ProvenanceExtraction,
  outputText: string,
): ClassifiedProvenance[] {
  const classified: ClassifiedProvenance[] = [];

  // Classify existing records
  for (const record of extraction.records) {
    let status: ClassifiedProvenance["status"] = "unverified";

    if (record.url && extraction.fetchedUrls.has(record.url)) {
      status = "verified";
    } else if (record.url && extraction.searchResultUrls.has(record.url)) {
      // Inferred = appeared in search results (whether or not cited in output)
      status = "inferred";
    }
    // Records without URLs (query-only) default to inferred if they have a query
    if (!record.url && record.query) {
      status = "inferred";
    }

    classified.push({ ...record, status });
  }

  // Scan output for URLs not traced to any tool call
  const allTrackedUrls = new Set([
    ...extraction.fetchedUrls,
    ...extraction.searchResultUrls,
  ]);
  const outputUrls = outputText.match(URL_REGEX) ?? [];
  const seen = new Set<string>();

  for (const url of outputUrls) {
    // Clean trailing punctuation
    const cleaned = url.replace(/[.,;:!?)]+$/, "");
    if (seen.has(cleaned) || allTrackedUrls.has(cleaned)) continue;
    seen.add(cleaned);

    classified.push({
      tool_name: "output_citation",
      url: cleaned,
      query: null,
      status: "unverified",
      content_hash: null,
      snippet: null,
    });
  }

  return classified;
}

// ---------------------------------------------------------------------------
// Condensation
// ---------------------------------------------------------------------------

const CONDENSE_SYSTEM = `You condense multiple web search results into a unified source summary.
Remove duplicates, rank by relevance, and list each unique source with:
- URL
- Title
- Key finding (1 sentence)
Respond ONLY with the condensed list. Max 15 sources.`;

/**
 * Condense multi-query search results into a unified summary.
 * Only triggers when 3+ distinct search queries were made.
 * Returns null if below threshold.
 */
export async function condenseSearchResults(
  extraction: ProvenanceExtraction,
  messages: ChatMessage[],
): Promise<{ summary: string; usage: TokenUsage } | null> {
  if (extraction.searchQueries.length < 3) return null;

  // Collect search result contents, deduplicate by content_hash
  const seenHashes = new Set<string>();
  const searchContents: string[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant" || !msg.tool_calls) continue;

    for (const tc of msg.tool_calls) {
      const toolName = tc.function?.name;
      if (!toolName || !SEARCH_TOOLS.has(toolName)) continue;

      const resultMsg = messages
        .slice(i + 1)
        .find((m) => m.role === "tool" && m.tool_call_id === tc.id);
      const content =
        typeof resultMsg?.content === "string" ? resultMsg.content : "";
      if (!content) continue;

      const hash = createHash("sha256")
        .update(content)
        .digest("hex")
        .slice(0, 8);
      if (seenHashes.has(hash)) continue;
      seenHashes.add(hash);

      // Truncate each result to 1K to prevent prompt bloat
      searchContents.push(content.slice(0, 1000));
    }
  }

  if (searchContents.length === 0) return null;

  const userContent =
    `## Search queries made\n${extraction.searchQueries.map((q, i) => `${i + 1}. ${q}`).join("\n")}\n\n` +
    `## Raw search results (${searchContents.length} unique)\n${searchContents.join("\n---\n")}`;

  try {
    const response = await infer({
      messages: [
        { role: "system", content: CONDENSE_SYSTEM },
        { role: "user", content: userContent },
      ],
      temperature: 0.2,
      max_tokens: 500,
    });

    return {
      summary: response.content ?? "",
      usage: {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        ...(response.usage.cache_read_tokens !== undefined && {
          cacheReadTokens: response.usage.cache_read_tokens,
        }),
        ...(response.usage.cache_creation_tokens !== undefined && {
          cacheCreationTokens: response.usage.cache_creation_tokens,
        }),
      },
    };
  } catch (err) {
    console.warn(
      `[provenance] Condensation failed: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}
