import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("../inference/adapter.js", () => ({
  infer: vi.fn(),
}));

import { infer } from "../inference/adapter.js";
import {
  extractProvenance,
  classifySources,
  condenseSearchResults,
} from "./provenance.js";
import type { ChatMessage } from "../inference/adapter.js";

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers — build realistic message arrays
// ---------------------------------------------------------------------------

function searchToolCall(id: string, query: string): ChatMessage {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id,
        type: "function" as const,
        function: {
          name: "web_search",
          arguments: JSON.stringify({ query }),
        },
      },
    ],
  };
}

function searchResult(
  toolCallId: string,
  results: Array<{ title: string; url: string; description: string }>,
): ChatMessage {
  return {
    role: "tool",
    tool_call_id: toolCallId,
    content: JSON.stringify({ query: "test", results, total: results.length }),
  };
}

function webReadToolCall(id: string, url: string): ChatMessage {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id,
        type: "function" as const,
        function: {
          name: "web_read",
          arguments: JSON.stringify({ url }),
        },
      },
    ],
  };
}

function webReadResult(
  toolCallId: string,
  url: string,
  content: string,
): ChatMessage {
  return {
    role: "tool",
    tool_call_id: toolCallId,
    content: JSON.stringify({ url, content, truncated: false }),
  };
}

function exaSearchToolCall(id: string, query: string): ChatMessage {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id,
        type: "function" as const,
        function: {
          name: "exa_search",
          arguments: JSON.stringify({ query }),
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// extractProvenance
// ---------------------------------------------------------------------------

describe("extractProvenance", () => {
  it("extracts web_search results with URLs and queries", () => {
    const messages: ChatMessage[] = [
      searchToolCall("tc-1", "quantum computing basics"),
      searchResult("tc-1", [
        {
          title: "Quantum 101",
          url: "https://q.com/101",
          description: "Intro to QC",
        },
        {
          title: "QC Guide",
          url: "https://q.com/guide",
          description: "Full guide",
        },
      ]),
    ];

    const extraction = extractProvenance(messages);
    expect(extraction.records).toHaveLength(2);
    expect(extraction.records[0].tool_name).toBe("web_search");
    expect(extraction.records[0].url).toBe("https://q.com/101");
    expect(extraction.records[0].query).toBe("quantum computing basics");
    expect(extraction.records[0].content_hash).toBeTruthy();
    expect(extraction.searchQueries).toEqual(["quantum computing basics"]);
    expect(extraction.searchResultUrls.has("https://q.com/101")).toBe(true);
    expect(extraction.searchResultUrls.has("https://q.com/guide")).toBe(true);
  });

  it("extracts web_read URLs and marks them as fetched", () => {
    const messages: ChatMessage[] = [
      webReadToolCall("tc-2", "https://example.com/article"),
      webReadResult(
        "tc-2",
        "https://example.com/article",
        "Article content here",
      ),
    ];

    const extraction = extractProvenance(messages);
    expect(extraction.records).toHaveLength(1);
    expect(extraction.records[0].tool_name).toBe("web_read");
    expect(extraction.records[0].url).toBe("https://example.com/article");
    expect(extraction.records[0].query).toBeNull();
    expect(extraction.fetchedUrls.has("https://example.com/article")).toBe(
      true,
    );
  });

  it("extracts exa_search results", () => {
    const messages: ChatMessage[] = [
      exaSearchToolCall("tc-3", "AI safety research"),
      {
        role: "tool",
        tool_call_id: "tc-3",
        content: JSON.stringify({
          results: [
            {
              title: "Safety",
              url: "https://ai-safety.org",
              description: "Research hub",
            },
          ],
        }),
      },
    ];

    const extraction = extractProvenance(messages);
    expect(extraction.records).toHaveLength(1);
    expect(extraction.records[0].tool_name).toBe("exa_search");
    expect(extraction.searchQueries).toEqual(["AI safety research"]);
  });

  it("returns empty for conversations with no research tools", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "tc-4",
            type: "function" as const,
            function: {
              name: "user_fact_set",
              arguments: '{"key":"test","value":"val"}',
            },
          },
        ],
      },
      { role: "tool", tool_call_id: "tc-4", content: '{"ok":true}' },
    ];

    const extraction = extractProvenance(messages);
    expect(extraction.records).toHaveLength(0);
    expect(extraction.searchQueries).toHaveLength(0);
  });

  it("handles malformed tool arguments gracefully", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "tc-5",
            type: "function" as const,
            function: { name: "web_search", arguments: "not-json" },
          },
        ],
      },
      { role: "tool", tool_call_id: "tc-5", content: '{"results":[]}' },
    ];

    const extraction = extractProvenance(messages);
    // Should not crash, query will be null
    expect(extraction.records).toHaveLength(0); // no results in the parsed JSON
    expect(extraction.searchQueries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// classifySources
// ---------------------------------------------------------------------------

describe("classifySources", () => {
  it("marks fetched URLs as verified", () => {
    const extraction = extractProvenance([
      webReadToolCall("tc-1", "https://verified.com/page"),
      webReadResult("tc-1", "https://verified.com/page", "Content"),
    ]);

    const classified = classifySources(
      extraction,
      "Check https://verified.com/page for details.",
    );
    const verifiedRecords = classified.filter((r) => r.status === "verified");
    expect(verifiedRecords).toHaveLength(1);
    expect(verifiedRecords[0].url).toBe("https://verified.com/page");
  });

  it("marks unfetched search URLs cited in output as inferred", () => {
    const extraction = extractProvenance([
      searchToolCall("tc-1", "test query"),
      searchResult("tc-1", [
        {
          title: "Result",
          url: "https://search-result.com",
          description: "A result",
        },
      ]),
    ]);

    const classified = classifySources(
      extraction,
      "According to https://search-result.com the answer is 42.",
    );
    const inferred = classified.filter((r) => r.status === "inferred");
    expect(inferred.length).toBeGreaterThanOrEqual(1);
    expect(inferred[0].url).toBe("https://search-result.com");
  });

  it("marks untraced URLs in output as unverified", () => {
    const extraction = extractProvenance([
      searchToolCall("tc-1", "test"),
      searchResult("tc-1", [
        { title: "R", url: "https://known.com", description: "Known" },
      ]),
    ]);

    const classified = classifySources(
      extraction,
      "See https://fabricated.com/fake for more info.",
    );
    const unverified = classified.filter(
      (r) =>
        r.status === "unverified" && r.url === "https://fabricated.com/fake",
    );
    expect(unverified).toHaveLength(1);
    expect(unverified[0].tool_name).toBe("output_citation");
  });

  it("marks query-only records as inferred", () => {
    // Search that returns no parseable results
    const messages: ChatMessage[] = [
      searchToolCall("tc-1", "some query"),
      { role: "tool", tool_call_id: "tc-1", content: "Error: rate limited" },
    ];
    const extraction = extractProvenance(messages);
    const classified = classifySources(extraction, "No URLs cited.");
    const inferred = classified.filter((r) => r.status === "inferred");
    expect(inferred).toHaveLength(1);
    expect(inferred[0].query).toBe("some query");
  });
});

// ---------------------------------------------------------------------------
// condenseSearchResults
// ---------------------------------------------------------------------------

describe("condenseSearchResults", () => {
  it("returns null when fewer than 3 search queries", async () => {
    const extraction = extractProvenance([
      searchToolCall("tc-1", "query 1"),
      searchResult("tc-1", []),
      searchToolCall("tc-2", "query 2"),
      searchResult("tc-2", []),
    ]);

    const result = await condenseSearchResults(extraction, []);
    expect(result).toBeNull();
  });

  it("calls infer for 3+ search queries and returns summary", async () => {
    const messages: ChatMessage[] = [
      searchToolCall("tc-1", "query 1"),
      searchResult("tc-1", [
        { title: "R1", url: "https://r1.com", description: "Result 1" },
      ]),
      searchToolCall("tc-2", "query 2"),
      searchResult("tc-2", [
        { title: "R2", url: "https://r2.com", description: "Result 2" },
      ]),
      searchToolCall("tc-3", "query 3"),
      searchResult("tc-3", [
        { title: "R3", url: "https://r3.com", description: "Result 3" },
      ]),
    ];

    const extraction = extractProvenance(messages);
    expect(extraction.searchQueries).toHaveLength(3);

    const mockInfer = vi.mocked(infer);
    mockInfer.mockResolvedValueOnce({
      content: "Condensed: R1, R2, R3",
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      provider: "test",
      latency_ms: 100,
    });

    const result = await condenseSearchResults(extraction, messages);
    expect(result).not.toBeNull();
    expect(result!.summary).toBe("Condensed: R1, R2, R3");
    expect(result!.usage.promptTokens).toBe(100);
    expect(result!.usage.completionTokens).toBe(50);
    expect(mockInfer).toHaveBeenCalledOnce();
  });

  it("returns null when infer fails", async () => {
    const messages: ChatMessage[] = [
      searchToolCall("tc-1", "q1"),
      searchResult("tc-1", [
        { title: "R", url: "https://r.com", description: "R" },
      ]),
      searchToolCall("tc-2", "q2"),
      searchResult("tc-2", [
        { title: "R", url: "https://r2.com", description: "R" },
      ]),
      searchToolCall("tc-3", "q3"),
      searchResult("tc-3", [
        { title: "R", url: "https://r3.com", description: "R" },
      ]),
    ];

    const extraction = extractProvenance(messages);

    const mockInfer = vi.mocked(infer);
    mockInfer.mockRejectedValueOnce(new Error("LLM unavailable"));

    const result = await condenseSearchResults(extraction, messages);
    expect(result).toBeNull();
  });
});
