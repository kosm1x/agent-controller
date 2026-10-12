/**
 * S6 WS1 — project record parser (spec §2). Synthetic records only.
 */

import { describe, expect, it } from "vitest";
import {
  KB_README_RE,
  ProjectRecordError,
  isProjectRecordPath,
  parseProjectRecord,
  projectRecordRelPath,
  recordSlugFromPath,
  renderProjectRecord,
  replaceRecordDescription,
  replaceRecordJson,
} from "./record.js";

const block = (json: unknown) => "```json\n" + JSON.stringify(json, null, 2) + "\n```\n";

const FULL = {
  slug: "acme-radar",
  name: "Acme Radar",
  status: "active",
  aliases: ["acme", "radar acme"],
  match_priority: 3,
  stall_exempt: false,
  kb_readme: "projects/acme-other/README.md",
  trusted: false,
  egress: ["api.example.test", "data.example.test:443"],
  parent: "acme-group",
  kb_folder: "projects/acme-radar/",
  repos: [
    { path: "/srv/work/acme-radar", role: "primary" },
    { path: "/srv/work/acme-journal", role: "other" },
  ],
  deny_paths: ["/srv/work/acme-radar/.secrets"],
  secrets: ["SECRET_ACME_TOKEN"],
  capabilities: {
    mcp: [
      {
        id: "acme",
        command: "node",
        args: ["dist/mcp.js"],
        repo: "primary",
        cwd: ".",
        env: ["ACME_API_TOKEN"],
        trust: "AB",
        tools: { acme_run: { trust: "B", destructive: true } },
        deferred: [],
      },
    ],
    brief: "Capability brief",
  },
  routing: { summary: "Acme radar scans" },
  schedules: ["sched-0001"],
  inbound: { route: "/api/acme-pull", token_secret: "ACME_INBOUND_TOKEN" },
  success: { daylog: true, gates: true },
  links: { site: "https://acme.example.test" },
};

const reasonOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ProjectRecordError);
    return (err as ProjectRecordError).reason;
  }
  throw new Error("expected a ProjectRecordError");
};

describe("parseProjectRecord — valid records", () => {
  it("parses every field of the spec §2 table, notes and description", () => {
    const md = block(FULL) + "\nA weekly scanner for synthetic tickers.\nSecond line.\n\n## Runtime\n\nservice notes\n";
    const r = parseProjectRecord(md, { folderSlug: "acme-radar" });
    expect(r.contract).toEqual(FULL);
    expect(r.description).toBe("A weekly scanner for synthetic tickers.\nSecond line.");
    expect(r.notes.startsWith("A weekly scanner")).toBe(true);
    expect(r.notes).toContain("## Runtime");
    expect(r.json).toEqual(FULL); // as written, no defaults
  });

  it("applies the defaults: match_priority 0, trusted false, kb_folder projects/<slug>/, kb_readme <kb_folder>/README.md", () => {
    const md = block({ slug: "beta-one", name: "Beta One", status: "paused" });
    const r = parseProjectRecord(md, { folderSlug: "beta-one" });
    expect(r.contract.match_priority).toBe(0);
    expect(r.contract.trusted).toBe(false);
    expect(r.contract.kb_folder).toBe("projects/beta-one/");
    expect(r.contract.kb_readme).toBe("projects/beta-one/README.md");
    expect(r.contract.aliases).toBeUndefined();
    expect(r.json).toEqual({ slug: "beta-one", name: "Beta One", status: "paused" });
    expect(r.description).toBe("");
    expect(r.notes).toBe("");
  });

  it("kb_readme defaults from a custom kb_folder without a double slash; success defaults daylog/gates", () => {
    const md = block({
      slug: "beta-two",
      name: "B",
      status: "active",
      kb_folder: "projects/elsewhere/",
      success: {},
    });
    const r = parseProjectRecord(md, { folderSlug: "beta-two" });
    expect(r.contract.kb_readme).toBe("projects/elsewhere/README.md");
    expect(r.contract.success).toEqual({ daylog: true, gates: false });
  });

  it("the JSON block is the FIRST ```json block; a later one is notes", () => {
    const md =
      "# Title line\n\n" +
      block({ slug: "gamma", name: "G", status: "active" }) +
      "\nLead paragraph.\n\n## Legacy config\n\n" +
      block({ not: "the contract" });
    const r = parseProjectRecord(md, { folderSlug: "gamma" });
    expect(r.contract.slug).toBe("gamma");
    expect(r.notes).toContain('"not": "the contract"');
    expect(r.description).toBe("Lead paragraph.");
  });

  it("description: first non-empty lead paragraph, title line skipped, NEVER truncated (R1 C2), never from a ## section", () => {
    const base = block({ slug: "delta", name: "D", status: "active" });
    for (const n of [391, 1200]) {
      const long = "Synthetic word ".repeat(Math.ceil(n / 15)).slice(0, n).trim();
      expect(parseProjectRecord(base + "\n# Delta\n\n" + long, { folderSlug: "delta" }).description).toBe(long);
    }
    expect(
      parseProjectRecord(base + "\n## Legacy config\n\nCopied text.\n", { folderSlug: "delta" }).description,
    ).toBe("");
    expect(
      parseProjectRecord(base + "\n\n\n   \n\nAfter blanks.\n", { folderSlug: "delta" }).description,
    ).toBe("After blanks.");
  });
});

describe("parseProjectRecord — every error reason", () => {
  it("no_json_block", () => {
    expect(reasonOf(() => parseProjectRecord("# Just notes\n\ntext", { folderSlug: "a1" }))).toBe(
      "no_json_block",
    );
    expect(reasonOf(() => parseProjectRecord("```js\n{}\n```\n", { folderSlug: "a1" }))).toBe(
      "no_json_block",
    );
  });

  it("invalid_json", () => {
    expect(reasonOf(() => parseProjectRecord("```json\n{ slug: x\n```\n", { folderSlug: "a1" }))).toBe(
      "invalid_json",
    );
  });

  it("schema — missing required, bad slug, bad status, bad types; issues carried", () => {
    for (const bad of [
      { name: "N", status: "active" },
      { slug: "Bad_Slug", name: "N", status: "active" },
      { slug: "ok-slug", name: "N", status: "live" },
      { slug: "ok-slug", name: "", status: "active" },
      { slug: "ok-slug", name: "N", status: "active", aliases: "one" },
      { slug: "ok-slug", name: "N", status: "active", match_priority: 1.5 },
      { slug: "ok-slug", name: "N", status: "active", kb_folder: "../escape/" },
      { slug: "ok-slug", name: "N", status: "active", kb_readme: "projects/x/README.txt" },
      { slug: "ok-slug", name: "N", status: "active", repos: [{ path: "relative", role: "primary" }] },
      {
        slug: "ok-slug",
        name: "N",
        status: "active",
        repos: [
          { path: "/a", role: "primary" },
          { path: "/b", role: "primary" },
        ],
      },
      { slug: "ok-slug", name: "N", status: "active", secrets: ["NOT_SECRET_PREFIX"] },
      { slug: "ok-slug", name: "N", status: "active", success: { daylog: false } },
      { slug: "ok-slug", name: "N", status: "active", capabilities: { mcp: [{ args: [] }] } },
      { slug: "ok-slug", name: "N", status: "active", links: { site: "x", admin: "y" } },
    ]) {
      let err: ProjectRecordError | undefined;
      try {
        parseProjectRecord(block(bad), { folderSlug: "ok-slug" });
      } catch (e) {
        err = e as ProjectRecordError;
      }
      expect(err?.reason, JSON.stringify(bad)).toBe("schema");
      expect(err?.issues.length, JSON.stringify(bad)).toBeGreaterThan(0);
    }
  });

  it("S6 WS3 audit R1: mcp id with `__`, reserved env names (each class) and `lazy` are schema errors", () => {
    const withMcp = (entry: Record<string, unknown>) => ({
      slug: "ok-slug",
      name: "N",
      status: "active",
      capabilities: { mcp: [{ command: "node", ...entry }] },
    });
    const bad: Array<Record<string, unknown>> = [
      withMcp({ id: "browser__evil" }),
      withMcp({ id: "a__" }),
      withMcp({ lazy: true }),
      withMcp({ lazy: false }),
      { slug: "ok-slug", name: "N", status: "active", inbound: { route: "/x", token_secret: "TELEGRAM_BOT_TOKEN" } },
    ];
    // exact names + every prefix family
    for (const name of [
      "PATH", "HOME", "SHELL", "USER", "LOGNAME", "TERM", "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS",
      "NODE_TLS_REJECT_UNAUTHORIZED", "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "PYTHONPATH", "PYTHONSTARTUP",
      "PYTHONHOME", "BASH_ENV", "ENV", "PERL5OPT", "PERL5LIB", "RUBYOPT", "GIT_EXEC_PATH", "TMPDIR", "IFS",
      "LD_X", "DYLD_INSERT_LIBRARIES", "NODE_X", "PYTHONX", "MC_X", "JARVIS_X", "DATABASE_URL", "TELEGRAM_BOT_TOKEN",
      "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "FIREWORKS_API_KEY", "GEMINI_API_KEY", "GOOGLE_X", "SMTP_PASS", "IMAP_PASS",
    ]) {
      bad.push(withMcp({ env: [name] }));
    }
    for (const b of bad) {
      let err: ProjectRecordError | undefined;
      try {
        parseProjectRecord(block(b), { folderSlug: "ok-slug" });
      } catch (e) {
        err = e as ProjectRecordError;
      }
      expect(err?.reason, JSON.stringify(b)).toBe("schema");
    }
    // the record's own names still pass
    const ok = parseProjectRecord(block(withMcp({ id: "ok_id-1", env: ["ACME_API_TOKEN", "XPOZ_API_TOKEN"] })), {
      folderSlug: "ok-slug",
    });
    expect(ok.contract.capabilities?.mcp?.[0]?.env).toEqual(["ACME_API_TOKEN", "XPOZ_API_TOKEN"]);
  });

  it("audit R2b: the derived kb_readme default is set only when it matches KB_README_RE", () => {
    const parse = (extra: Record<string, unknown>) =>
      parseProjectRecord(block({ slug: "ok-slug", name: "N", status: "active", ...extra }), { folderSlug: "ok-slug" }).contract;
    expect(parse({ kb_folder: "knowledge/x" }).kb_readme).toBeUndefined();
    expect(parse({ kb_folder: "projects/a/b" }).kb_readme).toBeUndefined();
    expect(parse({}).kb_readme).toBe("projects/ok-slug/README.md");
  });

  it("audit R2 W2: kb_readme must match KB_README_RE (one .md directly under projects/<folder>/)", () => {
    for (const bad of ["projects/x/README.MD", "knowledge/x.md", "projects/x/sub/README.md", "projects/x/a\nb.md"]) {
      let err: ProjectRecordError | undefined;
      try {
        parseProjectRecord(block({ slug: "ok-slug", name: "N", status: "active", kb_readme: bad }), { folderSlug: "ok-slug" });
      } catch (e) {
        err = e as ProjectRecordError;
      }
      expect(err?.reason, JSON.stringify(bad)).toBe("schema");
      expect(KB_README_RE.test(bad), JSON.stringify(bad)).toBe(false);
    }
    const live = "projects/williams-entry-radar/README.md";
    expect(parseProjectRecord(block({ slug: "ok-slug", name: "N", status: "active", kb_readme: live }), { folderSlug: "ok-slug" }).contract.kb_readme).toBe(live);
  });

  it("schema — an unknown top-level key is an error (strict)", () => {
    let err: ProjectRecordError | undefined;
    try {
      parseProjectRecord(block({ slug: "ok-slug", name: "N", status: "active", owner: "x" }), {
        folderSlug: "ok-slug",
      });
    } catch (e) {
      err = e as ProjectRecordError;
    }
    expect(err?.reason).toBe("schema");
    expect(err?.issues.some((i) => i.code === "unrecognized_keys")).toBe(true);
  });

  it("slug_mismatch: the contract slug must equal the folder name", () => {
    expect(
      reasonOf(() =>
        parseProjectRecord(block({ slug: "other-one", name: "N", status: "active" }), {
          folderSlug: "this-one",
        }),
      ),
    ).toBe("slug_mismatch");
  });

  it("the error message never carries record content", () => {
    const secretish = "zz-" + "q".repeat(12);
    try {
      parseProjectRecord(block({ slug: "ok-slug", name: secretish, status: "nope" }), {
        folderSlug: "ok-slug",
      });
    } catch (e) {
      expect((e as Error).message).not.toContain(secretish);
    }
  });
});

describe("path helpers", () => {
  it("projectRecordRelPath / recordSlugFromPath", () => {
    expect(projectRecordRelPath("acme-radar")).toBe("projects/acme-radar/project.md");
    expect(recordSlugFromPath("projects/acme-radar/project.md")).toBe("acme-radar");
    expect(recordSlugFromPath("projects/acme-radar/README.md")).toBeNull();
  });

  it("isProjectRecordPath without kbRoot: exactly the canonical spelling", () => {
    expect(isProjectRecordPath("projects/acme-radar/project.md")).toBe(true);
    for (const p of [
      "projects/acme-radar/Project.md",
      "./projects/acme-radar/project.md",
      "projects/acme-radar/sub/project.md",
      "projects/project.md",
      "projects/Acme/project.md",
      "knowledge/projects/acme/project.md",
    ]) {
      expect(isProjectRecordPath(p), p).toBe(false);
    }
  });

  it("isProjectRecordPath with kbRoot: every spelling canonicalKbPath folds", () => {
    const root = "/srv/kb";
    for (const p of [
      "projects/acme/project.md",
      "./projects/acme/project.md",
      "/projects/acme/project.md",
      "  projects/acme/project.md ",
      "projects\\acme\\project.md",
      "Projects/acme/Project.md",
      "knowledge/../projects/acme/project.md",
      "../kb/projects/acme/project.md",
      ".//projects/acme/./project.md",
    ]) {
      expect(isProjectRecordPath(p, root), p).toBe(true);
    }
    for (const p of ["projects/acme/README.md", "../projects/acme/project.md", "projects/acme"]) {
      expect(isProjectRecordPath(p, root), p).toBe(false);
    }
  });
});

describe("render / rewrite helpers", () => {
  it("renderProjectRecord round-trips through the parser", () => {
    const md = renderProjectRecord({ slug: "eps", name: "E", status: "active" }, "Lead.\n\n## More\n\nx");
    const r = parseProjectRecord(md, { folderSlug: "eps" });
    expect(r.description).toBe("Lead.");
    expect(md.startsWith("```json\n")).toBe(true);
  });

  it("replaceRecordJson keeps every byte outside the block", () => {
    const md = "# T\n\n" + block({ slug: "eps", name: "E", status: "active" }) + "\nLead.\n";
    const next = replaceRecordJson(md, { slug: "eps", name: "E2", status: "paused" });
    expect(next.startsWith("# T\n\n```json\n")).toBe(true);
    expect(next.endsWith("\nLead.\n")).toBe(true);
    expect(parseProjectRecord(next, { folderSlug: "eps" }).contract.name).toBe("E2");
  });

  it("replaceRecordDescription replaces the lead paragraph, or inserts one before the sections", () => {
    const md = block({ slug: "eps", name: "E", status: "active" }) + "\nOld lead.\n\n## Legacy config\n\nkept\n";
    const next = replaceRecordDescription(md, "New lead\n\nwith a blank line");
    const r = parseProjectRecord(next, { folderSlug: "eps" });
    expect(r.description).toBe("New lead\nwith a blank line");
    expect(next).toContain("## Legacy config\n\nkept");
    expect(next).not.toContain("Old lead.");

    const bare = block({ slug: "eps", name: "E", status: "active" }) + "\n## Legacy config\n\nkept\n";
    const inserted = replaceRecordDescription(bare, "Inserted.");
    expect(parseProjectRecord(inserted, { folderSlug: "eps" }).description).toBe("Inserted.");
    expect(inserted).toContain("## Legacy config\n\nkept");
  });

  it("replaceRecordDescription treats the text literally: $' $$ $` $& are not replacement patterns (R1 W1)", () => {
    const md = block({ slug: "eps", name: "E", status: "active" }) + "\nOld lead.\n\n## Notes\n\ntail text\n";
    for (const text of ["costs $$ and $' and $` and $& end", "$1 $<name>"]) {
      const next = replaceRecordDescription(md, text);
      expect(parseProjectRecord(next, { folderSlug: "eps" }).description).toBe(text);
      expect(next).toContain("## Notes\n\ntail text");
      expect(next.match(/tail text/g)).toHaveLength(1);
    }
  });

  it("replaceRecordDescription rewrites the paragraph, not an earlier title line with the same text (R1 W1)", () => {
    const md = block({ slug: "eps", name: "E", status: "active" }) + "\n# Same text\n\nSame text\n";
    const next = replaceRecordDescription(md, "Changed.");
    expect(next).toContain("\n# Same text\n\nChanged.");
    expect(parseProjectRecord(next, { folderSlug: "eps" }).description).toBe("Changed.");
    expect(next).not.toMatch(/^Same text$/m);
  });

  it("replaceRecordDescription with an empty text removes the paragraph and keeps the sections", () => {
    const md = block({ slug: "eps", name: "E", status: "active" }) + "\nOld lead.\n\n## Notes\n\nx\n";
    const next = replaceRecordDescription(md, "");
    expect(parseProjectRecord(next, { folderSlug: "eps" }).description).toBe("");
    expect(next).toContain("## Notes\n\nx");
  });

  it("replaceRecordDescription with no lead paragraph skips a `## ` line inside a fence (R2 Rec 3)", () => {
    const md =
      block({ slug: "eps", name: "E", status: "active" }) + "\n```text\n## not a section\n```\n\n## Notes\n\nx\n";
    const next = replaceRecordDescription(md, "Nueva descripción.");
    expect(parseProjectRecord(next, { folderSlug: "eps" }).description).toBe("Nueva descripción.");
    expect(next).toContain("```text\n## not a section\n```");
    expect(next).toContain("## Notes\n\nx");
  });

  it("`~~~` and 1–3-space indented fences are fences: a `## ` inside one is not a section (R2b)", () => {
    for (const fence of ["~~~", "  ```", "   ~~~"]) {
      const md =
        block({ slug: "eps", name: "E", status: "active" }) +
        `\n${fence}\n## not a section\n${fence}\n\n## Notes\n\nx\n`;
      const next = replaceRecordDescription(md, "Nueva.");
      expect(parseProjectRecord(next, { folderSlug: "eps" }).description, fence).toBe("Nueva.");
      expect(next).toContain(`${fence}\n## not a section\n${fence}`);
    }
  });
});
