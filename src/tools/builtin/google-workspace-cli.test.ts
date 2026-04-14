/**
 * Tests for google_workspace_cli dispatch tool.
 *
 * Mocks child_process.execFile + google auth so no real subprocess runs and
 * no real HTTP token refresh happens. Covers the full envelope taxonomy:
 * success / error / pagination / token injection / unknown method / timeout /
 * unconfigured auth / parse failure.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// vi.mock() hoists to top of file — any variables referenced inside the
// factory must be declared with vi.hoisted() or they'll be undefined
// when the mock runs. See feedback_vitest_mocking.md.
const mocks = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockGetAccessToken: vi.fn(),
  mockIsGoogleConfigured: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mocks.mockExecFile,
}));

vi.mock("../../google/auth.js", () => ({
  getAccessToken: () => mocks.mockGetAccessToken(),
  isGoogleConfigured: () => mocks.mockIsGoogleConfigured(),
}));

const mockExecFile = mocks.mockExecFile;
const mockGetAccessToken = mocks.mockGetAccessToken;
const mockIsGoogleConfigured = mocks.mockIsGoogleConfigured;

import { googleWorkspaceCliTool } from "./google-workspace-cli.js";

/**
 * Helper: build an execFile mock that resolves with the supplied stdout/
 * stderr/exitCode. The actual execFile signature calls a callback, so we
 * emulate that.
 */
function mockExecFileOnce(
  stdout: string,
  stderr: string,
  exitCode: number,
  opts: {
    timedOut?: boolean;
    captureEnv?: (env: NodeJS.ProcessEnv) => void;
  } = {},
) {
  mockExecFile.mockImplementationOnce(
    (
      _binary: string,
      _args: string[],
      execOpts: { env: NodeJS.ProcessEnv },
      cb: (
        err:
          | (Error & { code?: number; killed?: boolean; signal?: string })
          | null,
        stdout: string,
        stderr: string,
      ) => void,
    ) => {
      opts.captureEnv?.(execOpts.env);
      if (exitCode !== 0 || opts.timedOut) {
        const err = new Error(
          opts.timedOut ? "command timed out" : `exit ${exitCode}`,
        ) as Error & { code?: number; killed?: boolean; signal?: string };
        err.code = exitCode;
        if (opts.timedOut) {
          err.killed = true;
          err.signal = "SIGTERM";
        }
        cb(err, stdout, stderr);
      } else {
        cb(null, stdout, stderr);
      }
      // Return a dummy child (execute handler only uses the callback).
      return { pid: 12345 } as unknown as ReturnType<typeof mockExecFile>;
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsGoogleConfigured.mockReturnValue(true);
  mockGetAccessToken.mockResolvedValue("ya29.MOCK_TOKEN_abc123");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("google_workspace_cli", () => {
  it("returns ok envelope with parsed JSON on success", async () => {
    mockExecFileOnce(
      JSON.stringify({
        kind: "tasks#taskLists",
        items: [{ id: "list-1", title: "My Tasks" }],
      }),
      "",
      0,
    );

    const raw = await googleWorkspaceCliTool.execute({
      service: "tasks",
      resource: "tasklists",
      method: "list",
    });
    const result = JSON.parse(raw);

    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({
      kind: "tasks#taskLists",
      items: [{ id: "list-1", title: "My Tasks" }],
    });
  });

  it("injects GOOGLE_WORKSPACE_CLI_TOKEN into the child env", async () => {
    let capturedEnv: NodeJS.ProcessEnv | null = null;
    mockExecFileOnce("{}", "", 0, {
      captureEnv: (env) => {
        capturedEnv = env;
      },
    });

    await googleWorkspaceCliTool.execute({
      service: "tasks",
      resource: "tasklists",
      method: "list",
    });

    expect(capturedEnv).not.toBeNull();
    expect(capturedEnv!.GOOGLE_WORKSPACE_CLI_TOKEN).toBe(
      "ya29.MOCK_TOKEN_abc123",
    );
    // Jarvis env should still be present (PATH, etc.) — we merged with process.env.
    expect(capturedEnv!.PATH).toBeDefined();
  });

  it("builds argv with service, resource segments, method, params, and json", async () => {
    let capturedArgv: string[] | null = null;
    mockExecFile.mockImplementationOnce(
      (
        _binary: string,
        args: string[],
        _opts: unknown,
        cb: (err: null, stdout: string, stderr: string) => void,
      ) => {
        capturedArgv = args;
        cb(null, "{}", "");
        return { pid: 1 } as unknown as ReturnType<typeof mockExecFile>;
      },
    );

    await googleWorkspaceCliTool.execute({
      service: "chat",
      resource: "spaces.messages",
      method: "create",
      params: { parent: "spaces/AAAA1234" },
      json: { text: "Deploy complete." },
    });

    expect(capturedArgv).not.toBeNull();
    expect(capturedArgv).toEqual([
      "chat",
      "spaces",
      "messages",
      "create",
      "--params",
      JSON.stringify({ parent: "spaces/AAAA1234" }),
      "--json",
      JSON.stringify({ text: "Deploy complete." }),
    ]);
  });

  it("appends --page-all when page_all is true and parses NDJSON", async () => {
    let capturedArgv: string[] | null = null;
    const ndjson =
      JSON.stringify({ page: 1, items: ["a", "b"] }) +
      "\n" +
      JSON.stringify({ page: 2, items: ["c"] });

    mockExecFile.mockImplementationOnce(
      (
        _binary: string,
        args: string[],
        _opts: unknown,
        cb: (err: null, stdout: string, stderr: string) => void,
      ) => {
        capturedArgv = args;
        cb(null, ndjson, "");
        return { pid: 1 } as unknown as ReturnType<typeof mockExecFile>;
      },
    );

    const raw = await googleWorkspaceCliTool.execute({
      service: "people",
      resource: "people.connections",
      method: "list",
      params: { resourceName: "people/me" },
      page_all: true,
    });
    const result = JSON.parse(raw);

    expect(capturedArgv).toContain("--page-all");
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.result)).toBe(true);
    expect(result.result).toHaveLength(2);
    expect(result.result[0]).toEqual({ page: 1, items: ["a", "b"] });
    expect(result.result[1]).toEqual({ page: 2, items: ["c"] });
  });

  it("returns error envelope with stderr on non-zero exit", async () => {
    mockExecFileOnce(
      "",
      "error: unknown method 'foo' on resource 'tasklists'",
      2,
    );

    const raw = await googleWorkspaceCliTool.execute({
      service: "tasks",
      resource: "tasklists",
      method: "foo",
    });
    const result = JSON.parse(raw);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("unknown method 'foo'");
    expect(result.exitCode).toBe(2);
  });

  it("surfaces timeout as ok:false with timeout error", async () => {
    mockExecFileOnce("partial output", "", 1, { timedOut: true });

    const raw = await googleWorkspaceCliTool.execute({
      service: "drive",
      resource: "files",
      method: "list",
      timeout_ms: 1000,
    });
    const result = JSON.parse(raw);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out after 1000ms/);
  });

  it("returns unconfigured error when Google OAuth is missing", async () => {
    mockIsGoogleConfigured.mockReturnValue(false);

    const raw = await googleWorkspaceCliTool.execute({
      service: "tasks",
      resource: "tasklists",
      method: "list",
    });
    const result = JSON.parse(raw);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Google OAuth not configured/);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("surfaces token refresh failures before spawning subprocess", async () => {
    mockGetAccessToken.mockRejectedValueOnce(
      new Error("refresh token expired"),
    );

    const raw = await googleWorkspaceCliTool.execute({
      service: "tasks",
      resource: "tasklists",
      method: "list",
    });
    const result = JSON.parse(raw);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Token refresh failed: refresh token expired/);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("returns error when gws stdout is not valid JSON on success exit", async () => {
    mockExecFileOnce("not valid json {", "", 0);

    const raw = await googleWorkspaceCliTool.execute({
      service: "tasks",
      resource: "tasklists",
      method: "list",
    });
    const result = JSON.parse(raw);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/did not parse as JSON/);
    expect(result.rawPreview).toContain("not valid json");
  });

  it("redacts the access token if it somehow appears in stderr", async () => {
    mockExecFileOnce(
      "",
      "Error: failed with token ya29.MOCK_TOKEN_abc123 in header",
      1,
    );

    const raw = await googleWorkspaceCliTool.execute({
      service: "tasks",
      resource: "tasklists",
      method: "list",
    });
    const result = JSON.parse(raw);

    expect(result.ok).toBe(false);
    expect(result.error).not.toContain("ya29.MOCK_TOKEN_abc123");
    expect(result.error).toContain("[REDACTED]");
  });

  it("validates required fields and rejects empty service", async () => {
    const raw = await googleWorkspaceCliTool.execute({
      service: "",
      resource: "tasklists",
      method: "list",
    });
    const result = JSON.parse(raw);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/service is required/);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("allows empty resource (for service-level --help introspection)", async () => {
    let capturedArgv: string[] | null = null;
    mockExecFile.mockImplementationOnce(
      (
        _binary: string,
        args: string[],
        _opts: unknown,
        cb: (err: null, stdout: string, stderr: string) => void,
      ) => {
        capturedArgv = args;
        cb(null, "{}", "");
        return { pid: 1 } as unknown as ReturnType<typeof mockExecFile>;
      },
    );

    await googleWorkspaceCliTool.execute({
      service: "chat",
      resource: "",
      method: "--help",
    });

    expect(capturedArgv).toEqual(["chat", "--help"]);
  });
});
