import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockAll = vi.hoisted(() => ({
  db: {
    prepare: vi.fn().mockReturnValue({ all: vi.fn().mockReturnValue([]) }),
  },
  cancelTask: vi.fn().mockReturnValue(true),
}));

vi.mock("../../db/index.js", () => ({
  getDatabase: () => mockAll.db,
}));

vi.mock("../../dispatch/dispatcher.js", () => ({
  cancelTask: mockAll.cancelTask,
}));

import { admin } from "./admin.js";
import { Hono } from "hono";

function createTestApp(): Hono {
  const app = new Hono();
  app.route("/admin", admin);
  return app;
}

describe("admin routes", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAll.db.prepare.mockReturnValue({
      all: vi.fn().mockReturnValue([]),
    });
    mockAll.cancelTask.mockReturnValue(true);
    process.env.AUTONOMOUS_IMPROVEMENT_ENABLED = "true";
    delete process.env.KILL_PASSPHRASE;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.AUTONOMOUS_IMPROVEMENT_ENABLED =
      originalEnv.AUTONOMOUS_IMPROVEMENT_ENABLED;
    if (originalEnv.KILL_PASSPHRASE) {
      process.env.KILL_PASSPHRASE = originalEnv.KILL_PASSPHRASE;
    } else {
      delete process.env.KILL_PASSPHRASE;
    }
  });

  describe("POST /admin/kill-autonomous", () => {
    it("disables autonomous improvement at runtime", async () => {
      const app = createTestApp();
      const res = await app.request("/admin/kill-autonomous", {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("disabled");
      expect(body.autonomous_improvement_enabled).toBe(false);
      expect(process.env.AUTONOMOUS_IMPROVEMENT_ENABLED).toBe("false");
    });

    it("cancels running improvement tasks", async () => {
      mockAll.db.prepare.mockReturnValue({
        all: vi.fn().mockReturnValue([{ task_id: "t1" }, { task_id: "t2" }]),
      });

      const app = createTestApp();
      const res = await app.request("/admin/kill-autonomous", {
        method: "POST",
      });
      const body = await res.json();
      expect(body.cancelled_tasks).toEqual(["t1", "t2"]);
      expect(mockAll.cancelTask).toHaveBeenCalledTimes(2);
      expect(mockAll.cancelTask).toHaveBeenCalledWith("t1");
      expect(mockAll.cancelTask).toHaveBeenCalledWith("t2");
    });

    it("enforces passphrase when KILL_PASSPHRASE is set", async () => {
      process.env.KILL_PASSPHRASE = "secret123";
      const app = createTestApp();

      // Without passphrase → 403
      const res1 = await app.request("/admin/kill-autonomous", {
        method: "POST",
      });
      expect(res1.status).toBe(403);
      expect(process.env.AUTONOMOUS_IMPROVEMENT_ENABLED).toBe("true");

      // With wrong passphrase → 403
      const res2 = await app.request("/admin/kill-autonomous", {
        method: "POST",
        headers: { "X-Kill-Passphrase": "wrong" },
      });
      expect(res2.status).toBe(403);

      // With correct passphrase → 200
      const res3 = await app.request("/admin/kill-autonomous", {
        method: "POST",
        headers: { "X-Kill-Passphrase": "secret123" },
      });
      expect(res3.status).toBe(200);
      expect(process.env.AUTONOMOUS_IMPROVEMENT_ENABLED).toBe("false");
    });

    it("works without KILL_PASSPHRASE set (no passphrase required)", async () => {
      const app = createTestApp();
      const res = await app.request("/admin/kill-autonomous", {
        method: "POST",
      });
      expect(res.status).toBe(200);
    });

    it("returns empty cancelled_tasks when none running", async () => {
      const app = createTestApp();
      const res = await app.request("/admin/kill-autonomous", {
        method: "POST",
      });
      const body = await res.json();
      expect(body.cancelled_tasks).toEqual([]);
    });
  });

  describe("GET /admin/autonomous-status", () => {
    it("returns enabled when AUTONOMOUS_IMPROVEMENT_ENABLED=true", async () => {
      process.env.AUTONOMOUS_IMPROVEMENT_ENABLED = "true";
      const app = createTestApp();
      const res = await app.request("/admin/autonomous-status");
      const body = await res.json();
      expect(body.autonomous_improvement_enabled).toBe(true);
    });

    it("returns disabled when AUTONOMOUS_IMPROVEMENT_ENABLED=false", async () => {
      process.env.AUTONOMOUS_IMPROVEMENT_ENABLED = "false";
      const app = createTestApp();
      const res = await app.request("/admin/autonomous-status");
      const body = await res.json();
      expect(body.autonomous_improvement_enabled).toBe(false);
    });

    it("returns disabled when env var is not set", async () => {
      delete process.env.AUTONOMOUS_IMPROVEMENT_ENABLED;
      const app = createTestApp();
      const res = await app.request("/admin/autonomous-status");
      const body = await res.json();
      expect(body.autonomous_improvement_enabled).toBe(false);
    });
  });
});
