import { describe, it, expect } from "vitest";
import { FrontmatterError, parseSkillFile } from "./frontmatter.js";

const VALID = `---
name: send-followup
description: Sends a follow-up WhatsApp message to a lead after a stalled conversation.
version: 1.0.0
output_type: text
trigger_examples:
  - "Send a follow-up to the lead"
  - "Reach out to the contact about Acme"
  - "Check status on the prospect for Q3"
tools_used:
  - whatsapp_send
  - crm_query
inputs_json: '[{"name":"lead_id","type":"string","required":true}]'
tests_json: '[{"name":"happy","input":{"lead_id":"L1"},"expect":{}}]'
---
# Steps

1. Look up the lead.
2. Compose a message.
3. Send it via whatsapp.
`;

describe("parseSkillFile — happy path", () => {
  it("parses a valid frontmatter + body", () => {
    const result = parseSkillFile(VALID);
    expect(result.frontmatter.name).toBe("send-followup");
    expect(result.frontmatter.version).toBe("1.0.0");
    expect(result.frontmatter.output_type).toBe("text");
    expect(result.frontmatter.trigger_examples).toHaveLength(3);
    expect(result.frontmatter.tools_used).toEqual([
      "whatsapp_send",
      "crm_query",
    ]);
    expect(result.body).toContain("# Steps");
  });

  it("strips inline `# comment` from scalar lines", () => {
    const withComment = VALID.replace(
      "version: 1.0.0",
      "version: 1.0.0  # bumped 2026-05-19",
    );
    const result = parseSkillFile(withComment);
    expect(result.frontmatter.version).toBe("1.0.0");
  });

  it("supports unquoted bare values for scalars", () => {
    const result = parseSkillFile(VALID);
    expect(result.frontmatter.description).toContain("WhatsApp message");
  });

  it("preserves `#` inside a quoted description (R1-W1 regression)", () => {
    // Prior bug: greedy `indexOf("#")` truncated `description: "Priority
    // #1 ticket"` to `description: "Priority `, silently corrupting the
    // stored value. The quote-aware stripper preserves it.
    const withHash = VALID.replace(
      /description: .*/,
      'description: "Priority #1 follow-up template for stalled leads"',
    );
    const result = parseSkillFile(withHash);
    expect(result.frontmatter.description).toBe(
      "Priority #1 follow-up template for stalled leads",
    );
  });

  it("preserves `#` inside a quoted array item (R1-W4 regression)", () => {
    // Same bug-class on `  - "Reach out about #marketing"`. The quote
    // state must persist across the array regex consumer.
    const withHash = VALID.replace(
      '  - "Send a follow-up to the lead"',
      '  - "Reach out about #marketing campaign"',
    );
    const result = parseSkillFile(withHash);
    expect(result.frontmatter.trigger_examples[0]).toBe(
      "Reach out about #marketing campaign",
    );
  });
});

describe("parseSkillFile — validation failures", () => {
  it("rejects missing opening fence", () => {
    const bad = "name: foo\ndescription: bar\n---\nbody";
    expect(() => parseSkillFile(bad)).toThrowError(FrontmatterError);
    try {
      parseSkillFile(bad);
    } catch (err) {
      expect(err).toBeInstanceOf(FrontmatterError);
      expect((err as FrontmatterError).kind).toBe("no_fence");
    }
  });

  it("rejects missing closing fence", () => {
    const bad = "---\nname: foo\ndescription: bar\n# no closing fence\nbody";
    try {
      parseSkillFile(bad);
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as FrontmatterError).kind).toBe("no_fence");
    }
  });

  it("rejects fewer than 3 trigger_examples (retrieval grounding invariant)", () => {
    const tooFew = VALID.replace(
      /trigger_examples:[\s\S]*?tools_used:/,
      `trigger_examples:
  - "only one"
tools_used:`,
    );
    try {
      parseSkillFile(tooFew);
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as FrontmatterError).kind).toBe("validation");
      const issues = (err as FrontmatterError).issues ?? [];
      expect(issues.some((i) => i.path.join(".") === "trigger_examples")).toBe(
        true,
      );
    }
  });

  it("rejects non-semver version", () => {
    const badVer = VALID.replace("version: 1.0.0", "version: latest");
    try {
      parseSkillFile(badVer);
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as FrontmatterError).kind).toBe("validation");
    }
  });

  it("rejects malformed name (uppercase, underscores)", () => {
    const bad = VALID.replace("name: send-followup", "name: Send_Followup");
    try {
      parseSkillFile(bad);
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as FrontmatterError).kind).toBe("validation");
    }
  });

  it("rejects inputs_json that does not parse to an array", () => {
    const bad = VALID.replace(
      /inputs_json: '\[\{[^']+\}\]'/,
      "inputs_json: 'not-json'",
    );
    try {
      parseSkillFile(bad);
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as FrontmatterError).kind).toBe("validation");
    }
  });

  it("rejects unknown enum value for output_type", () => {
    const bad = VALID.replace("output_type: text", "output_type: binary");
    try {
      parseSkillFile(bad);
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as FrontmatterError).kind).toBe("validation");
    }
  });
});

describe("parseSkillFile — parse-layer failures", () => {
  it("rejects indented top-level keys", () => {
    const bad = `---
  name: send-followup
description: hello
---
body`;
    try {
      parseSkillFile(bad);
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as FrontmatterError).kind).toBe("parse");
    }
  });

  it("rejects a line without a colon (not a comment, not blank)", () => {
    const bad = `---
name: send-followup
just-a-bare-line
description: hello
---
body`;
    try {
      parseSkillFile(bad);
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as FrontmatterError).kind).toBe("parse");
    }
  });
});
