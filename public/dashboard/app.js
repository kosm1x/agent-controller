/**
 * Mission Control Dashboard — main app.
 * State management, SSE orchestration, init flow.
 */

import {
  getApiKey,
  setApiKey,
  clearApiKey,
  fetchHealth,
  fetchTasks,
  fetchTaskDetail,
  fetchAgents,
  submitTask,
  cancelTask,
  connectSSE,
} from "./api.js";

import {
  renderLogin,
  renderHealthBar,
  renderNav,
  renderTaskList,
  renderTaskDetail,
  renderAgentFleet,
  renderEventLog,
  renderSubmitForm,
  renderNotification,
} from "./components.js";

// --- State ---

const state = {
  connectionStatus: "disconnected",
  sseConnection: null,
  health: null,
  tasks: [],
  agents: [],
  events: [],
  activeTab: "tasks",
  taskFilters: { status: "", agent_type: "", limit: 50 },
  intervals: {},
};

const MAX_EVENTS = 500;

// --- DOM refs ---

const $healthBar = document.getElementById("health-bar");
const $nav = document.getElementById("nav-tabs");
const $main = document.getElementById("main-content");
const $eventLog = document.getElementById("event-log");
const $modal = document.getElementById("modal-overlay");
const $login = document.getElementById("login-overlay");
const $notifications = document.getElementById("notifications");

// --- Init ---

async function init() {
  const key = getApiKey();
  if (!key) {
    showLogin();
    return;
  }

  try {
    await fetchTasks({ limit: 1 });
  } catch {
    clearApiKey();
    showLogin("Invalid or expired API key");
    return;
  }

  hideLogin();
  await loadAll();
  startSSE();
  startPolling();
}

function showLogin(errorMsg) {
  renderLogin($login, async (key) => {
    setApiKey(key);
    try {
      await fetchTasks({ limit: 1 });
    } catch {
      clearApiKey();
      throw new Error("Invalid API key");
    }
    hideLogin();
    await loadAll();
    startSSE();
    startPolling();
  });
  if (errorMsg) {
    const errEl = document.getElementById("login-error");
    if (errEl) errEl.textContent = errorMsg;
  }
}

function hideLogin() {
  $login.innerHTML = "";
  $login.classList.add("hidden");
}

// --- Data loading ---

async function loadAll() {
  const [healthRes, tasksRes, agentsRes] = await Promise.allSettled([
    fetchHealth(),
    fetchTasks(state.taskFilters),
    fetchAgents(),
  ]);

  if (healthRes.status === "fulfilled") state.health = healthRes.value;
  if (tasksRes.status === "fulfilled") state.tasks = tasksRes.value.tasks || [];
  if (agentsRes.status === "fulfilled")
    state.agents = agentsRes.value.agents || [];

  renderAll();
}

async function refreshTasks() {
  try {
    const res = await fetchTasks(state.taskFilters);
    state.tasks = res.tasks || [];
    if (state.activeTab === "tasks") renderMainContent();
  } catch {
    /* ignore */
  }
}

async function refreshAgents() {
  try {
    const res = await fetchAgents();
    state.agents = res.agents || [];
    if (state.activeTab === "agents") renderMainContent();
  } catch {
    /* ignore */
  }
}

async function refreshHealth() {
  try {
    state.health = await fetchHealth();
    renderHealthBar($healthBar, state.health, state.connectionStatus);
  } catch {
    /* ignore */
  }
}

// --- SSE ---

function startSSE() {
  if (state.sseConnection) state.sseConnection.close();

  state.sseConnection = connectSSE(
    (event) => {
      state.events.push(event);
      if (state.events.length > MAX_EVENTS) {
        state.events = state.events.slice(-MAX_EVENTS);
      }

      // Re-render events
      if (state.activeTab === "events") {
        renderMainContent();
      } else {
        renderEventLog($eventLog, state.events);
      }

      // React to task events
      if (event.type.startsWith("task.")) {
        refreshTasks();
      }
      if (event.type.startsWith("agent.")) {
        refreshAgents();
      }
    },
    () => {
      state.connectionStatus = "reconnecting";
      renderHealthBar($healthBar, state.health, state.connectionStatus);
    },
    () => {
      state.connectionStatus = "connected";
      renderHealthBar($healthBar, state.health, state.connectionStatus);
    },
  );
}

function startPolling() {
  state.intervals.health = setInterval(refreshHealth, 30000);
  state.intervals.agents = setInterval(refreshAgents, 30000);
}

// --- Rendering ---

function renderAll() {
  renderHealthBar($healthBar, state.health, state.connectionStatus);
  renderNav($nav, state.activeTab, onTabChange, onSubmitClick);
  renderMainContent();
  renderEventLog($eventLog, state.events);
}

function renderMainContent() {
  switch (state.activeTab) {
    case "tasks":
      renderTaskList(
        $main,
        state.tasks,
        state.taskFilters,
        onTaskClick,
        onFilterChange,
        onCancelTask,
      );
      break;
    case "agents":
      renderAgentFleet($main, state.agents);
      break;
    case "events":
      renderEventLog($main, state.events);
      break;
  }
}

// --- Event handlers ---

function onTabChange(tab) {
  state.activeTab = tab;
  renderNav($nav, state.activeTab, onTabChange, onSubmitClick);
  renderMainContent();
}

async function onTaskClick(taskId) {
  try {
    const data = await fetchTaskDetail(taskId);
    renderTaskDetail($modal, data, closeModal, onTaskClick);
  } catch (err) {
    renderNotification(
      $notifications,
      `Failed to load task: ${err.message}`,
      "error",
    );
  }
}

function onFilterChange(filters) {
  state.taskFilters = filters;
  refreshTasks();
}

async function onCancelTask(taskId) {
  try {
    await cancelTask(taskId);
    renderNotification($notifications, "Task cancelled", "success");
    refreshTasks();
  } catch (err) {
    renderNotification(
      $notifications,
      `Cancel failed: ${err.message}`,
      "error",
    );
  }
}

function onSubmitClick() {
  renderSubmitForm(
    $modal,
    async (payload) => {
      await submitTask(payload);
      closeModal();
      renderNotification($notifications, "Task submitted", "success");
      refreshTasks();
    },
    closeModal,
  );
}

function closeModal() {
  $modal.innerHTML = "";
  $modal.classList.add("hidden");
}

// --- Start ---

init();
