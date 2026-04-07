import { describe, it, expect } from "vitest";
import {
  socialPublishTool,
  socialAccountsListTool,
  socialPublishStatusTool,
} from "./social.js";

describe("social tool definitions", () => {
  it("social_publish has correct name and required params", () => {
    expect(socialPublishTool.name).toBe("social_publish");
    const params = socialPublishTool.definition.function.parameters as {
      required: string[];
    };
    expect(params.required).toContain("account_id");
    expect(params.required).toContain("platform");
    expect(params.required).toContain("content_type");
  });

  it("social_accounts_list has correct name", () => {
    expect(socialAccountsListTool.name).toBe("social_accounts_list");
  });

  it("social_publish_status has correct name and required params", () => {
    expect(socialPublishStatusTool.name).toBe("social_publish_status");
    const params = socialPublishStatusTool.definition.function.parameters as {
      required: string[];
    };
    expect(params.required).toContain("record_id");
  });

  it("social_publish returns not-configured stub", async () => {
    const result = await socialPublishTool.execute({
      account_id: "test",
      platform: "instagram",
      content_type: "image",
    });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("not configured");
  });

  it("social_publish_status returns error for missing record_id", async () => {
    const result = await socialPublishStatusTool.execute({});
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("record_id is required");
  });
});
