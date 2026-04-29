import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  geminiUploadTool,
  geminiResearchTool,
  geminiAudioOverviewTool,
} from "./gemini-research.js";

// ---------------------------------------------------------------------------
// Global mocks
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock DB layer
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrepare: any = vi.fn(() => ({
  run: vi.fn(() => ({ changes: 0 })),
  get: vi.fn(() => null),
  all: vi.fn(() => []),
}));
vi.mock("../../db/index.js", () => ({
  getDatabase: () => ({
    exec: vi.fn(),
    prepare: mockPrepare,
  }),
}));

vi.mock("../../db/user-facts.js", () => ({
  getUserFacts: () => [{ key: "gemini_api_key", value: "test-key-123" }],
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: vi.fn(() => Buffer.from("fake pdf content")),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => true),
  };
});

beforeEach(() => {
  mockFetch.mockReset();
  mockPrepare.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ACTIVE_FILE = {
  name: "files/abc123",
  display_name: "test.pdf",
  uri: "https://generativelanguage.googleapis.com/v1beta/files/abc123",
  mime_type: "application/pdf",
  size_bytes: 1024,
  state: "ACTIVE",
  expires_at: new Date(Date.now() + 86400000).toISOString(),
  created_at: new Date().toISOString(),
};

function mockActiveFiles(files = [ACTIVE_FILE]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockPrepare.mockImplementation((sql: string): any => {
    if (sql.includes("SELECT") && sql.includes("gemini_files")) {
      return {
        run: vi.fn(() => ({ changes: 0 })),
        get: vi.fn(() => (files.length > 0 ? files[0] : null)),
        all: vi.fn(() => files),
      };
    }
    return {
      run: vi.fn(() => ({ changes: 0 })),
      get: vi.fn(() => null),
      all: vi.fn(() => []),
    };
  });
}

// ---------------------------------------------------------------------------
// gemini_upload
// ---------------------------------------------------------------------------

describe("gemini_upload", () => {
  it("has consistent name", () => {
    expect(geminiUploadTool.name).toBe("gemini_upload");
    expect(geminiUploadTool.definition.function.name).toBe("gemini_upload");
  });

  it("uploads a local file successfully", async () => {
    // Phase 1: start session — returns x-goog-upload-url in headers
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: {
        get: (k: string) =>
          k.toLowerCase() === "x-goog-upload-url"
            ? "https://upload.example.com/session/abc"
            : null,
      },
      text: async () => "",
    });
    // Phase 2: upload bytes — returns the file resource as JSON text
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          file: {
            name: "files/abc123",
            uri: "https://generativelanguage.googleapis.com/v1beta/files/abc123",
            mimeType: "application/pdf",
            sizeBytes: 1024,
            state: "ACTIVE",
            expirationTime: "2026-04-01T00:00:00Z",
          },
        }),
    });

    const result = JSON.parse(
      await geminiUploadTool.execute({ source: "/tmp/test.pdf" }),
    );
    expect(result.success).toBe(true);
    expect(result.name).toBe("files/abc123");
    expect(result.state).toBe("ACTIVE");
    expect(result.display_name).toBe("test.pdf");
  });

  it("handles upload HTTP error", async () => {
    // Phase 1 fails with text/plain 403 (the real-world Gemini behaviour
    // that previously masked itself as a JSON-parse exception)
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => "Forbidden — quota exceeded",
    });

    const result = JSON.parse(
      await geminiUploadTool.execute({ source: "/tmp/test.pdf" }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("403");
    expect(result.error).toContain("Forbidden");
  });

  it("downloads URL before uploading", async () => {
    // Mock URL download
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(100),
    });
    // Phase 1: start session
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: {
        get: (k: string) =>
          k.toLowerCase() === "x-goog-upload-url"
            ? "https://upload.example.com/session/url"
            : null,
      },
      text: async () => "",
    });
    // Phase 2: upload bytes
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          file: {
            name: "files/url123",
            uri: "https://generativelanguage.googleapis.com/v1beta/files/url123",
            mimeType: "application/pdf",
            sizeBytes: 100,
            state: "ACTIVE",
            expirationTime: "2026-04-01T00:00:00Z",
          },
        }),
    });

    const result = JSON.parse(
      await geminiUploadTool.execute({
        source: "https://example.com/doc.pdf",
      }),
    );
    expect(result.success).toBe(true);
    // 1 download + 2 upload phases = 3 fetches
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("handles URL download failure", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    const result = JSON.parse(
      await geminiUploadTool.execute({
        source: "https://example.com/missing.pdf",
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("404");
  });
});

// ---------------------------------------------------------------------------
// gemini_research
// ---------------------------------------------------------------------------

describe("gemini_research", () => {
  it("has consistent name", () => {
    expect(geminiResearchTool.name).toBe("gemini_research");
    expect(geminiResearchTool.definition.function.name).toBe("gemini_research");
  });

  it("returns analysis with default format", async () => {
    mockActiveFiles();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: "The document discusses economic impacts..." }],
            },
          },
        ],
        usageMetadata: { totalTokenCount: 500 },
      }),
    });

    const result = JSON.parse(
      await geminiResearchTool.execute({
        query: "What are the key findings?",
        format: "answer",
      }),
    );
    expect(result.success).toBe(true);
    expect(result.content).toContain("economic impacts");
    expect(result.format).toBe("answer");
    expect(result.files_used).toEqual(["test.pdf"]);
  });

  it("returns error when no files available", async () => {
    mockActiveFiles([]);

    const result = JSON.parse(
      await geminiResearchTool.execute({ query: "test" }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("upload");
  });

  it("handles Gemini API error", async () => {
    mockActiveFiles();

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({
        error: { message: "Quota exceeded", code: 429 },
      }),
    });

    const result = JSON.parse(
      await geminiResearchTool.execute({ query: "test" }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("429");
  });
});

// ---------------------------------------------------------------------------
// gemini_audio_overview
// ---------------------------------------------------------------------------

describe("gemini_audio_overview", () => {
  it("has consistent name", () => {
    expect(geminiAudioOverviewTool.name).toBe("gemini_audio_overview");
    expect(geminiAudioOverviewTool.definition.function.name).toBe(
      "gemini_audio_overview",
    );
  });

  it("generates podcast and returns audio path", async () => {
    mockActiveFiles();

    // Mock Step 1: script generation
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    turns: [
                      { speaker: "A", text: "Welcome to our podcast." },
                      {
                        speaker: "B",
                        text: "Today we discuss the findings.",
                      },
                    ],
                  }),
                },
              ],
            },
          },
        ],
      }),
    });

    // Mock Step 2: TTS generation
    const fakePcm = Buffer.alloc(48000); // 1 second of silence at 24kHz 16-bit
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: {
                    data: fakePcm.toString("base64"),
                    mimeType: "audio/L16;rate=24000",
                  },
                },
              ],
            },
          },
        ],
      }),
    });

    const result = JSON.parse(
      await geminiAudioOverviewTool.execute({ length: "brief" }),
    );
    expect(result.success).toBe(true);
    expect(result.audio_file).toContain("/tmp/gemini_audio/");
    expect(result.transcript).toBeDefined();
    expect(result.transcript).toContain("Welcome to our podcast");
  });

  it("returns transcript even when TTS fails", async () => {
    mockActiveFiles();

    // Mock Step 1: script generation success
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    turns: [{ speaker: "A", text: "Hello." }],
                  }),
                },
              ],
            },
          },
        ],
      }),
    });

    // Mock Step 2: TTS failure
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: { message: "Internal error" } }),
    });

    const result = JSON.parse(
      await geminiAudioOverviewTool.execute({ length: "brief" }),
    );
    expect(result.success).toBe(false);
    expect(result.transcript).toBeDefined();
    expect(result.transcript).toContain("Hello");
    expect(result.note).toContain("TTS failed");
  });

  it("returns error when no files available", async () => {
    mockActiveFiles([]);

    const result = JSON.parse(
      await geminiAudioOverviewTool.execute({ length: "brief" }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("upload");
  });
});
