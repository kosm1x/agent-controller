/**
 * Lock test: a comment names WHAT it refers to (a function, constant, type,
 * test name or section heading, and the file where that helps), never a line
 * number. A line number is wrong after the next edit of the file it points
 * into, and nothing then tells the reader that it moved.
 *
 * Files read: every `.ts` file under src/ and under scripts/, except
 * `*.test.ts`, `*.d.ts`, everything under src/test-utils/, any `__fixtures__`
 * folder and any `node_modules` folder. Each file is parsed with the
 * TypeScript parser (syntax only: no program, no type checker; nothing of the
 * scanned code is imported or run) and only its comments are searched: the
 * text of string, template and regular-expression literals is blanked out
 * first, so a citation inside a literal is not a finding, while a comment
 * inside a template substitution is one.
 *
 * A citation is a file name with a known extension (ts, tsx, js, mjs, cjs, sh,
 * sql, json, md, yml, yaml, py), optionally behind a relative folder path,
 * directly followed by `:` or `#L` and digits (`x.ts:12`, `src/a/b.ts:12`,
 * `x.ts#L12`). It must not continue a word, a path or a URL: the character in
 * front of it is not a letter, digit, `_`, `/`, `.` or `-`. A third-party
 * type file gets no exemption: name the package and its exported type,
 * option or function instead.
 *
 * Limits: shell scripts, SQL, Markdown and every other non-TypeScript file are
 * not read. Not caught: "line N" written without a file name; a file name
 * followed by a space before the number; a citation right after a slash, so
 * a path that starts with `/` or `~/` and a URL written with its scheme
 * (without the scheme a URL reads as a relative path and is caught); an
 * ending outside the list
 * (`.mts`, `.cts`, `.jsx`) or written in upper case; a line written as `:L12`.
 *
 * LEFTOVERS holds one entry per citation that exists on purpose or is still
 * to be rewritten: the file, the matched citation text (never the line the
 * comment is on) and a note. The comparison runs in both directions, with
 * multiplicity, and has no switch that turns it off: a citation the list does
 * not hold fails (NEW), and an entry that matches nothing any more fails
 * (STALE: delete the entry in the same commit). The list can only shrink.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const CITATION = /(?<![\w/.-])(?:[\w@.-]+\/)*[\w.-]*[A-Za-z0-9_-]\.(?:ts|tsx|js|mjs|cjs|sh|sql|json|md|ya?ml|py)(?::|#L)\d+/g;

interface Finding {
  file: string;
  line: number;
  text: string;
}
interface Entry {
  file: string;
  text: string;
  note: string;
}

const REWRITE = "to rewrite by name";

/** Sorted by file, then citation text. */
const LEFTOVERS: readonly Entry[] = [
  { file: "src/inference/adapter.ts", text: "sdk.d.ts:1472", note: `${REWRITE}: the SDK's exported type or option` },
  { file: "src/inference/claude-sdk.ts", text: "adapter-openai.ts:433", note: `${REWRITE}: the OpenAI-compat adapter's function` },
  { file: "src/inference/claude-sdk.ts", text: "adapter.ts:1679", note: `${REWRITE}: the adapter's function` },
  { file: "src/inference/claude-sdk.ts", text: "adapter.ts:770", note: `${REWRITE}: the circuit registry's declaration` },
  { file: "src/inference/claude-sdk.ts", text: "fast-runner.ts:1108", note: `${REWRITE}: the fast runner's function` },
  { file: "src/inference/http-error.ts", text: "adapter.ts:953", note: `${REWRITE}: the adapter's caller that matches the status text` },
  { file: "src/lib/v8-3/pipeline.ts", text: "registry.ts:203", note: `${REWRITE}: the registry's hand-off function` },
  { file: "src/lib/v8-3/pipeline.ts", text: "task-executor.ts:93", note: `${REWRITE}: the task executor's hand-off function` },
  { file: "src/messaging/scope.ts", text: "router.ts:437", note: `${REWRITE}: the router's function` },
];

/** Production .ts files under `<root>/src` and `<root>/scripts`, as paths relative to `root` with `/`. */
function productionFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const dirent of readdirSync(dir, { withFileTypes: true })) {
      if (dirent.name === "node_modules" || dirent.name === "__fixtures__") continue;
      const abs = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        if (abs !== join(root, "src", "test-utils")) walk(abs);
      } else if (dirent.isFile() && dirent.name.endsWith(".ts") && !dirent.name.endsWith(".test.ts") && !dirent.name.endsWith(".d.ts")) {
        out.push(relative(root, abs).split(sep).join("/"));
      }
    }
  };
  for (const top of ["src", "scripts"]) walk(join(root, top));
  return out.sort();
}

/** Tokens whose text is data, not code: blanked out before the comments are scanned. */
const LITERALS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.RegularExpressionLiteral,
]);

/** Every comment of a TypeScript source: its offset and its text, delimiters included. */
function comments(text: string): { pos: number; text: string }[] {
  const sf = ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  // Literal text is replaced by spaces (line breaks kept, so offsets do not move);
  // outside literals, `//` and `/*` can only open a comment.
  let masked = "";
  let at = 0;
  const visit = (node: ts.Node): void => {
    if (LITERALS.has(node.kind)) {
      const start = node.getStart(sf);
      masked += text.slice(at, start) + text.slice(start, node.end).replace(/[^\r\n]/g, " ");
      at = node.end;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  masked += text.slice(at);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, masked);
  const out: { pos: number; text: string }[] = [];
  for (let k = scanner.scan(); k !== ts.SyntaxKind.EndOfFileToken; k = scanner.scan())
    if (k === ts.SyntaxKind.SingleLineCommentTrivia || k === ts.SyntaxKind.MultiLineCommentTrivia)
      out.push({ pos: scanner.getTokenStart(), text: text.slice(scanner.getTokenStart(), scanner.getTokenEnd()) });
  return out;
}

/** The citations in the comments of one file; the comment's opening `//` or `/*` is not part of the text searched. */
function citations(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  for (const c of comments(text))
    for (const m of c.text.slice(2).matchAll(CITATION)) {
      const pos = c.pos + 2 + m.index;
      out.push({ file, line: text.slice(0, pos).split("\n").length, text: m[0] });
    }
  return out;
}

function scanTree(root: string): { files: string[]; findings: Finding[] } {
  const files = productionFiles(root);
  return { files, findings: files.flatMap((f) => citations(f, readFileSync(join(root, f), "utf8"))) };
}

/** Both directions, with multiplicity: NEW = a citation no entry holds; STALE = an entry no citation matches. */
function compare(findings: readonly Finding[], list: readonly Entry[]): string[] {
  const out: string[] = [];
  const key = (file: string, text: string): string => `${file}\u0000${text}`;
  const open = new Map<string, number>();
  for (const e of list) open.set(key(e.file, e.text), (open.get(key(e.file, e.text)) ?? 0) + 1);
  for (const f of findings) {
    const k = key(f.file, f.text);
    const n = open.get(k) ?? 0;
    if (n > 0) open.set(k, n - 1);
    else
      out.push(
        `NEW ${f.file}:${f.line} ${f.text} — a line number in a comment is wrong after the next edit of that file: name the function, constant, type or section heading instead (and the file, where it helps)`,
      );
  }
  for (const e of list) {
    const k = key(e.file, e.text);
    const n = open.get(k) ?? 0;
    if (n > 0) {
      open.set(k, n - 1);
      out.push(`STALE ${e.file} ${e.text} — the citation is gone: delete the entry in the same commit`);
    }
  }
  return out;
}

const entry = (file: string, text: string): Entry => ({ file, text, note: REWRITE });
const cites = (src: string): string[] => citations("src/x.ts", src).map((f) => f.text);

describe("comment citations — what counts as a citation", () => {
  it("catches a bare file, a path, a test file, a Markdown file, the #L form and a declaration file", () => {
    expect(cites("// see x.ts:12")).toEqual(["x.ts:12"]);
    expect(cites("// see src/a/b.ts:12")).toEqual(["src/a/b.ts:12"]);
    expect(cites("// see b.test.ts:7")).toEqual(["b.test.ts:7"]);
    expect(cites("// see docs/x.md:40")).toEqual(["docs/x.md:40"]);
    expect(cites("// see x.ts#L12")).toEqual(["x.ts#L12"]);
    expect(cites("// verified against sdk.d.ts:1472")).toEqual(["sdk.d.ts:1472"]);
  });

  it("catches every ending of the list", () => {
    const endings = ["ts", "tsx", "js", "mjs", "cjs", "sh", "sql", "json", "md", "yml", "yaml", "py"];
    expect(cites(endings.map((e) => `// see a.${e}:3`).join("\n"))).toEqual(endings.map((e) => `a.${e}:3`));
  });

  it("two citations on one line are two findings, each with its line", () => {
    expect(citations("src/x.ts", "const a = 1;\n// a.ts:3 and b.ts:4\n")).toEqual([
      { file: "src/x.ts", line: 2, text: "a.ts:3" },
      { file: "src/x.ts", line: 2, text: "b.ts:4" },
    ]);
  });

  it("catches a citation in a doc block, in a trailing line comment, and right after the comment opener", () => {
    expect(cites("/**\n * Mirrors a.ts:10.\n */\nexport const x = 1;")).toEqual(["a.ts:10"]);
    expect(cites("const x = 1; // as in b.ts:20")).toEqual(["b.ts:20"]);
    expect(cites("//c.ts:30\n/*d.ts:40*/")).toEqual(["c.ts:30", "d.ts:40"]);
  });

  it("catches a block comment inside a template substitution, and a comment just before a literal", () => {
    expect(cites("const s = `a${/* see a.ts:3 */ x}b`;")).toEqual(["a.ts:3"]);
    expect(cites('const s = `a${x /* b.ts:5 */}c`;\nf(/* c.ts:6 */ "s", // d.ts:7\n  /e/);')).toEqual(["b.ts:5", "c.ts:6", "d.ts:7"]);
  });

  it("does not catch the same text in a string, a template or a regular expression literal", () => {
    expect(cites('const s = "// see a.ts:3";')).toEqual([]);
    expect(cites("const s = '/* see a.ts:3 */';")).toEqual([]);
    expect(cites("const s = `// see a.ts:3`;")).toEqual([]);
    expect(cites("const s = `${a} // see a.ts:3 ${b} /* c.ts:4 */`;")).toEqual([]);
    expect(cites("const r = /[//] see a.ts:3/;\nconst q = /[/*] b.ts:4/;")).toEqual([]);
  });

  it("does not catch look-alikes: a clock time, a host and port, a URL, a name without a number, a spaced number, a version, a bare file name", () => {
    expect(
      cites(
        [
          "// runs at 12:30",
          "// listens on localhost:3000",
          "// see http://127.0.0.1:8080/x.ts and https://example.com:443/a",
          "// defined in x.ts",
          "// x.ts: 12 items",
          "// needs pkg@1.2.3",
          "// read from foo.json",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("does not catch the stated limits: a citation inside a URL or after a slash, an ending outside the list or in upper case, a line written as :L12", () => {
    expect(
      cites(
        [
          "// see https://github.com/o/r/blob/main/src/a.ts#L12",
          "// see /abs/x.ts:3 and ~/y.ts:4",
          "// see a.mts:1, b.cts:2, c.jsx:3, D.TS:4",
          "// see x.ts:L12",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});

describe("comment citations — the files read", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "comment-citations-"));
    const files = [
      "src/a.ts",
      "src/a.test.ts",
      "src/types.d.ts",
      "src/test-utils/helper.ts",
      "src/m/__fixtures__/f.ts",
      "src/node_modules/p/index.ts",
      "src/m/b.ts",
      "src/m/test-utils/c.ts",
      "scripts/s.ts",
      "scripts/sub/t.ts",
      "scripts/run.sh",
    ];
    for (const f of files) {
      mkdirSync(dirname(join(root, f)), { recursive: true });
      writeFileSync(join(root, f), "// see z.ts:1\n");
    }
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("reads production .ts files under src/ and scripts/, and not tests, declaration files, src/test-utils/, fixtures or packages", () => {
    const read = ["scripts/s.ts", "scripts/sub/t.ts", "src/a.ts", "src/m/b.ts", "src/m/test-utils/c.ts"];
    expect(productionFiles(root)).toEqual(read);
    expect(scanTree(root).findings.map((f) => f.file)).toEqual(read);
  });
});

describe("comment citations — comparison with the list", () => {
  const finding = (file: string, text: string, line = 1): Finding => ({ file, line, text });

  it("equal: every citation has its entry and every entry its citation", () => {
    expect(compare([finding("src/a.ts", "x.ts:1")], [entry("src/a.ts", "x.ts:1")])).toEqual([]);
  });

  it("a citation the list does not hold is NEW, with its line and what to write instead", () => {
    expect(compare([finding("src/a.ts", "x.ts:1", 7)], [])).toEqual([
      "NEW src/a.ts:7 x.ts:1 — a line number in a comment is wrong after the next edit of that file: name the function, constant, type or section heading instead (and the file, where it helps)",
    ]);
  });

  it("the same citation text in two different files is two different entries", () => {
    expect(compare([finding("src/b.ts", "x.ts:1", 4)], [entry("src/a.ts", "x.ts:1")])).toEqual([
      expect.stringMatching(/^NEW src\/b\.ts:4 x\.ts:1 — /),
      expect.stringMatching(/^STALE src\/a\.ts x\.ts:1 — /),
    ]);
  });

  it("an entry that matches nothing is STALE", () => {
    expect(compare([], [entry("src/a.ts", "x.ts:1")])).toEqual([
      "STALE src/a.ts x.ts:1 — the citation is gone: delete the entry in the same commit",
    ]);
  });

  it("multiplicity counts: the same citation twice against one entry is one NEW; two entries against one citation is one STALE", () => {
    const one = [entry("src/a.ts", "x.ts:1")];
    expect(compare([finding("src/a.ts", "x.ts:1", 3), finding("src/a.ts", "x.ts:1", 9)], one)).toEqual([
      expect.stringMatching(/^NEW src\/a\.ts:9 x\.ts:1 — /),
    ]);
    expect(compare([finding("src/a.ts", "x.ts:1")], [...one, ...one])).toEqual([expect.stringMatching(/^STALE src\/a\.ts x\.ts:1 — /)]);
  });
});

describe("comment citations — the production tree equals the list", () => {
  let tree: ReturnType<typeof scanTree>;
  // The whole tree is read and parsed once per file run; generous for a loaded host.
  beforeAll(() => {
    tree = scanTree(REPO);
  }, 120_000);

  it("the scan reads the production files of src/ and scripts/, and only them", () => {
    expect(tree.files.length).toBeGreaterThan(500);
    expect(tree.files.some((f) => f.startsWith("scripts/"))).toBe(true);
    expect(tree.files.every((f) => f.startsWith("src/") || f.startsWith("scripts/"))).toBe(true);
    expect(tree.files.filter((f) => f.endsWith(".test.ts") || f.endsWith(".d.ts") || f.startsWith("src/test-utils/") || f.includes("/__fixtures__/"))).toEqual(
      [],
    );
  });

  it("the list is well-formed: sorted, each text a whole citation, a note each, existing production files", () => {
    const order = LEFTOVERS.map((e) => `${e.file}\u0000${e.text}`);
    expect(order).toEqual([...order].sort());
    const files = new Set(tree.files);
    for (const e of LEFTOVERS) {
      expect(files.has(e.file), e.file).toBe(true);
      expect([...e.text.matchAll(CITATION)].map((m) => m[0]), e.text).toEqual([e.text]);
      expect(e.note.trim().length, `${e.file} ${e.text} note`).toBeGreaterThan(10);
    }
  });

  it("every citation in a comment is on the list and every entry still matches a citation", () => {
    const diff = compare(tree.findings, LEFTOVERS);
    expect(diff, diff.join("\n")).toEqual([]);
  });

  it("against a list of the tree's own citations plus one invented entry, the tree reports exactly that entry STALE", () => {
    // Built from the scan, not from LEFTOVERS: this holds the day the list is empty.
    const invented = entry(tree.files[0], "no-such-file.ts:1");
    expect(compare(tree.findings, [...tree.findings.map((f) => entry(f.file, f.text)), invented])).toEqual([
      `STALE ${invented.file} ${invented.text} — the citation is gone: delete the entry in the same commit`,
    ]);
  });
});

