/**
 * Mock LLM server for integration tests.
 *
 * Starts a local HTTP server that mimics OpenAI-compatible /v1/chat/completions.
 * Supports scripted responses: text-only, tool calls, errors, streaming.
 * Each test can push response scripts that are consumed in order.
 */

import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "http";

export interface MockToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface MockResponse {
  content?: string | null;
  tool_calls?: MockToolCall[];
  finish_reason?: string;
  /** Simulate HTTP error */
  httpStatus?: number;
  httpBody?: string;
  /** Simulate slow response */
  delayMs?: number;
  /** Usage stats */
  prompt_tokens?: number;
  completion_tokens?: number;
}

export class MockLLMServer {
  private server: Server | null = null;
  private responses: MockResponse[] = [];
  private requests: Array<{ body: unknown; timestamp: number }> = [];
  private port = 0;

  /** Push a scripted response. Consumed FIFO. */
  push(...responses: MockResponse[]): void {
    this.responses.push(...responses);
  }

  /** Clear all queued responses and recorded requests. */
  reset(): void {
    this.responses = [];
    this.requests = [];
  }

  /** Get all recorded requests. */
  getRequests(): Array<{ body: unknown; timestamp: number }> {
    return this.requests;
  }

  /** Get the base URL (http://localhost:PORT/v1). */
  get baseUrl(): string {
    return `http://localhost:${this.port}/v1`;
  }

  /** Start the server on a random available port. */
  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer(
        async (req: IncomingMessage, res: ServerResponse) => {
          // Collect body
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const bodyText = Buffer.concat(chunks).toString("utf-8");
          let body: unknown;
          try {
            body = JSON.parse(bodyText);
          } catch {
            body = bodyText;
          }

          this.requests.push({ body, timestamp: Date.now() });

          // Get next scripted response
          const script = this.responses.shift();
          if (!script) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "No scripted responses left" }));
            return;
          }

          // Simulate delay
          if (script.delayMs) {
            await new Promise((r) => setTimeout(r, script.delayMs));
          }

          // Simulate HTTP error
          if (script.httpStatus && script.httpStatus !== 200) {
            res.writeHead(script.httpStatus, {
              "Content-Type": "application/json",
            });
            res.end(script.httpBody ?? JSON.stringify({ error: "mock error" }));
            return;
          }

          // Build OpenAI-compatible response
          const response = {
            id: `mock-${Date.now()}`,
            object: "chat.completion",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: script.content ?? null,
                  ...(script.tool_calls && { tool_calls: script.tool_calls }),
                },
                finish_reason: script.finish_reason ?? "stop",
              },
            ],
            usage: {
              prompt_tokens: script.prompt_tokens ?? 100,
              completion_tokens: script.completion_tokens ?? 50,
              total_tokens:
                (script.prompt_tokens ?? 100) +
                (script.completion_tokens ?? 50),
            },
          };

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(response));
        },
      );

      this.server.listen(0, () => {
        const addr = this.server!.address();
        this.port = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });
  }

  /** Stop the server. */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}
