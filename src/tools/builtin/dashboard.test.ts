import { describe, it, expect } from "vitest";
import {
  dashboardGenerateTool,
  dashboardListTool,
  renderDashboardHtml,
} from "./dashboard.js";
import { Hono } from "hono";
import dashboardRoute, { DASHBOARD_CSP } from "../../api/routes/dashboard.js";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { randomUUID } from "crypto";

describe("dashboard tools", () => {
  it("dashboard_generate has correct name and required params", () => {
    expect(dashboardGenerateTool.name).toBe("dashboard_generate");
    const params = dashboardGenerateTool.definition.function.parameters as {
      required: string[];
    };
    expect(params.required).toContain("data");
    expect(params.required).toContain("question");
  });

  it("dashboard_generate returns error when data missing", async () => {
    const result = await dashboardGenerateTool.execute({ question: "test" });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("data is required");
  });

  it("dashboard_generate returns error when question missing", async () => {
    const result = await dashboardGenerateTool.execute({ data: "a,b\n1,2" });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("question is required");
  });

  it("dashboard_list has correct name", () => {
    expect(dashboardListTool.name).toBe("dashboard_list");
  });

  it("dashboard_list returns array structure", async () => {
    const result = await dashboardListTool.execute({});
    const parsed = JSON.parse(result);
    expect(Array.isArray(parsed.dashboards)).toBe(true);
    expect(typeof parsed.count).toBe("number");
  });

  // audit 2026-09-22: stored XSS via LLM-authored config / user data.
  it("renderDashboardHtml keeps </script> and $& inside the script block", () => {
    const html = renderDashboardHtml(
      "T",
      "a</script><img src=x onerror=alert(1)>",
      { title: "$& $' </script>", kpis: [] },
    );
    // Exactly the template's own two script tags close.
    expect(html.match(/<\/script>/gi)?.length).toBe(2);
    expect(html).toContain("\\u003c/script>");
    expect(html).toContain("$& $'");
    expect(html).not.toContain("{{");
  });

  it("placeholder text inside title/data is not re-substituted", () => {
    const html = renderDashboardHtml("{{CONFIG}}", "{{DATA}}", { a: 1 });
    expect(html).toContain('const C = {"a":1};');
    expect(html).toContain('const D = "{{DATA}}";');
    expect(html).toContain("<title>{{CONFIG}}</title>");
  });

  it("template escapes LLM strings before innerHTML", () => {
    const html = renderDashboardHtml("T", "", {});
    expect(html).toContain("esc(k.value)");
    expect(html).toContain("esc(k.label)");
    expect(html).toContain("esc(k.delta)");
    expect(html).toContain("esc(c.title)");
    // Behavioural: evaluate the template's own esc() and check its output.
    const escSrc = html.match(/const esc = (.+);\n/)?.[1];
    expect(escSrc).toBeDefined();
    const esc = new Function(`return ${escSrc}`)() as (v: unknown) => string;
    expect(esc("<img src=x onerror=alert(1)>")).not.toMatch(/[<>]/);
    expect(esc('"')).toBe("&#34;");
    expect(esc("'&")).toBe("&#39;&#38;");
    expect(esc(null)).toBe("");
  });

  it("drops markup-bearing ECharts formatters, keeps plain templates", () => {
    const html = renderDashboardHtml("t", "d", {
      charts: [
        {
          option: {
            tooltip: { formatter: "<img src=x onerror=alert(1)>{b}" },
            series: [{ label: { formatter: "{b}: {c}" } }],
          },
        },
      ],
    });
    expect(html).not.toContain("onerror");
    expect(html).toContain('"formatter":"{b}: {c}"');
  });

  it("non-id paths fall through to the SPA assets", async () => {
    const app = new Hono();
    app.route("/dashboard", dashboardRoute);
    app.get("/dashboard/*", (c) => c.text("static"));
    for (const asset of ["app.js", "api.js", "index.html"]) {
      const res = await app.request(`/dashboard/${asset}`);
      expect(await res.text()).toBe("static");
    }
    const miss = await app.request(`/dashboard/${randomUUID()}`);
    expect(miss.status).toBe(404);
    expect(await miss.text()).toBe("Dashboard not found");
  });

  it("dashboard route serves with a CSP sandbox", async () => {
    const id = randomUUID();
    mkdirSync("/tmp/dashboards", { recursive: true });
    const file = `/tmp/dashboards/${id}.html`;
    writeFileSync(file, "<html></html>");
    try {
      const res = await dashboardRoute.request(`/${id}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-security-policy")).toBe(DASHBOARD_CSP);
      expect(DASHBOARD_CSP).toMatch(/^sandbox allow-scripts;/);
      expect(DASHBOARD_CSP).not.toContain("allow-same-origin");
    } finally {
      rmSync(file, { force: true });
    }
  });
});
