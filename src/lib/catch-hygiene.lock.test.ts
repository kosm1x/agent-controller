/**
 * Lock test: the set of catch blocks that swallow a failure without a trace
 * may not grow. A silent catch hides the failure completely (no log line, no
 * counter, no trace), so every new one must be a deliberate, reviewed
 * decision: handle the failure, or mark the block with the exemption tag.
 *
 * Three kinds are counted per production file under src/ (syntax only, the
 * TypeScript parser without a program or type checker):
 * - catchClause: `catch` whose block holds no statement (empty, comments only,
 *   or only a bare `;`). Any real statement, even `void 0;`, makes it not
 *   silent: a statement is a statement, and its review happens where it is
 *   written.
 * - promiseCatch: a `.catch(...)` call whose single argument is an arrow or
 *   function expression with an empty block body, wherever the call appears:
 *   it produces no value anyone could act on.
 * - promiseCatchDiscardedConstant: a `.catch(...)` whose single argument is
 *   an arrow or function expression with an expression body that is a
 *   constant (`""`, `null`, `undefined`, `false`, a number, `void 0`, or an
 *   array or object literal built only from constants), counted ONLY when the
 *   value of the whole call is thrown away: after unwrapping parentheses,
 *   `await`, `void`, a non-null `!`, `as`, `satisfies` and `<T>` assertions,
 *   the call is the expression of an expression statement. Used in any
 *   other way (assigned, returned, an argument, an
 *   operand, an element, a condition, a template part, an arrow's body) the
 *   constant is a fallback value and the caller decides what it means.
 *   - `x.catch(() => null);`, `void x.catch(() => null);` and
 *     `await x.catch(() => null);` as statements: counted.
 *   - `return x.catch(() => null)`: not counted (the caller gets the value).
 *   - an element of `Promise.all([...])` / `allSettled([...])`: not counted,
 *     the element is not discarded syntactically even when the array is.
 *   - `x.catch(() => null).then(...)`: not counted, the catch call is not
 *     the statement's expression.
 * Only a method named `catch` is a promise form. A `.catch` on something that
 * is not a promise cannot be told apart from a promise's without types; it
 * is counted all the same.
 *
 * Limits: silent shapes this detector does not see (review catches them):
 * - a catch block holding only an empty block, a labelled empty statement
 *   or `debugger;` — any statement at all, `void e;` included, makes a catch
 *   count as handled;
 * - bracket access, `obj["catch"](...)`;
 * - a named handler, `.catch(handler)`: what it does is not visible at the
 *   call site;
 * - a two-argument `.then(ok, onRejected)` with an empty rejection handler;
 * - a discarded constant fallback hidden behind a comma, `&&`/`||` or a
 *   conditional (`ok && x.catch(() => null);`).
 *
 * Exempt (not counted): a comment line that starts with the tag
 * `best-effort:` followed by a non-empty reason on the same line, e.g.
 *   // best-effort: a failed write must not fail the turn
 * The tag is lowercase and starts the comment line; `best-effort:` with no
 * reason is not exempt. Where it must sit:
 * - catchClause: inside the catch block's braces;
 * - both promise kinds: inside the `.catch(` parentheses — before the
 *   handler, or inside it — so one rule serves a block body and an
 *   expression body alike. A tag on the line above the statement does not
 *   count.
 *
 * The lock (catch-hygiene.lock.json) holds the per-file count of non-exempt
 * silent catches for each kind and must EQUAL the computed counts: a removal
 * lowers the lock, so the ground gained cannot be given back. Counts are per
 * file path: renaming or moving a file carries its count to the new path
 * (the old key goes, the new one comes with the same count), which is not a
 * raise.
 *
 * To print the computed lock (no file is written):
 *   CATCH_HYGIENE_PRINT=1 npx vitest run src/lib/catch-hygiene.lock.test.ts
 * With an absolute path as the value, the tree under <path>/src is scanned.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(SELF_DIR, "..", "..");
const LOCK_PATH = join(SELF_DIR, "catch-hygiene.lock.json");

const KINDS = ["catchClause", "promiseCatch", "promiseCatchDiscardedConstant"] as const;
type Kind = (typeof KINDS)[number];
type Counts = Record<Kind, number>;
type Lock = Record<Kind, Record<string, number>>;

const zero = (): Counts => ({ catchClause: 0, promiseCatch: 0, promiseCatchDiscardedConstant: 0 });

/** Production .ts files under `<root>/src`: no tests, declarations, test helpers or fixtures. */
function productionFiles(root: string): string[] {
  const src = join(root, "src");
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "__fixtures__") continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (abs !== join(src, "test-utils")) walk(abs);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts") &&
        !entry.name.endsWith(".d.ts")
      ) {
        out.push(abs);
      }
    }
  };
  walk(src);
  return out.sort();
}

const TAG = /^best-effort:\s+\S/;

/** True when a comment in text[start, end) has a line starting with the tag and a reason. */
function hasExemptTag(text: string, start: number, end: number): boolean {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    text,
    undefined,
    start,
    end - start,
  );
  for (let t = scanner.scan(); t !== ts.SyntaxKind.EndOfFileToken; t = scanner.scan()) {
    if (t !== ts.SyntaxKind.SingleLineCommentTrivia && t !== ts.SyntaxKind.MultiLineCommentTrivia) continue;
    const raw = scanner.getTokenText();
    const body = t === ts.SyntaxKind.SingleLineCommentTrivia ? raw.slice(2) : raw.slice(2, -2);
    if (body.split("\n").some((line) => TAG.test(line.replace(/^\s*\**\s*/, "")))) return true;
  }
  return false;
}

/** A bare `;` is punctuation, not a statement that does anything. */
const isEmptyBlock = (block: ts.Block): boolean =>
  block.statements.every((s) => s.kind === ts.SyntaxKind.EmptyStatement);

/** An expression built only from literals: the handler's value can be nothing but a fallback. */
function isConstant(node: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node))
    return isConstant(node.expression);
  switch (node.kind) {
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
    case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.BigIntLiteral:
    case ts.SyntaxKind.NullKeyword:
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
      return true;
  }
  if (ts.isIdentifier(node)) return node.text === "undefined";
  if (ts.isVoidExpression(node)) return isConstant(node.expression);
  if (ts.isPrefixUnaryExpression(node)) return isConstant(node.operand);
  if (ts.isArrayLiteralExpression(node)) return node.elements.every(isConstant);
  if (ts.isObjectLiteralExpression(node))
    return node.properties.every((p) => ts.isPropertyAssignment(p) && isConstant(p.initializer));
  return false;
}

interface Scan {
  /** Non-exempt silent catches by kind. */
  silent: Counts;
  /** Silent catches carrying the tag, by kind. */
  exempt: Counts;
  /** catch clauses, and `.catch` calls with a single inline function. */
  scanned: Counts;
}

/** Counts one file's catches; syntax only. */
function scanSource(fileName: string, text: string): Scan {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const r: Scan = { silent: zero(), exempt: zero(), scanned: zero() };
  const note = (kind: Kind, isSilent: boolean, start: number, end: number): void => {
    r.scanned[kind]++;
    if (!isSilent) return;
    if (hasExemptTag(text, start, end)) r.exempt[kind]++;
    else r.silent[kind]++;
  };
  // Calls whose value is thrown away; a statement is visited before its children.
  const discarded = new Set<ts.Node>();
  const visit = (node: ts.Node): void => {
    if (ts.isExpressionStatement(node)) {
      let e: ts.Expression = node.expression;
      while (
        ts.isParenthesizedExpression(e) ||
        ts.isAwaitExpression(e) ||
        ts.isVoidExpression(e) ||
        ts.isNonNullExpression(e) ||
        ts.isAsExpression(e) ||
        ts.isSatisfiesExpression(e) ||
        ts.isTypeAssertionExpression(e)
      )
        e = e.expression;
      discarded.add(e);
    }
    if (ts.isCatchClause(node)) {
      const b = node.block;
      note("catchClause", isEmptyBlock(b), b.getStart(sf) + 1, b.end - 1);
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "catch" &&
      node.arguments.length === 1
    ) {
      const fn = node.arguments[0];
      if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
        // Tag window for both kinds: inside the `.catch(` parentheses.
        if (ts.isBlock(fn.body)) note("promiseCatch", isEmptyBlock(fn.body), fn.pos, node.end - 1);
        else note("promiseCatchDiscardedConstant", isConstant(fn.body) && discarded.has(node), fn.pos, node.end - 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return r;
}

/** Computed lock for the tree under `<root>/src`, plus totals. */
function scanTree(root: string): { lock: Lock; totals: Scan; files: string[] } {
  const files = productionFiles(root);
  const lock: Lock = { catchClause: {}, promiseCatch: {}, promiseCatchDiscardedConstant: {} };
  const totals: Scan = { silent: zero(), exempt: zero(), scanned: zero() };
  for (const abs of files) {
    const rel = relative(root, abs).split(sep).join("/");
    const s = scanSource(rel, readFileSync(abs, "utf8"));
    for (const k of KINDS) {
      if (s.silent[k] > 0) lock[k][rel] = s.silent[k];
      totals.silent[k] += s.silent[k];
      totals.exempt[k] += s.exempt[k];
      totals.scanned[k] += s.scanned[k];
    }
  }
  for (const k of KINDS) lock[k] = Object.fromEntries(Object.entries(lock[k]).sort(([a], [b]) => (a < b ? -1 : 1)));
  return { lock, totals, files: files.map((f) => relative(root, f).split(sep).join("/")) };
}

/** One actionable line per file whose count differs from the lock. */
function lockDiff(computed: Lock, locked: Lock): string[] {
  const out: string[] = [];
  for (const k of KINDS) {
    const files = [...new Set([...Object.keys(computed[k] ?? {}), ...Object.keys(locked[k] ?? {})])].sort();
    for (const f of files) {
      const now = computed[k]?.[f] ?? 0;
      const was = locked[k]?.[f] ?? 0;
      if (now > was)
        out.push(
          `${k} ${f}: ${now} silent, lock ${was} — handle the failure (log, count or trace it), ` +
            "or mark the block `best-effort: <why losing this is acceptable>`; do not raise the lock " +
            "(a renamed or moved file carries its count to the new path)",
        );
      else if (now < was)
        out.push(
          `${k} ${f}: ${now} silent, lock ${was} — lower the lock: ` +
            (now === 0 ? `delete "${f}": ${was} from "${k}"` : `"${f}": ${now} in "${k}"`),
        );
    }
  }
  return out;
}

const printEnv = process.env.CATCH_HYGIENE_PRINT;
let repoScan: ReturnType<typeof scanTree> | undefined;
/** The repository tree, read and parsed once per run. */
const repo = () => (repoScan ??= scanTree(REPO));

describe("catch hygiene — silent catches may not grow", () => {
  it.runIf(Boolean(printEnv))("print mode: prints the computed lock and totals (writes nothing)", () => {
    const root = printEnv && isAbsolute(printEnv) ? printEnv : REPO;
    const { lock, totals, files } = root === REPO ? repo() : scanTree(root);
    console.log(JSON.stringify({ root, files: files.length, totals }, null, 2));
    console.log(JSON.stringify(lock, null, 2));
  });

  it("the scan reads the production tree, and only it", () => {
    const { files, totals } = repo();
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain("src/index.ts");
    expect(files.filter((f) => f.endsWith(".test.ts") || f.endsWith(".d.ts"))).toEqual([]);
    expect(files.filter((f) => f.startsWith("src/test-utils/") || f.includes("/__fixtures__/"))).toEqual([]);
    expect(totals.scanned.catchClause).toBeGreaterThan(1000);
  });

  it("the lock is well-formed: the three kinds, sorted keys, positive integer counts, existing files", () => {
    const lock = JSON.parse(readFileSync(LOCK_PATH, "utf8")) as Lock;
    expect(Object.keys(lock)).toEqual([...KINDS]);
    const files = new Set(repo().files);
    for (const k of KINDS) {
      const keys = Object.keys(lock[k]);
      expect(keys, k).toEqual([...keys].sort());
      expect(keys.filter((f) => !files.has(f)), `${k}: files that are not production sources`).toEqual([]);
      expect(Object.values(lock[k]).filter((n) => !Number.isInteger(n) || n < 1), k).toEqual([]);
    }
  });

  it("the per-file counts equal the lock", () => {
    const lock = JSON.parse(readFileSync(LOCK_PATH, "utf8")) as Lock;
    expect(lockDiff(repo().lock, lock)).toEqual([]);
  });
});

describe("catch hygiene — the detector", () => {
  const count = (src: string) => scanSource("fixture.ts", src);

  it("an empty catch block is silent", () => {
    expect(count("try { a(); } catch (e) {}").silent.catchClause).toBe(1);
  });

  it("a comment-only catch block is silent; so is a bare `;`", () => {
    expect(count("try { a(); } catch (e) {\n  // ignore\n}").silent.catchClause).toBe(1);
    expect(count("try { a(); } catch (e) { /* nothing */ }").silent.catchClause).toBe(1);
    expect(count("try { a(); } catch (e) { ; }").silent.catchClause).toBe(1);
  });

  it("a block with any statement is not silent, even `void 0;` or a bare return", () => {
    expect(count("try { a(); } catch (e) { void 0; }").silent.catchClause).toBe(0);
    expect(count("function f() { try { a(); } catch { return; } }").silent.catchClause).toBe(0);
    expect(count("try { a(); } catch (e) { log(e); }").scanned.catchClause).toBe(1);
  });

  it("a catch without a binding is scanned like any other", () => {
    expect(count("try { a(); } catch {}").silent.catchClause).toBe(1);
  });

  it("the tag with a reason exempts the block; it is counted as exempt, not silent", () => {
    const r = count("try { a(); } catch {\n  // best-effort: the cache refills on the next read\n}");
    expect(r.silent.catchClause).toBe(0);
    expect(r.exempt.catchClause).toBe(1);
    expect(count("try { a(); } catch { /* best-effort: probe only */ }").exempt.catchClause).toBe(1);
    expect(count("try { a(); } catch {\n  /*\n   * best-effort: multi-line reason\n   */\n}").exempt.catchClause).toBe(1);
  });

  it("the tag without a reason, in another case, or mid-sentence does not exempt", () => {
    for (const comment of [
      "// best-effort:",
      "// best-effort:   ",
      "/* best-effort: */",
      "/* best-effort */",
      "// Best-effort: capitalised",
      "// best effort: no hyphen",
      "// this is best-effort: not at the start",
    ]) {
      const r = count(`try { a(); } catch {\n  ${comment}\n}`);
      expect(r.silent.catchClause, comment).toBe(1);
      expect(r.exempt.catchClause, comment).toBe(0);
    }
  });

  it("the tag only counts inside the block: a tag in the try block does not exempt the catch", () => {
    expect(count("try {\n  // best-effort: wrong place\n  a();\n} catch {}").silent.catchClause).toBe(1);
  });

  it("a nested try inside a catch: the inner silent catch counts, the outer does not", () => {
    const r = count("try { a(); } catch (e) {\n  try { b(); } catch {}\n}");
    expect(r.scanned.catchClause).toBe(2);
    expect(r.silent.catchClause).toBe(1);
  });

  it("promise form: an inline handler with an empty block body is silent", () => {
    expect(count("p.catch(() => {});").silent.promiseCatch).toBe(1);
    expect(count("p.catch((e) => {\n  /* ignore */\n});").silent.promiseCatch).toBe(1);
    expect(count("p.catch(function () {});").silent.promiseCatch).toBe(1);
    expect(count("p?.catch(() => {});").silent.promiseCatch).toBe(1);
    expect(count("p.catch((e) => { log(e); });").silent.promiseCatch).toBe(0);
    expect(count("p.catch(() => {\n  // best-effort: fire and forget\n});").exempt.promiseCatch).toBe(1);
  });

  it("promise form: an empty-body handler counts wherever the call appears, its value is nothing", () => {
    expect(count("const t = p.catch(() => {});").silent.promiseCatch).toBe(1);
    expect(count("async function f() { return await p.catch(() => {}); }").silent.promiseCatch).toBe(1);
  });

  it("promise form: a discarded constant fallback is silent (its own kind)", () => {
    for (const body of ['""', "null", "undefined", "false", "0", "void 0", "[]", "({})", "({ version: undefined })"]) {
      const r = count(`p.catch(() => ${body});`);
      expect(r.silent.promiseCatchDiscardedConstant, body).toBe(1);
      expect(r.silent.promiseCatch, body).toBe(0);
    }
    expect(count("p.catch((e) => log(e));").silent.promiseCatchDiscardedConstant).toBe(0);
    expect(count("p.catch(() => fallback);").silent.promiseCatchDiscardedConstant).toBe(0);
    expect(count("p.catch(\n  // best-effort: a missing file reads as empty\n  () => \"\",\n);").exempt.promiseCatchDiscardedConstant).toBe(1);
  });

  it("promise form: a constant fallback counts only when the whole call's value is thrown away", () => {
    const n = (src: string) => count(`async function f() {\n${src}\n}`).silent.promiseCatchDiscardedConstant;
    // discarded: the call, after parentheses / await / void / type wrappers, is a statement's expression
    for (const src of [
      "x.catch(() => null);",
      "void x.catch(() => null);",
      "await x.catch(() => null);",
      "(await (x.catch(() => null)));",
    ])
      expect(n(src), src).toBe(1);
    // used: the caller gets the fallback value and decides
    for (const src of [
      'const t = await res.text().catch(() => "");',
      "return x.catch(() => null);",
      "use(await x.catch(() => null));",
      "await Promise.all([x.catch(() => null), y.catch(() => null)]);",
      "await Promise.allSettled([x.catch(() => null)]);",
      "x.catch(() => null).then(go);",
      "const g = () => x.catch(() => null);",
      "if (await x.catch(() => false)) go();",
      'log(`${await x.catch(() => "")}`);',
      "const o = { v: await x.catch(() => null) };",
      "t = (await x.catch(() => 0)) + 1;",
    ])
      expect(n(src), src).toBe(0);
  });

  it("promise form: a named handler, or more than one argument, is not counted", () => {
    const r = count("p.catch(handler); p.catch(() => {}, extra);");
    expect(r.scanned.promiseCatch + r.scanned.promiseCatchDiscardedConstant).toBe(0);
  });

  it("promise form: only a method named `catch` is scanned — `.then` / `.forEach` handlers are not", () => {
    const r = count("p.then(() => {}); a.forEach(() => {}); p.then(() => null);");
    expect(r.scanned.promiseCatch + r.scanned.promiseCatchDiscardedConstant).toBe(0);
    expect(r.silent.promiseCatch + r.silent.promiseCatchDiscardedConstant).toBe(0);
  });

  it("promise form: a type-level wrapper at statement level still discards the value", () => {
    for (const src of [
      "x.catch(() => null)!;",
      "x.catch(() => null) as unknown;",
      "x.catch(() => null) satisfies unknown;",
      "<unknown>x.catch(() => null);",
      "await (x.catch(() => null) as Promise<null>);",
    ])
      expect(count(`async function f() {\n${src}\n}`).silent.promiseCatchDiscardedConstant, src).toBe(1);
  });

  it("promise form: the tag sits inside the `.catch(` parentheses, before or inside the handler, for both kinds", () => {
    const before = (handler: string) => `p.catch(\n  // best-effort: fire and forget\n  ${handler},\n);`;
    expect(count(before("() => {}")).exempt.promiseCatch).toBe(1);
    expect(count(before("() => null")).exempt.promiseCatchDiscardedConstant).toBe(1);
    expect(count("p.catch(() => {\n  // best-effort: fire and forget\n});").exempt.promiseCatch).toBe(1);
    expect(count("p.catch(() =>\n  // best-effort: fire and forget\n  null,\n);").exempt.promiseCatchDiscardedConstant).toBe(1);
    // a tag above the statement is outside the window
    expect(count("// best-effort: fire and forget\np.catch(() => {});").silent.promiseCatch).toBe(1);
    expect(count("// best-effort: fire and forget\np.catch(() => null);").silent.promiseCatchDiscardedConstant).toBe(1);
  });
});

describe("catch hygiene — the failure message", () => {
  const lock = (catchClause: Record<string, number>): Lock => ({ catchClause, promiseCatch: {}, promiseCatchDiscardedConstant: {} });

  it("names every differing file: up says handle or tag, down and gone give the replacement", () => {
    expect(lockDiff(lock({ "src/a.ts": 3, "src/b.ts": 1, "src/new.ts": 1 }), lock({ "src/a.ts": 2, "src/b.ts": 2, "src/gone.ts": 4 }))).toEqual([
      "catchClause src/a.ts: 3 silent, lock 2 — handle the failure (log, count or trace it), or mark the block `best-effort: <why losing this is acceptable>`; do not raise the lock (a renamed or moved file carries its count to the new path)",
      'catchClause src/b.ts: 1 silent, lock 2 — lower the lock: "src/b.ts": 1 in "catchClause"',
      'catchClause src/gone.ts: 0 silent, lock 4 — lower the lock: delete "src/gone.ts": 4 from "catchClause"',
      "catchClause src/new.ts: 1 silent, lock 0 — handle the failure (log, count or trace it), or mark the block `best-effort: <why losing this is acceptable>`; do not raise the lock (a renamed or moved file carries its count to the new path)",
    ]);
  });
});
