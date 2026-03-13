/**
 * API client for Mission Control dashboard.
 * REST wrappers + manual SSE client (fetch + ReadableStream).
 */

const API_KEY_STORAGE = "mc-api-key";

// --- Auth ---

export function getApiKey() {
  return localStorage.getItem(API_KEY_STORAGE);
}

export function setApiKey(key) {
  localStorage.setItem(API_KEY_STORAGE, key);
}

export function clearApiKey() {
  localStorage.removeItem(API_KEY_STORAGE);
}

// --- REST helpers ---

function headers() {
  const h = { "Content-Type": "application/json" };
  const key = getApiKey();
  if (key) h["X-Api-Key"] = key;
  return h;
}

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: headers(), ...opts });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// --- REST endpoints ---

export function fetchHealth() {
  return fetch("/health").then((r) => r.json());
}

export function fetchTasks(filters = {}) {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.agent_type) params.set("agent_type", filters.agent_type);
  if (filters.limit) params.set("limit", String(filters.limit));
  if (filters.offset) params.set("offset", String(filters.offset));
  const qs = params.toString();
  return api(`/api/tasks${qs ? "?" + qs : ""}`);
}

export function fetchTaskDetail(taskId) {
  return api(`/api/tasks/${taskId}`);
}

export function submitTask(payload) {
  return api("/api/tasks", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function cancelTask(taskId) {
  return api(`/api/tasks/${taskId}/cancel`, { method: "POST" });
}

export function fetchAgents() {
  return api("/api/agents");
}

// --- SSE via fetch + ReadableStream ---

export function connectSSE(onEvent, onError, onOpen) {
  let abortController = new AbortController();
  let reconnectDelay = 1000;
  let lastSequence = null;
  let closed = false;

  async function connect() {
    if (closed) return;

    const url =
      "/api/events/stream" + (lastSequence ? `?since=${lastSequence}` : "");

    try {
      const res = await fetch(url, {
        headers: { "X-Api-Key": getApiKey() || "" },
        signal: abortController.signal,
      });

      if (!res.ok) {
        throw new Error(`SSE HTTP ${res.status}`);
      }

      if (onOpen) onOpen();
      reconnectDelay = 1000;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop(); // keep incomplete frame

        for (const frame of frames) {
          if (!frame.trim() || frame.trim().startsWith(":")) continue;

          let eventType = "message";
          let data = null;

          for (const line of frame.split("\n")) {
            if (line.startsWith("event: ")) {
              eventType = line.slice(7);
            } else if (line.startsWith("data: ")) {
              try {
                data = JSON.parse(line.slice(6));
              } catch {
                data = line.slice(6);
              }
            }
          }

          if (data) {
            if (data.sequence != null) lastSequence = data.sequence;
            onEvent({ type: eventType, data });
          }
        }
      }
    } catch (err) {
      if (closed || err.name === "AbortError") return;
      if (onError) onError(err);
    }

    // Reconnect with backoff
    if (!closed) {
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    }
  }

  connect();

  return {
    close() {
      closed = true;
      abortController.abort();
    },
  };
}
