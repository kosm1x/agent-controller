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

const { mockGetUserFacts } = vi.hoisted(() => ({
  mockGetUserFacts: vi.fn(() => [
    { key: "gemini_api_key", value: "test-key-123" },
  ]),
}));
vi.mock("../../db/user-facts.js", () => ({
  getUserFacts: mockGetUserFacts,
}));

// Ruling 3c (audit round 5, S1): the secret index, reduced to one stored value.
const secrets = vi.hoisted(() => ({
  STORED: "up-" + "s".repeat(14),
  PH: "[oculto · úsalo por nombre: $SECRET_PROJECTS_UP_PASSWORD en shell_exec, {{SECRET_PROJECTS_UP_PASSWORD}} en http_fetch/navegador]",
  fail: false,
}));
vi.mock("../../lib/secret-refs.js", () => ({
  scrubSecrets: (t: string) => {
    if (secrets.fail) throw new Error("The database connection is not open");
    return t.replaceAll(secrets.STORED, secrets.PH);
  },
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
            ? "https://upload.googleapis.com/session/abc"
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
    expect(result.success).toBeUndefined(); // failure shape is {error}, no success key
    expect(result.error).toContain("403");
    expect(result.error).toContain("Forbidden");
  });

  it("surfaces phase-2 text/plain errors instead of JSON-parse mask (W4 regression)", async () => {
    // Phase 1 succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: {
        get: (k: string) =>
          k.toLowerCase() === "x-goog-upload-url"
            ? "https://upload.example.googleapis.com/session/x"
            : null,
      },
      text: async () => "",
    });
    // Phase 2 fails with text/plain (the bug that motivated this fix —
    // pre-fix, .json() would throw "Unexpected token 'M'..." and the real
    // error never reached the user)
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => "Metadata part is too large.",
    });

    const result = JSON.parse(
      await geminiUploadTool.execute({ source: "/tmp/test.pdf" }),
    );
    expect(result.success).toBeUndefined(); // failure shape is {error}, no success key
    expect(result.error).toContain("Metadata part is too large");
    expect(result.error).not.toContain("Unexpected token");
  });

  it("rejects start-session response missing the upload-url header (W5)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => null }, // proxy stripped or truncated response
      text: async () => "",
    });

    const result = JSON.parse(
      await geminiUploadTool.execute({ source: "/tmp/test.pdf" }),
    );
    expect(result.success).toBeUndefined(); // failure shape is {error}, no success key
    expect(result.error).toContain("no x-goog-upload-url");
    expect(mockFetch).toHaveBeenCalledTimes(1); // never advanced to phase 2
  });

  it("refuses upload-url that isn't https://*.googleapis.com (W1 SSRF guard)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: {
        get: (k: string) =>
          k.toLowerCase() === "x-goog-upload-url"
            ? "https://attacker.example.com/exfil"
            : null,
      },
      text: async () => "",
    });

    const result = JSON.parse(
      await geminiUploadTool.execute({ source: "/tmp/test.pdf" }),
    );
    expect(result.success).toBeUndefined(); // failure shape is {error}, no success key
    expect(result.error).toContain("Upload URL refused");
    expect(result.error).toContain("googleapis.com");
    expect(mockFetch).toHaveBeenCalledTimes(1); // never sent the bytes
  });

  it("downloads URL before uploading", async () => {
    // Mock URL download (safeFetch reads status + headers for its redirect loop)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      arrayBuffer: async () => new ArrayBuffer(100),
    });
    // Phase 1: start session
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: {
        get: (k: string) =>
          k.toLowerCase() === "x-goog-upload-url"
            ? "https://upload.googleapis.com/session/url"
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

  describe("audit R5 S1 — a text file is scrubbed before upload", () => {
    function mockUploadOk() {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: {
          get: (k: string) =>
            k.toLowerCase() === "x-goog-upload-url"
              ? "https://upload.googleapis.com/session/s1"
              : null,
        },
        text: async () => "",
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({ file: { name: "files/s1", uri: "u", state: "ACTIVE" } }),
      });
    }
    async function uploadRealFile(name: string, content: Buffer) {
      const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
      const os = await vi.importActual<typeof import("node:os")>("node:os");
      const path = await vi.importActual<typeof import("node:path")>("node:path");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-s1-"));
      const file = path.join(dir, name);
      fs.writeFileSync(file, content);
      const { readFileSync } = await import("node:fs");
      vi.mocked(readFileSync).mockImplementationOnce(
        ((p: string) => fs.readFileSync(p)) as typeof readFileSync,
      );
      try {
        return JSON.parse(await geminiUploadTool.execute({ source: file }));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    const sentBody = () => mockFetch.mock.calls[1]![1].body as Buffer;
    const sentLength = () =>
      new Headers(mockFetch.mock.calls[1]![1].headers).get("content-length");

    // .yaml / .ini have no MIME entry (octet-stream): judged by their bytes.
    it.each(["notes.txt", "config.json", "deploy.yaml", "settings.ini"])(
      "%s: the stored value is replaced by its placeholder in the bytes sent (and the declared length matches)",
      async (name) => {
        mockUploadOk();
        const text = `host: ftp.example.com\npassword: ${secrets.STORED}\nñandú ✓\n`;
        const result = await uploadRealFile(name, Buffer.from(text, "utf8"));
        expect(result.success).toBe(true);
        const body = sentBody().toString("utf8");
        expect(body).not.toContain(secrets.STORED);
        expect(body).toBe(text.replace(secrets.STORED, secrets.PH));
        expect(sentLength()).toBe(String(sentBody().length));
      },
    );

    it("a binary type (PDF) is sent as read (residual)", async () => {
      mockUploadOk();
      const bytes = Buffer.concat([
        Buffer.from("%PDF-1.4\n"),
        Buffer.from([0, 255, 254, 0]),
        Buffer.from(secrets.STORED),
      ]);
      await uploadRealFile("doc.pdf", bytes);
      expect(Buffer.compare(sentBody(), bytes)).toBe(0);
    });

    it("no secret index: nothing is uploaded", async () => {
      secrets.fail = true;
      try {
        const result = await uploadRealFile("notes.txt", Buffer.from(`x ${secrets.STORED}`));
        expect(result.error).toContain("secret index unavailable");
        expect(mockFetch).not.toHaveBeenCalled();
      } finally {
        secrets.fail = false;
      }
    });
  });

  it("handles URL download failure", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, headers: new Headers() });

    const result = JSON.parse(
      await geminiUploadTool.execute({
        source: "https://example.com/missing.pdf",
      }),
    );
    expect(result.success).toBeUndefined(); // failure shape is {error}, no success key
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
    expect(result.success).toBeUndefined(); // failure shape is {error}, no success key
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
    expect(result.success).toBeUndefined(); // failure shape is {error}, no success key
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
    expect(result.success).toBeUndefined(); // failure shape is {error}, no success key
    expect(result.transcript).toBeDefined();
    expect(result.transcript).toContain("Hello");
    expect(result.note).toContain("TTS failed");
  });

  it("returns error when no files available", async () => {
    mockActiveFiles([]);

    const result = JSON.parse(
      await geminiAudioOverviewTool.execute({ length: "brief" }),
    );
    expect(result.success).toBeUndefined(); // failure shape is {error}, no success key
    expect(result.error).toContain("upload");
  });
});

// Ruling 3c (2026-10-01): a credential can be stored as a fact again, so the
// missing-key error names both sources. An EXISTING fact supplies the key
// (every test above runs on one).
describe("missing Gemini key", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ["gemini_upload", () => geminiUploadTool.execute({ source: "/tmp/x.pdf" })],
    ["gemini_research", () => geminiResearchTool.execute({ query: "q" })],
    ["gemini_audio_overview", () => geminiAudioOverviewTool.execute({})],
  ])("%s points to GEMINI_API_KEY and the gemini_api_key fact", async (_name, run) => {
    vi.stubEnv("GEMINI_API_KEY", "");
    mockGetUserFacts.mockReturnValueOnce([]);
    const out = await run();
    const { error } = JSON.parse(out) as { error: string };
    expect(error).toBe(
      "No Gemini API key. Set GEMINI_API_KEY env var or store via user_fact_set (category: projects, key: gemini_api_key).",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
