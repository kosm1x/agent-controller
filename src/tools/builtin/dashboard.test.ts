import { describe, it, expect } from "vitest";
import { dashboardGenerateTool, dashboardListTool } from "./dashboard.js";

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
});
