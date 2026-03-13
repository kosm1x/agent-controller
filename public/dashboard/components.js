/**
 * UI components for Mission Control dashboard.
 * Pure rendering functions — no state, no side effects.
 */

import { renderGoalGraph } from "./graph.js";

// --- Helpers ---

export function formatRelativeTime(iso) {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return "just now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function formatDuration(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.floor(s % 60);
  return `${m}m ${rs}s`;
}

function formatTokens(usage) {
  if (!usage) return "—";
  try {
    const u = typeof usage === "string" ? JSON.parse(usage) : usage;
    const p = u.prompt_tokens || 0;
    const c = u.completion_tokens || 0;
    const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
    return `${fmt(p)} / ${fmt(c)}`;
  } catch {
    return "—";
  }
}

const STATUS_COLORS = {
  pending: "#6b7280",
  classifying: "#6b7280",
  queued: "#6b7280",
  running: "#3b82f6",
  completed: "#22c55e",
  failed: "#ef4444",
  cancelled: "#9ca3af",
};

function statusBadge(status) {
  const color = STATUS_COLORS[status] || "#6b7280";
  return `<span class="badge" style="background:${color}">${esc(status)}</span>`;
}

function priorityBadge(priority) {
  const colors = {
    critical: "#ef4444",
    high: "#f59e0b",
    normal: "#3b82f6",
    low: "#6b7280",
  };
  const color = colors[priority] || "#6b7280";
  return `<span class="badge" style="background:${color}">${esc(priority)}</span>`;
}

function typeBadge(type) {
  const colors = {
    fast: "#22c55e",
    nanoclaw: "#a855f7",
    heavy: "#f59e0b",
    swarm: "#3b82f6",
    a2a: "#ec4899",
  };
  const color = colors[type] || "#6b7280";
  return `<span class="badge" style="background:${color}">${esc(type || "—")}</span>`;
}

function esc(str) {
  if (!str) return "";
  const d = document.createElement("div");
  d.textContent = String(str);
  return d.innerHTML;
}

function progressBar(pct) {
  return `<div class="progress-bar"><div class="progress-fill" style="width:${Math.min(100, pct)}%"></div></div>`;
}

// --- Login ---

export function renderLogin(container, onSubmit) {
  container.innerHTML = `
    <div class="login-box">
      <h2>Mission Control</h2>
      <p>Enter your API key to continue</p>
      <input type="password" id="login-key" placeholder="API Key" autocomplete="off" />
      <button id="login-btn">Connect</button>
      <div id="login-error" class="error-text"></div>
    </div>
  `;
  container.classList.remove("hidden");

  const input = document.getElementById("login-key");
  const btn = document.getElementById("login-btn");

  async function submit() {
    const key = input.value.trim();
    if (!key) return;
    btn.disabled = true;
    btn.textContent = "Connecting...";
    document.getElementById("login-error").textContent = "";
    try {
      await onSubmit(key);
    } catch (err) {
      document.getElementById("login-error").textContent =
        err.message || "Connection failed";
      btn.disabled = false;
      btn.textContent = "Connect";
    }
  }

  btn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
  input.focus();
}

// --- Health bar ---

export function renderHealthBar(container, health, connectionStatus) {
  const statusColor = health?.status === "healthy" ? "#22c55e" : "#ef4444";
  const sseColors = {
    connected: "#22c55e",
    reconnecting: "#f59e0b",
    disconnected: "#ef4444",
  };
  const sseColor = sseColors[connectionStatus] || "#ef4444";

  container.innerHTML = `
    <div class="health-row">
      <span class="health-title">Mission Control</span>
      <span class="badge" style="background:${statusColor}">${health?.status || "unknown"}</span>
      <span class="health-meta">v${esc(health?.version || "?")} &middot; DB: ${health?.db || "?"}</span>
      <span class="health-spacer"></span>
      <span class="sse-dot" style="background:${sseColor}" title="SSE: ${connectionStatus}"></span>
      <span class="health-meta">${connectionStatus}</span>
    </div>
  `;
}

// --- Navigation ---

export function renderNav(container, activeTab, onTabChange, onSubmitClick) {
  const tabs = ["tasks", "agents", "events"];
  container.innerHTML = `
    <div class="nav-row">
      ${tabs.map((t) => `<button class="nav-tab ${t === activeTab ? "active" : ""}" data-tab="${t}">${t.charAt(0).toUpperCase() + t.slice(1)}</button>`).join("")}
      <span class="health-spacer"></span>
      <button class="btn-primary" id="nav-submit">Submit Task</button>
    </div>
  `;

  container.querySelectorAll(".nav-tab").forEach((btn) => {
    btn.addEventListener("click", () => onTabChange(btn.dataset.tab));
  });
  document
    .getElementById("nav-submit")
    .addEventListener("click", onSubmitClick);
}

// --- Task list ---

export function renderTaskList(
  container,
  tasks,
  filters,
  onTaskClick,
  onFilterChange,
  onCancel,
) {
  const statuses = [
    "",
    "pending",
    "queued",
    "running",
    "completed",
    "failed",
    "cancelled",
  ];
  const types = ["", "fast", "nanoclaw", "heavy", "swarm", "a2a"];

  container.innerHTML = `
    <div class="filter-row">
      <label>Status:
        <select id="filter-status">
          ${statuses.map((s) => `<option value="${s}" ${filters.status === s ? "selected" : ""}>${s || "All"}</option>`).join("")}
        </select>
      </label>
      <label>Type:
        <select id="filter-type">
          ${types.map((t) => `<option value="${t}" ${filters.agent_type === t ? "selected" : ""}>${t || "All"}</option>`).join("")}
        </select>
      </label>
    </div>
    <div class="table-wrap">
      <table class="task-table">
        <thead>
          <tr>
            <th>Status</th>
            <th>Priority</th>
            <th>Title</th>
            <th>Type</th>
            <th>Progress</th>
            <th>Created</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${tasks.length === 0 ? '<tr><td colspan="7" class="empty-row">No tasks</td></tr>' : ""}
          ${tasks
            .map(
              (t) => `
            <tr class="task-row" data-id="${esc(t.task_id)}">
              <td>${statusBadge(t.status)}</td>
              <td>${priorityBadge(t.priority)}</td>
              <td class="task-title">${esc(t.title)}</td>
              <td>${typeBadge(t.agent_type)}</td>
              <td>${progressBar(t.progress || 0)}</td>
              <td class="meta-text">${formatRelativeTime(t.created_at)}</td>
              <td>${["pending", "queued", "running"].includes(t.status) ? `<button class="btn-cancel" data-id="${esc(t.task_id)}">Cancel</button>` : ""}</td>
            </tr>
          `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;

  document.getElementById("filter-status").addEventListener("change", (e) => {
    onFilterChange({ ...filters, status: e.target.value });
  });
  document.getElementById("filter-type").addEventListener("change", (e) => {
    onFilterChange({ ...filters, agent_type: e.target.value });
  });
  container.querySelectorAll(".task-row").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.classList.contains("btn-cancel")) return;
      onTaskClick(row.dataset.id);
    });
  });
  container.querySelectorAll(".btn-cancel").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onCancel(btn.dataset.id);
    });
  });
}

// --- Task detail (modal) ---

export function renderTaskDetail(container, taskData, onClose, onSubtaskClick) {
  const { task, runs, subtasks } = taskData;

  let classificationHtml = "";
  if (task.classification) {
    try {
      const c = JSON.parse(task.classification);
      classificationHtml = `
        <div class="detail-section">
          <h4>Classification</h4>
          <div class="meta-grid">
            <span>Score:</span><span>${c.score ?? "—"}</span>
            <span>Reason:</span><span>${esc(c.reason || "—")}</span>
            <span>Explicit:</span><span>${c.explicit ? "Yes" : "No"}</span>
          </div>
        </div>
      `;
    } catch {
      /* skip */
    }
  }

  let inputHtml = "";
  if (task.input) {
    inputHtml = `
      <div class="detail-section">
        <h4>Input</h4>
        <pre class="json-block">${esc(formatJson(task.input))}</pre>
      </div>
    `;
  }

  let outputHtml = "";
  if (task.output) {
    outputHtml = `
      <div class="detail-section">
        <h4>Output</h4>
        <pre class="json-block">${esc(formatJson(task.output))}</pre>
      </div>
    `;
  }

  if (task.error) {
    outputHtml += `
      <div class="detail-section">
        <h4>Error</h4>
        <pre class="json-block error-block">${esc(task.error)}</pre>
      </div>
    `;
  }

  const runsHtml =
    runs && runs.length > 0
      ? `
    <div class="detail-section">
      <h4>Runs (${runs.length})</h4>
      <table class="runs-table">
        <thead><tr><th>Status</th><th>Type</th><th>Phase</th><th>Duration</th><th>Tokens</th></tr></thead>
        <tbody>
          ${runs
            .map(
              (r, i) => `
            <tr>
              <td>${statusBadge(r.status)}</td>
              <td>${typeBadge(r.agent_type)}</td>
              <td>${esc(r.phase || "—")}</td>
              <td>${formatDuration(r.duration_ms)}</td>
              <td>${formatTokens(r.token_usage)}</td>
            </tr>
            ${r.goal_graph ? `<tr><td colspan="5"><div class="goal-graph-container" data-run-index="${i}"></div></td></tr>` : ""}
          `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `
      : "";

  const subtasksHtml =
    subtasks && subtasks.length > 0
      ? `
    <div class="detail-section">
      <h4>Sub-tasks (${subtasks.length})</h4>
      <table class="subtask-table">
        <thead><tr><th>Status</th><th>Title</th><th>Type</th><th>Progress</th></tr></thead>
        <tbody>
          ${subtasks
            .map(
              (s) => `
            <tr class="subtask-row" data-id="${esc(s.task_id)}">
              <td>${statusBadge(s.status)}</td>
              <td class="task-title">${esc(s.title)}</td>
              <td>${typeBadge(s.agent_type)}</td>
              <td>${progressBar(s.progress || 0)}</td>
            </tr>
          `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `
      : "";

  const duration =
    task.started_at && task.completed_at
      ? formatDuration(new Date(task.completed_at) - new Date(task.started_at))
      : task.started_at
        ? "Running..."
        : "—";

  container.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <h3>${esc(task.title)}</h3>
        <button class="modal-close">&times;</button>
      </div>
      <div class="modal-body">
        <div class="meta-grid">
          <span>Status:</span><span>${statusBadge(task.status)}</span>
          <span>Priority:</span><span>${priorityBadge(task.priority)}</span>
          <span>Type:</span><span>${typeBadge(task.agent_type)}</span>
          <span>Duration:</span><span>${duration}</span>
          <span>Created:</span><span>${formatRelativeTime(task.created_at)}</span>
          <span>Task ID:</span><span class="mono-text">${esc(task.task_id)}</span>
        </div>
        ${task.description ? `<div class="detail-section"><h4>Description</h4><p>${esc(task.description)}</p></div>` : ""}
        ${classificationHtml}
        ${inputHtml}
        ${outputHtml}
        ${runsHtml}
        ${subtasksHtml}
      </div>
    </div>
  `;

  container.classList.remove("hidden");
  container.querySelector(".modal-close").addEventListener("click", onClose);
  container.addEventListener("click", (e) => {
    if (e.target === container) onClose();
  });

  // Render goal graphs
  runs?.forEach((r, i) => {
    if (r.goal_graph) {
      const el = container.querySelector(`[data-run-index="${i}"]`);
      if (el) renderGoalGraph(el, r.goal_graph);
    }
  });

  // Subtask clicks
  if (onSubtaskClick) {
    container.querySelectorAll(".subtask-row").forEach((row) => {
      row.addEventListener("click", () => onSubtaskClick(row.dataset.id));
    });
  }
}

// --- Agent fleet ---

export function renderAgentFleet(container, agents) {
  if (!agents || agents.length === 0) {
    container.innerHTML = '<div class="empty-state">No agents registered</div>';
    return;
  }

  container.innerHTML = `
    <div class="agent-grid">
      ${agents
        .map((a) => {
          const statusColors = {
            online: "#22c55e",
            idle: "#3b82f6",
            busy: "#f59e0b",
            error: "#ef4444",
          };
          const dotColor = statusColors[a.status] || "#6b7280";
          return `
          <div class="agent-card">
            <div class="agent-header">
              <span class="sse-dot" style="background:${dotColor}"></span>
              <strong>${esc(a.name)}</strong>
            </div>
            <div class="agent-meta">
              ${typeBadge(a.type)}
              <span class="meta-text">${esc(a.model || "—")}</span>
            </div>
            <div class="agent-footer">
              <span class="meta-text">Last seen: ${formatRelativeTime(a.last_seen)}</span>
            </div>
          </div>
        `;
        })
        .join("")}
    </div>
  `;
}

// --- Event log ---

export function renderEventLog(container, events) {
  const eventsHtml =
    events.length === 0
      ? '<div class="empty-row">No events</div>'
      : events
          .slice(-100)
          .reverse()
          .map((e) => {
            const catColors = {
              task: "#3b82f6",
              agent: "#22c55e",
              fleet: "#a855f7",
              security: "#ef4444",
            };
            const color = catColors[e.data?.category] || "#6b7280";
            const time = e.data?.timestamp
              ? new Date(e.data.timestamp).toLocaleTimeString()
              : "";
            return `<div class="event-row">
            <span class="event-time">${time}</span>
            <span class="badge" style="background:${color};font-size:10px">${esc(e.type)}</span>
            <span class="event-summary">${esc(eventSummary(e))}</span>
          </div>`;
          })
          .join("");

  container.innerHTML = `
    <div class="event-log-header"><h4>Events</h4></div>
    <div class="event-list" id="event-list">${eventsHtml}</div>
  `;
}

function eventSummary(e) {
  const d = e.data?.data || {};
  if (e.type.startsWith("task.")) {
    return d.title || d.task_id || e.type;
  }
  if (e.type.startsWith("agent.")) {
    return d.agent_id || d.name || e.type;
  }
  return JSON.stringify(d).slice(0, 80);
}

// --- Submit form (modal) ---

export function renderSubmitForm(container, onSubmit, onClose) {
  container.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <h3>Submit Task</h3>
        <button class="modal-close">&times;</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label>Title *</label>
          <input type="text" id="submit-title" placeholder="Task title" />
        </div>
        <div class="form-group">
          <label>Description *</label>
          <textarea id="submit-desc" rows="3" placeholder="What should be done?"></textarea>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Priority</label>
            <select id="submit-priority">
              <option value="normal" selected>Normal</option>
              <option value="low">Low</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          </div>
          <div class="form-group">
            <label>Agent Type</label>
            <select id="submit-type">
              <option value="">Auto</option>
              <option value="fast">Fast</option>
              <option value="heavy">Heavy</option>
              <option value="swarm">Swarm</option>
              <option value="nanoclaw">NanoClaw</option>
              <option value="a2a">A2A</option>
            </select>
          </div>
        </div>
        <div class="form-group">
          <label>Tools (comma-separated)</label>
          <input type="text" id="submit-tools" placeholder="shell_exec, http_fetch" />
        </div>
        <div class="form-group">
          <label>Input (JSON, optional)</label>
          <textarea id="submit-input" rows="2" placeholder='{"key": "value"}'></textarea>
        </div>
        <div id="submit-error" class="error-text"></div>
        <button class="btn-primary" id="submit-btn" style="width:100%;margin-top:12px">Submit</button>
      </div>
    </div>
  `;

  container.classList.remove("hidden");
  container.querySelector(".modal-close").addEventListener("click", onClose);
  container.addEventListener("click", (e) => {
    if (e.target === container) onClose();
  });

  document.getElementById("submit-btn").addEventListener("click", async () => {
    const title = document.getElementById("submit-title").value.trim();
    const description = document.getElementById("submit-desc").value.trim();
    const priority = document.getElementById("submit-priority").value;
    const agent_type =
      document.getElementById("submit-type").value || undefined;
    const toolsRaw = document.getElementById("submit-tools").value.trim();
    const inputRaw = document.getElementById("submit-input").value.trim();

    if (!title || !description) {
      document.getElementById("submit-error").textContent =
        "Title and description are required";
      return;
    }

    let input;
    if (inputRaw) {
      try {
        input = JSON.parse(inputRaw);
      } catch {
        document.getElementById("submit-error").textContent =
          "Invalid JSON in input field";
        return;
      }
    }

    const tools = toolsRaw
      ? toolsRaw
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : undefined;

    const btn = document.getElementById("submit-btn");
    btn.disabled = true;
    btn.textContent = "Submitting...";
    document.getElementById("submit-error").textContent = "";

    try {
      await onSubmit({
        title,
        description,
        priority,
        agent_type,
        tools,
        input,
      });
    } catch (err) {
      document.getElementById("submit-error").textContent = err.message;
      btn.disabled = false;
      btn.textContent = "Submit";
    }
  });
}

// --- Notification toast ---

export function renderNotification(container, message, type = "info") {
  const colors = { info: "#3b82f6", success: "#22c55e", error: "#ef4444" };
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.style.borderLeftColor = colors[type] || colors.info;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// --- Utility ---

function formatJson(str) {
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}
