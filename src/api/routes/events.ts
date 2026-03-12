/**
 * SSE event stream route.
 *
 * GET /events/stream — Server-Sent Events stream of all system events.
 * Supports optional ?since=<sequence> for replay of missed events.
 * Supports optional ?types=task.*,agent.* for filtered subscriptions.
 */

import { Hono } from "hono";
import { getEventBus } from "../../lib/event-bus.js";
import type { Event } from "../../lib/events/types.js";

const events = new Hono();

events.get("/stream", (c) => {
  const sinceParam = c.req.query("since");
  const typesParam = c.req.query("types");

  // Parse type filters (comma-separated patterns)
  const typeFilters = typesParam
    ? typesParam.split(",").map((t) => t.trim())
    : null;

  const bus = getEventBus();

  // Set SSE headers
  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
  c.header("X-Accel-Buffering", "no"); // Disable nginx buffering

  return c.body(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();

        function send(event: Event): void {
          // Apply type filter if specified
          if (typeFilters) {
            const matches = typeFilters.some((filter) => {
              if (filter === "*") return true;
              if (filter.endsWith(".*")) {
                return event.type.startsWith(filter.slice(0, -2) + ".");
              }
              return event.type === filter;
            });
            if (!matches) return;
          }

          const data = JSON.stringify({
            id: event.id,
            type: event.type,
            category: event.category,
            timestamp: event.timestamp,
            data: event.data,
            sequence: event.sequence,
          });

          try {
            controller.enqueue(
              encoder.encode(`event: ${event.type}\ndata: ${data}\n\n`),
            );
          } catch {
            // Stream may be closed
          }
        }

        // Replay missed events if ?since= is provided
        if (sinceParam) {
          const sinceSeq = parseInt(sinceParam, 10);
          if (!Number.isNaN(sinceSeq)) {
            const missed = bus.getUndelivered("sse-client", sinceSeq);
            for (const event of missed) {
              send(event);
            }
          }
        }

        // Subscribe to all future events
        const sub = bus.subscribe("*", (event: Event) => {
          send(event);
        });

        // Send initial keepalive
        try {
          controller.enqueue(encoder.encode(": connected\n\n"));
        } catch {
          // Stream closed immediately
        }

        // Periodic keepalive to prevent connection timeout
        const keepalive = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
          } catch {
            clearInterval(keepalive);
            sub.unsubscribe();
          }
        }, 30_000);

        // Clean up when the connection closes
        c.req.raw.signal.addEventListener("abort", () => {
          clearInterval(keepalive);
          sub.unsubscribe();
        });
      },
    }),
  );
});

export { events };
