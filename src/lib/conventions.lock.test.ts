/**
 * Lock test: five house rules over the production files under src/, read
 * with the TypeScript parser (syntax only: no program, no type checker;
 * nothing of the scanned code is imported or run). The first four rules have
 * a home where the thing they guard belongs, and every exception that exists
 * on purpose is named in conventions.lock.json with its reason.
 *
 * Files scanned: every `.ts` file under src/, except `*.test.ts`, `*.d.ts`,
 * everything under src/test-utils/, any `__fixtures__` folder and any
 * `node_modules` folder.
 *
 * - rawCron: a call of node-cron's `schedule` or `createTask` (both create a
 *   task) outside src/lib/cron.ts. Every schedule goes through
 *   `scheduleCron(id, expr, fn, opts)`, which names the job and records a
 *   missed or failed run; a raw call fails silently. Forms: the default import
 *   or the named `nodeCron` export under any name (`cron.schedule`), a named
 *   import under any name (`import { schedule as s }`), a namespace import
 *   (`ns.schedule`, `ns.default.schedule`, `ns.nodeCron.schedule`), a dynamic
 *   import (`(await import("node-cron")).schedule`, a const bound to it or
 *   destructured from it), and a const alias of any of these (`const c =
 *   cron`, `const { schedule } = cron`, `const s = cron.schedule`).
 *   `cron.validate` and every other member are free.
 * - secondDatabaseHandle: `new X(...)` or `X(...)` where X is the default
 *   export of better-sqlite3 under any local name (default import,
 *   `{ default as X }`, `ns.default`, a dynamic import), outside
 *   src/db/index.ts. The service has one handle (`getDatabase()`), opened
 *   with the service's pragmas; another one does not share them.
 * - columnChangeOutsideMigrations: the text of an `ALTER TABLE <t> ADD …`,
 *   `DROP …` or `RENAME <column> TO …` statement (SQLite makes the COLUMN
 *   keyword optional; `RENAME TO` renames the table and is free) in a string
 *   or template literal anywhere but inside the initializer of the
 *   `SCHEMA_MIGRATIONS` list in src/db/index.ts. A template's parts are joined
 *   (a substitution keeps its expression text as `${…}`) and any whitespace,
 *   line breaks included, separates words. A column change outside the
 *   numbered list runs on every boot, is not counted in the schema version,
 *   and gets no pre-migration snapshot from the deploy.
 *   A named function (a declaration, or a const bound to an arrow or function
 *   expression) whose literal holds a column change with a substituted table
 *   or column is a helper: besides its statement, every call of it outside
 *   the list is a finding of its own, by its call text, in its own file and
 *   in any file that imports it by name from a relative path.
 * - containerCallOutsideSeam: a child-process start (`spawn`, `spawnSync`,
 *   `exec`, `execSync`, `execFile`, `execFileSync` of child_process, under any
 *   import name, through a namespace or a `promisify(...)` alias) whose
 *   command is a container runtime binary (docker, a docker-* plugin binary,
 *   podman, nerdctl; the base name of a path counts), outside
 *   src/runners/container.ts and src/runners/sandbox-backend.ts (where
 *   `spawnSandbox` lives). Runners reach containers only through the seam,
 *   which picks the backend and applies its guards. The command is the first
 *   word of the first argument: a string, a template's head, a const bound to
 *   a string in the same file, `X[0]` of a const array literal, or the first
 *   element of a spread array. Taking the container module's `spawnContainer`
 *   outside the seam is a finding too: an import of it (static, renamed, or
 *   destructured from a dynamic import) and a member read of it on the
 *   module's namespace. `buildDockerRunArgs` is not: it only builds an
 *   argument list, and starting the runtime with that list is itself a
 *   child-process start that the rule reports.
 * - plainTextToolResult: a plain-text return of a tool handler in a file
 *   under src/tools/. The house form for a tool failure is JSON with `error`
 *   as its first key, and plain text is meant for results; the list also
 *   holds failures kept as plain text for now. The rule does not judge
 *   whether a text is a failure: it reports each plain-text return it can
 *   read, results included, and the reason of each entry says why that text
 *   is plain. A new plain-text success therefore needs an entry with its
 *   reason too.
 *   A handler is an `execute` method, or an `execute:` property whose value
 *   is a function, a call with a function among its arguments
 *   (`wrap(async () => …)`), or the name of a function or variable declared
 *   at the top of the same file whose value is a function or such a call;
 *   the nearest enclosing object literal with a string `name` names its
 *   tool, and an `execute` without one is not a handler. Its
 *   returns are the `return` statements of the handler itself (not of a
 *   function nested in it) and a concise arrow body; `a ? b : c`, `a || b`
 *   and `a ?? b` count as their branches. A branch is plain text when it is a
 *   string or template literal, a `+` chain that starts with one, an array
 *   literal that starts with one and is joined with `.join(…)`, or a name
 *   bound by `const` to one of these, in the handler or at the top of the
 *   file (a name the handler binds as a `let`, a `var` or a parameter is not
 *   followed to a `const` elsewhere). The entry text is the tool name and the
 *   first 60 characters of the normalised text, each substitution shown as
 *   `${…}`; two returns of one tool with the same first 60 characters share a
 *   key and are counted by multiplicity.
 *   Not seen: text that exists only at run time (a call's result, a `let`,
 *   `var` or parameter, a property read, a `+` chain that starts with a
 *   run-time value, an array built before it is joined); returns inside a
 *   callback the handler passes on; handlers not written in the forms
 *   above; tools served by an external tool server;
 *   throws; JSON results — the rule does not check the shape of a JSON
 *   result.
 *
 * Limits (review catches these):
 * - for the first four rules, names are matched by text, without scopes: a
 *   local that shadows an imported name is still counted (the error leans
 *   towards reporting);
 * - a module object passed around as a value (a parameter, a property, the
 *   argument of `.then`) is not followed, nor an alias made by assignment
 *   rather than a variable declaration;
 * - a library export handed on by a local module (`export { x } from` the
 *   library, or the container module's spawn function re-exported outside
 *   the seam) is not followed to its callers, nor is a factory in another
 *   module that opens the handle, nor the platform's built-in SQLite module;
 * - a column-change statement assembled with `+` or at run time, or kept
 *   in a `.sql` file that is read and executed; a helper
 *   that is a method, a default export, re-exported through another module
 *   or called through a namespace or an alias;
 * - a command assembled at run time or passed through a wrapper of another
 *   module, and a shell command whose first word is not the runtime;
 * - shell commands written by a model reach the runtime through the shell
 *   tool, which has its own gate; they are outside this lock.
 *
 * The allow-list holds, per rule, one entry per exception: the file, the
 * normalised text of the call or statement, or for a tool's plain-text
 * return the tool name and the first 60 characters of the text (never a
 * line number) and a one-line reason for the exception. The comparison runs
 * in both directions, with multiplicity, and has no switch that turns it off:
 * a finding the list does not hold fails (NEW), and an entry that matches
 * nothing any more fails (STALE: the exception was removed, delete the entry
 * in the same commit).
 * Normalised text: whitespace collapsed to one space, no space after an
 * opening or before a closing bracket, no trailing comma. A call's text is
 * the whole call with a function-valued argument shown as `…`; for a
 * container call, the callee and the command arguments only (the first, and
 * the second when it is an array literal: options and callbacks are not part
 * of what the exception is); a statement's text runs from ALTER to the next
 * `;` or the end of the literal.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(SELF_DIR, "..", "..");
const LOCK_PATH = join(SELF_DIR, "conventions.lock.json");

const RULES = ["rawCron", "secondDatabaseHandle", "columnChangeOutsideMigrations", "containerCallOutsideSeam", "plainTextToolResult"] as const;
type Rule = (typeof RULES)[number];
interface Finding {
  file: string;
  line: number;
  text: string;
}
interface Entry {
  file: string;
  text: string;
  reason: string;
}
type Findings = Record<Rule, Finding[]>;
type Lock = Record<Rule, Entry[]>;

const CRON_HOME = "src/lib/cron.ts";
const DB_HOME = "src/db/index.ts";
const SEAM_HOME = ["src/runners/container.ts", "src/runners/sandbox-backend.ts"];
/** The container module, as a specifier resolves to it (no extension). */
const CONTAINER_MODULE = "src/runners/container";
const MIGRATION_LIST = "SCHEMA_MIGRATIONS";
/** The scheduling library's exports that create a task. */
const CRON_STARTS = new Set(["schedule", "createTask"]);
const CHILD_FUNCS = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"]);
const RUNTIME = /^(?:docker(?:-[a-z]+)?|podman|nerdctl)$/;
/** Groups: 1 = table, 2 = column. */
const COLUMN_CHANGE =
  /\bALTER\s+TABLE\s+(\$\{[^}]*\}|"[^"]*"|\S+)\s+(?:ADD|DROP|RENAME(?!\s+TO\b))\b(?:\s+COLUMN\b)?\s*(\$\{[^}]*\}|"[^"]*"|[^\s;]*)[^;]*/gi;
const TOOLS_DIR = "src/tools/";
/** Characters of a plain-text return's normalised text that key its entry. */
const HEAD_CHARS = 60;
const SUBSTITUTION = "${…}";

const PURPOSE: Record<Rule, string> = {
  rawCron: "a raw schedule has no job name and its missed or failed runs are not recorded",
  secondDatabaseHandle: "a second handle does not share the service handle's pragmas",
  columnChangeOutsideMigrations: "a column change outside the numbered list runs on every boot and is not counted in the schema version",
  containerCallOutsideSeam: "the seam picks the sandbox backend and applies its guards",
  plainTextToolResult: "a tool failure is returned as JSON, not as plain text",
};

const HINT: Record<Rule, string> = {
  rawCron: "schedule through scheduleCron(id, expr, fn, opts) from src/lib/cron.ts",
  secondDatabaseHandle: "use getDatabase() from src/db/index.ts",
  columnChangeOutsideMigrations: "append a numbered entry to SCHEMA_MIGRATIONS in src/db/index.ts",
  containerCallOutsideSeam: "start containers through spawnSandbox() in src/runners/sandbox-backend.ts",
  plainTextToolResult: "return JSON.stringify({ error: <words> }) with error as the first key",
};

const empty = (): Findings => ({
  rawCron: [],
  secondDatabaseHandle: [],
  columnChangeOutsideMigrations: [],
  containerCallOutsideSeam: [],
  plainTextToolResult: [],
});

/** Production .ts files under `<root>/src`, as paths relative to `root` with `/`. */
function productionFiles(root: string): string[] {
  const src = join(root, "src");
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "__fixtures__") continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (abs !== join(src, "test-utils")) walk(abs);
      } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")) {
        out.push(relative(root, abs).split(sep).join("/"));
      }
    }
  };
  walk(src);
  return out.sort();
}

const normalise = (s: string): string =>
  s
    .replace(/\s+/g, " ")
    .replace(/,\s*([)\]}])/g, "$1")
    .replace(/([([{]) /g, "$1")
    .replace(/ ([)\]}])/g, "$1")
    .trim();

/** A relative specifier as the module path it names, without extension; undefined for a package. */
const resolveSpec = (from: string, spec: string): string | undefined =>
  spec.startsWith(".") ? posix.join(posix.dirname(from), spec).replace(/\.(?:js|ts)$/, "") : undefined;

function unwrap(e: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAwaitExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e)
  )
    e = e.expression;
  return e;
}

/** `o.name` or `o["name"]`. */
function member(e: ts.Expression): { obj: ts.Expression; name: string } | undefined {
  if (ts.isPropertyAccessExpression(e)) return { obj: e.expression, name: e.name.text };
  if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression))
    return { obj: e.expression, name: e.argumentExpression.text };
  return undefined;
}

/** The local names one file binds to a module's default export, its namespace and its named exports. */
class ModuleRefs {
  readonly defaults = new Set<string>();
  readonly namespaces = new Set<string>();
  /** local name -> export name */
  readonly named = new Map<string, string>();
  /** Where a file takes a named export: an import specifier, or a name destructured from the module. */
  readonly sites: Array<{ node: ts.Node; text: string; exported: string }> = [];
  constructor(
    readonly sf: ts.SourceFile,
    readonly accepts: (spec: string) => boolean,
    /** Named exports that are the same object as the default export (node-cron's `nodeCron`). */
    readonly defaultNames: readonly string[] = [],
  ) {}

  bind(local: string, exported: string): void {
    if (exported === "default" || this.defaultNames.includes(exported)) this.defaults.add(local);
    else this.named.set(local, exported);
  }

  private site(node: ts.Node, text: string, local: string, exported: string): void {
    this.sites.push({ node, text: normalise(text), exported });
    this.bind(local, exported);
  }

  /** The specifier of `import("…")` when it names this module. */
  importSpec(e: ts.Expression): string | undefined {
    if (!ts.isCallExpression(e) || e.expression.kind !== ts.SyntaxKind.ImportKeyword) return undefined;
    const arg = e.arguments[0];
    return arg !== undefined && ts.isStringLiteralLike(arg) && this.accepts(arg.text) ? arg.text : undefined;
  }

  /** Records what an import declaration or a variable declaration binds. */
  record(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && this.accepts(node.moduleSpecifier.text)) {
      const clause = node.importClause;
      if (!clause || clause.isTypeOnly) return;
      if (clause.name) this.defaults.add(clause.name.text);
      const nb = clause.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) this.namespaces.add(nb.name.text);
      else if (nb)
        for (const el of nb.elements)
          if (!el.isTypeOnly)
            this.site(el, `import { ${el.getText(this.sf)} } from "${node.moduleSpecifier.text}"`, el.name.text, (el.propertyName ?? el.name).text);
    } else if (ts.isVariableDeclaration(node) && node.initializer) {
      // `x = await import(m)`, `x = ns`, `x = cron`, `x = (await import(m)).default`; a pattern binds members.
      const init = unwrap(node.initializer);
      const asNamespace = this.isNamespace(init);
      if (asNamespace || this.isDefault(init)) {
        if (ts.isIdentifier(node.name)) (asNamespace ? this.namespaces : this.defaults).add(node.name.text);
        else if (ts.isObjectBindingPattern(node.name))
          for (const el of node.name.elements) {
            const key = el.propertyName ?? el.name;
            if (!ts.isIdentifier(el.name) || !(ts.isIdentifier(key) || ts.isStringLiteral(key))) continue;
            this.site(el, `const { ${el.getText(this.sf)} } = ${node.initializer.getText(this.sf)}`, el.name.text, key.text);
          }
      } else if (ts.isIdentifier(node.name)) {
        // `const s = cron.schedule`
        const exported = this.exportOf(init);
        if (exported !== undefined) this.bind(node.name.text, exported);
      }
    }
  }

  isNamespace(e: ts.Expression): boolean {
    const u = unwrap(e);
    return (ts.isIdentifier(u) && this.namespaces.has(u.text)) || this.importSpec(u) !== undefined;
  }

  isDefault(e: ts.Expression): boolean {
    const u = unwrap(e);
    if (ts.isIdentifier(u)) return this.defaults.has(u.text);
    const m = member(u);
    return m !== undefined && (m.name === "default" || this.defaultNames.includes(m.name)) && this.isNamespace(m.obj);
  }

  /** The export an expression refers to, if it is one of this module's. */
  exportOf(e: ts.Expression): string | undefined {
    const u = unwrap(e);
    if (ts.isIdentifier(u)) return this.named.get(u.text);
    const m = member(u);
    return m && (this.isDefault(m.obj) || this.isNamespace(m.obj)) ? m.name : undefined;
  }
}

/** The base name of the first word of a child-process command argument, when it can be read. */
function commandWord(arg: ts.Expression | undefined, consts: Map<string, ts.Expression>): string | undefined {
  if (arg === undefined) return undefined;
  const arrayOf = (x: ts.Expression): ts.ArrayLiteralExpression | undefined => {
    const v = ts.isIdentifier(x) ? consts.get(x.text) : x;
    return v && ts.isArrayLiteralExpression(v) ? v : undefined;
  };
  let e = unwrap(arg);
  if (ts.isSpreadElement(e)) e = arrayOf(unwrap(e.expression))?.elements[0] ?? e;
  else if (ts.isElementAccessExpression(e) && ts.isNumericLiteral(e.argumentExpression) && Number(e.argumentExpression.text) === 0)
    e = arrayOf(unwrap(e.expression))?.elements[0] ?? e;
  if (ts.isIdentifier(e)) e = consts.get(e.text) ?? e;
  const text = ts.isStringLiteralLike(e) ? e.text : ts.isTemplateExpression(e) ? e.head.text : undefined;
  const first = text?.trim().split(/\s+/)[0];
  return first?.slice(first.lastIndexOf("/") + 1);
}

/** A string or template literal's text, a substitution shown as `${expression}`. */
function literalText(sf: ts.SourceFile, node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node))
    return node.head.text + node.templateSpans.map((s) => `\${${s.expression.getText(sf)}}${s.literal.text}`).join("");
  return undefined;
}

function callText(sf: ts.SourceFile, call: ts.CallExpression | ts.NewExpression, args: readonly ts.Expression[]): string {
  const shown = args.map((a) => (ts.isArrowFunction(a) || ts.isFunctionExpression(a) ? "…" : a.getText(sf)));
  return normalise(`${ts.isNewExpression(call) ? "new " : ""}${call.expression.getText(sf)}(${shown.join(", ")})`);
}

/** A named function: `function f() {}`, or `const f = () => …` / `const f = function () {}`. */
function functionName(node: ts.Node): string | undefined {
  if (ts.isFunctionDeclaration(node)) return node.name?.text;
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
    const init = unwrap(node.initializer);
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return node.name.text;
  }
  return undefined;
}

const isExported = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

const isFunctionLike = (n: ts.Node): boolean =>
  ts.isFunctionDeclaration(n) ||
  ts.isFunctionExpression(n) ||
  ts.isArrowFunction(n) ||
  ts.isMethodDeclaration(n) ||
  ts.isGetAccessor(n) ||
  ts.isSetAccessor(n) ||
  ts.isConstructorDeclaration(n);

/** The text of a property's or method's name, when it is an identifier or a string. */
const nameOf = (n: ts.PropertyAssignment | ts.MethodDeclaration): string | undefined =>
  ts.isIdentifier(n.name) || ts.isStringLiteral(n.name) ? n.name.text : undefined;

/** The tool an object literal defines: its `name: "<string>"` property. */
function toolNameOf(o: ts.ObjectLiteralExpression): string | undefined {
  for (const p of o.properties)
    if (ts.isPropertyAssignment(p) && nameOf(p) === "name" && ts.isStringLiteralLike(p.initializer)) return p.initializer.text;
  return undefined;
}

function boundNames(n: ts.BindingName, out: string[]): string[] {
  if (ts.isIdentifier(n)) out.push(n.text);
  else for (const el of n.elements) if (!ts.isOmittedExpression(el)) boundNames(el.name, out);
  return out;
}

/**
 * Names bound in a scope: name -> the initializer of `const name = …`, or null
 * for any other binding of the name (`let`, `var`, a parameter, a pattern).
 * The file scope is its top-level variable statements; a handler's scope is
 * its body without the functions nested in it.
 */
function bindingsOf(scope: ts.SourceFile | ts.FunctionLikeDeclaration): Map<string, ts.Expression | null> {
  const out = new Map<string, ts.Expression | null>();
  const bind = (name: string, init: ts.Expression | null): void => {
    if (!out.has(name)) out.set(name, init);
  };
  const list = (l: ts.VariableDeclarationList): void => {
    const isConst = (l.flags & ts.NodeFlags.Const) !== 0;
    for (const d of l.declarations)
      for (const name of boundNames(d.name, [])) bind(name, isConst && ts.isIdentifier(d.name) && d.initializer ? d.initializer : null);
  };
  if (ts.isSourceFile(scope)) {
    for (const s of scope.statements) if (ts.isVariableStatement(s)) list(s.declarationList);
    return out;
  }
  const visit = (n: ts.Node): void => {
    if (n !== scope && isFunctionLike(n)) return;
    if (ts.isVariableDeclarationList(n)) list(n);
    if (ts.isParameter(n)) for (const name of boundNames(n.name, [])) bind(name, null);
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return out;
}

/** The text of a plain-text expression, a substitution shown as `${…}`; undefined for anything else. */
function plainText(e: ts.Expression, resolve: (name: string) => ts.Expression | null, depth = 0): string | undefined {
  if (depth > 8) return undefined;
  const u = unwrap(e);
  if (ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u)) return u.text;
  if (ts.isTemplateExpression(u)) return u.head.text + u.templateSpans.map((s) => SUBSTITUTION + s.literal.text).join("");
  if (ts.isBinaryExpression(u) && u.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = plainText(u.left, resolve, depth + 1);
    return left === undefined ? undefined : left + (plainText(u.right, resolve, depth + 1) ?? SUBSTITUTION);
  }
  if (ts.isCallExpression(u) && ts.isPropertyAccessExpression(u.expression) && u.expression.name.text === "join") {
    const arr = unwrap(u.expression.expression);
    if (!ts.isArrayLiteralExpression(arr) || arr.elements.length === 0 || plainText(arr.elements[0], resolve, depth + 1) === undefined)
      return undefined;
    const sep = u.arguments[0] === undefined ? "," : (plainText(u.arguments[0], resolve, depth + 1) ?? SUBSTITUTION);
    return arr.elements.map((x) => plainText(x, resolve, depth + 1) ?? SUBSTITUTION).join(sep);
  }
  if (ts.isIdentifier(u)) {
    const init = resolve(u.text);
    return init ? plainText(init, resolve, depth + 1) : undefined;
  }
  return undefined;
}

/** A returned expression's branches: `a ? b : c`, `a || b` and `a ?? b` count as their parts. */
function branches(e: ts.Expression, out: ts.Expression[]): ts.Expression[] {
  const u = unwrap(e);
  if (ts.isConditionalExpression(u)) {
    branches(u.whenTrue, out);
    branches(u.whenFalse, out);
  } else if (
    ts.isBinaryExpression(u) &&
    (u.operatorToken.kind === ts.SyntaxKind.BarBarToken || u.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    branches(u.left, out);
    branches(u.right, out);
  } else out.push(u);
  return out;
}

/** The function an `execute:` value names: a function, a call wrapping one, or a top-level function of this file. */
function handlerOf(sf: ts.SourceFile, init: ts.Expression): ts.FunctionLikeDeclaration | undefined {
  const u = unwrap(init);
  if (ts.isFunctionExpression(u) || ts.isArrowFunction(u)) return u;
  if (ts.isCallExpression(u)) {
    for (const a of u.arguments) {
      const fn = handlerOf(sf, a);
      if (fn) return fn;
    }
    return undefined;
  }
  if (ts.isIdentifier(u))
    for (const s of sf.statements) {
      if (ts.isFunctionDeclaration(s) && s.name?.text === u.text && s.body) return s;
      if (ts.isVariableStatement(s))
        for (const d of s.declarationList.declarations)
          if (ts.isIdentifier(d.name) && d.name.text === u.text && d.initializer) return handlerOf(sf, d.initializer);
    }
  return undefined;
}

/** The plain-text returns of the tool handlers in one file, keyed `<tool> <first HEAD_CHARS characters>`. */
function plainTextReturns(sf: ts.SourceFile, file: string): Finding[] {
  const fileScope = bindingsOf(sf);
  const out: Finding[] = [];
  const read = (fn: ts.FunctionLikeDeclaration, tool: string): void => {
    const local = bindingsOf(fn);
    const resolve = (name: string): ts.Expression | null => (local.has(name) ? local.get(name)! : (fileScope.get(name) ?? null));
    const add = (e: ts.Expression): void => {
      for (const b of branches(e, [])) {
        const text = plainText(b, resolve);
        if (text === undefined) continue;
        const head = Array.from(normalise(text)).slice(0, HEAD_CHARS).join("");
        out.push({ file, line: sf.getLineAndCharacterOfPosition(b.getStart(sf)).line + 1, text: normalise(`${tool} ${head}`) });
      }
    };
    if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) return add(fn.body);
    const walk = (n: ts.Node): void => {
      if (n !== fn && isFunctionLike(n)) return;
      if (ts.isReturnStatement(n) && n.expression) add(n.expression);
      ts.forEachChild(n, walk);
    };
    walk(fn);
  };
  const tools: string[] = [];
  const visit = (n: ts.Node): void => {
    const name = ts.isObjectLiteralExpression(n) ? toolNameOf(n) : undefined;
    if (name !== undefined) tools.push(name);
    const tool = tools.at(-1);
    if (tool !== undefined) {
      if (ts.isMethodDeclaration(n) && nameOf(n) === "execute" && n.body) read(n, tool);
      else if (ts.isPropertyAssignment(n) && nameOf(n) === "execute") {
        const fn = handlerOf(sf, n.initializer);
        if (fn) read(fn, tool);
      }
    }
    ts.forEachChild(n, visit);
    if (name !== undefined) tools.pop();
  };
  visit(sf);
  return out;
}

/** A call, in another file, of a function this file imports by name from a relative module. */
interface ImportedCall extends Finding {
  module: string;
  exported: string;
}

interface Scan {
  findings: Findings;
  /** Exported names of this file's column-change helpers. */
  exportedHelpers: Set<string>;
  importedCalls: ImportedCall[];
}

/**
 * One file's findings; `file` is its path relative to the repository root. A
 * column-change helper is a named function whose body holds a column-change
 * statement with a substituted table or column: every call of it in this file
 * is a finding of its own (outside the migration list), and so is every call
 * in another file that imports it by name (resolved in scanTree).
 */
function scanSource(file: string, text: string): Scan {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const cron = new ModuleRefs(sf, (s) => s === "node-cron", ["nodeCron"]);
  const sqlite = new ModuleRefs(sf, (s) => s === "better-sqlite3");
  const child = new ModuleRefs(sf, (s) => s === "child_process" || s === "node:child_process");
  const container = new ModuleRefs(sf, (s) => resolveSpec(file, s) === CONTAINER_MODULE);
  const consts = new Map<string, ts.Expression>();
  /** local name -> its exported name */
  const exportedAs = new Map<string, string>();
  /** local name -> the relative module and export it was imported as */
  const imported = new Map<string, { module: string; exported: string }>();
  let list: { start: number; end: number } | undefined;

  const collect = (node: ts.Node): void => {
    for (const m of [cron, sqlite, child, container]) m.record(node);
    if (ts.isVariableDeclarationList(node) && node.flags & ts.NodeFlags.Const)
      for (const d of node.declarations) if (ts.isIdentifier(d.name) && d.initializer) consts.set(d.name.text, unwrap(d.initializer));
    if (ts.isFunctionDeclaration(node) && node.name && isExported(node)) exportedAs.set(node.name.text, node.name.text);
    if (ts.isVariableStatement(node) && isExported(node))
      for (const d of node.declarationList.declarations) if (ts.isIdentifier(d.name)) exportedAs.set(d.name.text, d.name.text);
    if (ts.isExportDeclaration(node) && !node.moduleSpecifier && node.exportClause && ts.isNamedExports(node.exportClause))
      for (const el of node.exportClause.elements) exportedAs.set((el.propertyName ?? el.name).text, el.name.text);
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const module = resolveSpec(file, node.moduleSpecifier.text);
      const nb = node.importClause?.namedBindings;
      if (module !== undefined && nb && ts.isNamedImports(nb))
        for (const el of nb.elements) imported.set(el.name.text, { module, exported: (el.propertyName ?? el.name).text });
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (file === DB_HOME && node.name.text === MIGRATION_LIST) list = { start: node.initializer.getStart(sf), end: node.initializer.end };
      // `const run = promisify(execFile)` starts the same child as execFile.
      const init = unwrap(node.initializer);
      if (ts.isCallExpression(init) && init.arguments.length > 0) {
        const callee = ts.isIdentifier(init.expression) ? init.expression.text : member(init.expression)?.name;
        const f = callee === "promisify" ? child.exportOf(init.arguments[0]) : undefined;
        if (f !== undefined && CHILD_FUNCS.has(f)) child.named.set(node.name.text, f);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);

  const out = empty();
  const lineOf = (node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const add = (rule: Rule, node: ts.Node, t: string): void => {
    out[rule].push({ file, line: lineOf(node), text: t });
  };
  const inList = (node: ts.Node): boolean => list !== undefined && node.getStart(sf) >= list.start && node.end <= list.end;
  const isSub = (part: string): boolean => part.startsWith("${");
  const helpers = new Set<string>();
  const calls: Array<{ name: string; node: ts.CallExpression }> = [];
  const importedCalls: ImportedCall[] = [];
  const functions: string[] = [];

  if (!SEAM_HOME.includes(file))
    for (const s of container.sites) if (s.exported === "spawnContainer") add("containerCallOutsideSeam", s.node, s.text);

  const find = (node: ts.Node): void => {
    const fn = functionName(node);
    if (fn !== undefined) functions.push(fn);
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const args: readonly ts.Expression[] = node.arguments ?? [];
      if (ts.isCallExpression(node) && file !== CRON_HOME && CRON_STARTS.has(cron.exportOf(node.expression) ?? ""))
        add("rawCron", node, callText(sf, node, args));
      if (file !== DB_HOME && sqlite.isDefault(node.expression)) add("secondDatabaseHandle", node, callText(sf, node, args));
      const f = ts.isCallExpression(node) ? child.exportOf(node.expression) : undefined;
      if (f !== undefined && CHILD_FUNCS.has(f) && !SEAM_HOME.includes(file) && RUNTIME.test(commandWord(args[0], consts) ?? "")) {
        const commandArgs = args.length > 1 && ts.isArrayLiteralExpression(args[1]) ? args.slice(0, 2) : args.slice(0, 1);
        add("containerCallOutsideSeam", node, callText(sf, node, commandArgs));
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && !inList(node)) {
        calls.push({ name: node.expression.text, node });
        const from = imported.get(node.expression.text);
        if (from) importedCalls.push({ file, line: lineOf(node), text: callText(sf, node, args), ...from });
      }
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const m = member(node);
      if (m?.name === "spawnContainer" && !SEAM_HOME.includes(file) && (container.isNamespace(m.obj) || container.isDefault(m.obj)))
        add("containerCallOutsideSeam", node, normalise(node.getText(sf)));
    }
    const lit = literalText(sf, node);
    if (lit !== undefined && !inList(node))
      for (const m of lit.matchAll(COLUMN_CHANGE)) {
        add("columnChangeOutsideMigrations", node, normalise(m[0]));
        if (functions.length > 0 && (isSub(m[1]) || isSub(m[2]))) helpers.add(functions[functions.length - 1]);
      }
    ts.forEachChild(node, find);
    if (fn !== undefined) functions.pop();
  };
  find(sf);
  for (const c of calls) if (helpers.has(c.name)) add("columnChangeOutsideMigrations", c.node, callText(sf, c.node, c.node.arguments));
  if (file.startsWith(TOOLS_DIR)) out.plainTextToolResult.push(...plainTextReturns(sf, file));
  const exportedHelpers = new Set([...helpers].flatMap((h) => (exportedAs.has(h) ? [exportedAs.get(h)!] : [])));
  return { findings: out, exportedHelpers, importedCalls };
}

function scanTree(root: string): { files: string[]; findings: Findings } {
  const files = productionFiles(root);
  const findings = empty();
  const helpersOf = new Map<string, Set<string>>();
  const importedCalls: ImportedCall[] = [];
  for (const file of files) {
    const s = scanSource(file, readFileSync(join(root, file), "utf8"));
    for (const r of RULES) findings[r].push(...s.findings[r]);
    helpersOf.set(file.replace(/\.ts$/, ""), s.exportedHelpers);
    importedCalls.push(...s.importedCalls);
  }
  // A call of another file's exported column-change helper, imported by name.
  for (const c of importedCalls)
    if (helpersOf.get(c.module)?.has(c.exported) || helpersOf.get(`${c.module}/index`)?.has(c.exported))
      findings.columnChangeOutsideMigrations.push({ file: c.file, line: c.line, text: c.text });
  return { files, findings };
}

/** Both directions, with multiplicity: NEW = a finding no entry holds; STALE = an entry no finding matches. */
function compareLock(findings: Findings, lock: Lock): string[] {
  const out: string[] = [];
  const key = (file: string, text: string): string => `${file}\u0000${text}`;
  for (const rule of RULES) {
    const entries = lock[rule] ?? [];
    const open = new Map<string, number>();
    for (const e of entries) open.set(key(e.file, e.text), (open.get(key(e.file, e.text)) ?? 0) + 1);
    for (const f of findings[rule]) {
      const k = key(f.file, f.text);
      const n = open.get(k) ?? 0;
      if (n > 0) open.set(k, n - 1);
      else
        out.push(
          `NEW ${rule} ${f.file}:${f.line} ${f.text} — ${PURPOSE[rule]}: ${HINT[rule]}; an exception on purpose needs an entry in src/lib/conventions.lock.json with its reason`,
        );
    }
    for (const e of entries) {
      const k = key(e.file, e.text);
      const n = open.get(k) ?? 0;
      if (n > 0) {
        open.set(k, n - 1);
        out.push(`STALE ${rule} ${e.file} ${e.text} — the exception matches nothing any more: delete the entry in the same commit`);
      }
    }
  }
  return out;
}

const texts = (f: Findings, rule: Rule): string[] => f[rule].map((x) => x.text);
const emptyLock = (): Lock => ({
  rawCron: [],
  secondDatabaseHandle: [],
  columnChangeOutsideMigrations: [],
  containerCallOutsideSeam: [],
  plainTextToolResult: [],
});
const scan = (src: string, file = "src/x.ts"): Findings => scanSource(file, src).findings;

const fixtureRoots: string[] = [];
afterAll(() => {
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
});

/** A throwaway tree: keys are paths relative to its root (all under src/). */
function fixture(files: Record<string, string>): ReturnType<typeof scanTree> {
  const root = mkdtempSync(join(tmpdir(), "conventions-lock-"));
  fixtureRoots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return scanTree(root);
}

describe("conventions lock — which files are scanned (temporary tree)", () => {
  it("production files only: tests, declarations, test utilities and fixtures are not scanned", () => {
    const bad = 'import cron from "node-cron";\ncron.schedule("* * * * *", () => {});\n';
    const t = fixture({
      "src/a.ts": bad,
      "src/a.test.ts": bad,
      "src/g.d.ts": bad,
      "src/test-utils/u.ts": bad,
      "src/x/__fixtures__/f.ts": bad,
      "src/x/node_modules/m.ts": bad,
    });
    expect(t.files).toEqual(["src/a.ts"]);
    expect(t.findings.rawCron.map((f) => `${f.file}:${f.line}`)).toEqual(["src/a.ts:2"]);
  });
});

describe("conventions lock — rawCron", () => {
  it("a direct call of the library's schedule outside the wrapper is a finding", () => {
    const f = scan('import cron from "node-cron";\nexport const j = cron.schedule("0 * * * *", () => run(), { name: "x" });\n');
    expect(texts(f, "rawCron")).toEqual(['cron.schedule("0 * * * *", …, {name: "x"})']);
  });

  it("the wrapper's own call in src/lib/cron.ts is not", () => {
    const src = 'import cron from "node-cron";\nexport const j = cron.schedule("0 * * * *", fn);\n';
    expect(texts(scan(src, "src/lib/cron.ts"), "rawCron")).toEqual([]);
    expect(texts(scan(src, "src/lib/cron-next.ts"), "rawCron")).toHaveLength(1);
  });

  it("a renamed default import and a renamed named import are caught", () => {
    const f = scan(
      'import nc from "node-cron";\nimport { schedule as every } from "node-cron";\nnc.schedule("* * * * *", fn);\nevery("* * * * *", fn);\nnc["schedule"]("* * * * *", fn);\n',
    );
    expect(texts(f, "rawCron")).toEqual(['nc.schedule("* * * * *", fn)', 'every("* * * * *", fn)', 'nc["schedule"]("* * * * *", fn)']);
  });

  it("a namespace import is caught, directly and through its default", () => {
    const f = scan('import * as ns from "node-cron";\nns.schedule("* * * * *", fn);\nns.default.schedule("* * * * *", fn);\n');
    expect(texts(f, "rawCron")).toEqual(['ns.schedule("* * * * *", fn)', 'ns.default.schedule("* * * * *", fn)']);
  });

  it("a dynamic import is caught: inline, bound to a const, destructured", () => {
    const f = scan(
      [
        "async function go() {",
        '  (await import("node-cron")).schedule("* * * * *", fn);',
        '  const m = await import("node-cron");',
        '  m.default.schedule("* * * * *", fn);',
        '  const { schedule: s } = await import("node-cron");',
        '  s("* * * * *", fn);',
        '  const c = (await import("node-cron")).default;',
        '  c.schedule("* * * * *", fn);',
        "}",
      ].join("\n"),
    );
    expect(texts(f, "rawCron")).toEqual([
      '(await import("node-cron")).schedule("* * * * *", fn)',
      'm.default.schedule("* * * * *", fn)',
      's("* * * * *", fn)',
      'c.schedule("* * * * *", fn)',
    ]);
  });

  it("createTask creates a task too: as a member and as a named import", () => {
    const f = scan('import cron, { createTask as mk } from "node-cron";\ncron.createTask("* * * * *", fn);\nmk("* * * * *", fn);\n');
    expect(texts(f, "rawCron")).toEqual(['cron.createTask("* * * * *", fn)', 'mk("* * * * *", fn)']);
  });

  it("the named nodeCron export is the default: imported by name, and on a namespace", () => {
    const f = scan(
      'import { nodeCron as nc } from "node-cron";\nimport * as ns from "node-cron";\nnc.schedule("* * * * *", fn);\nns.nodeCron.createTask("* * * * *", fn);\n',
    );
    expect(texts(f, "rawCron")).toEqual(['nc.schedule("* * * * *", fn)', 'ns.nodeCron.createTask("* * * * *", fn)']);
  });

  it("a const alias is caught: of the default, a destructured member, a bound member", () => {
    const f = scan(
      [
        'import cron from "node-cron";',
        "const c = cron;",
        "const { schedule, createTask: mk } = cron;",
        "const s = cron.schedule;",
        'c.schedule("* * * * *", fn);',
        'schedule("* * * * *", fn);',
        'mk("* * * * *", fn);',
        's("* * * * *", fn);',
      ].join("\n"),
    );
    expect(texts(f, "rawCron")).toEqual(['c.schedule("* * * * *", fn)', 'schedule("* * * * *", fn)', 'mk("* * * * *", fn)', 's("* * * * *", fn)']);
  });

  it("look-alikes of another module are not findings: a dynamic import of it, an alias of another object", () => {
    const f = scan(
      [
        'import cron from "node-cron";',
        "async function go() {",
        '  (await import("./other.js")).schedule("* * * * *", fn);',
        '  const { schedule } = await import("./other.js");',
        '  schedule("* * * * *", fn);',
        "  const a = agenda;",
        "  const { createTask } = queue;",
        '  a.schedule("in 5 minutes", "job");',
        '  createTask("job");',
        '  return cron.validate("* * * * *");',
        "}",
      ].join("\n"),
    );
    expect(f.rawCron).toEqual([]);
  });

  it("look-alikes are not findings: validate, a comment, a string, schedule of another object or module", () => {
    const f = scan(
      [
        'import cron from "node-cron";',
        'import { schedule } from "./my-scheduler.js";',
        'if (!cron.validate("* * * * *")) throw new Error("bad");',
        '// cron.schedule("* * * * *", fn) is what the wrapper replaces',
        'const doc = "cron.schedule(expr, fn)";',
        'agenda.schedule("in 5 minutes", "job");',
        'schedule("* * * * *", fn);',
        "export { doc };",
      ].join("\n"),
    );
    expect(f.rawCron).toEqual([]);
  });
});

describe("conventions lock — secondDatabaseHandle", () => {
  it("a new handle of the driver outside the database module is a finding", () => {
    const f = scan('import Database from "better-sqlite3";\nexport const db = new Database("x.db", { readonly: true });\n');
    expect(texts(f, "secondDatabaseHandle")).toEqual(['new Database("x.db", {readonly: true})']);
  });

  it("the database module's own handles are not", () => {
    const src = 'import BetterSqlite3 from "better-sqlite3";\nexport const db = new BetterSqlite3(p);\n';
    expect(texts(scan(src, "src/db/index.ts"), "secondDatabaseHandle")).toEqual([]);
    expect(texts(scan(src, "src/db/index2.ts"), "secondDatabaseHandle")).toHaveLength(1);
  });

  it("a different local name is caught: default import, `{ default as X }`, a namespace's default, a dynamic import, a call without new", () => {
    const f = scan(
      [
        'import Sqlite from "better-sqlite3";',
        'import { default as Drv } from "better-sqlite3";',
        'import * as ns from "better-sqlite3";',
        "new Sqlite(p);",
        "new Drv(p);",
        "new ns.default(p);",
        "Sqlite(p);",
        "async function go() {",
        '  const { default: D } = await import("better-sqlite3");',
        "  return new D(p);",
        "}",
      ].join("\n"),
    );
    expect(texts(f, "secondDatabaseHandle")).toEqual(["new Sqlite(p)", "new Drv(p)", "new ns.default(p)", "Sqlite(p)", "new D(p)"]);
  });

  it("a const alias of the driver is caught; the default of another module's dynamic import is not", () => {
    const f = scan(
      [
        'import Sqlite from "better-sqlite3";',
        "const Alias = Sqlite;",
        "new Alias(p);",
        "async function go() {",
        '  const other = new (await import("./x.js")).default(p);',
        '  const { default: Y } = await import("./y.js");',
        "  return [other, new Y(p)];",
        "}",
      ].join("\n"),
    );
    expect(texts(f, "secondDatabaseHandle")).toEqual(["new Alias(p)"]);
  });

  it("look-alikes are not findings: a type use, a comment, a string, another module's class, another constructor", () => {
    const f = scan(
      [
        'import type Database from "better-sqlite3";',
        'import Store from "./store.js";',
        "export function f(db: Database.Database) {",
        "  // new Database(path) would open a second handle",
        '  const doc = "new Database(path)";',
        "  const s = new Store(db.name);",
        "  const m = new Map<string, number>();",
        "  return [doc, s, m, holder.Database(p)];",
        "}",
      ].join("\n"),
    );
    expect(f.secondDatabaseHandle).toEqual([]);
  });
});

describe("conventions lock — columnChangeOutsideMigrations", () => {
  const indexWith = (body: string) =>
    [
      "export function initDatabase() {",
      '  db.exec("ALTER TABLE tasks ADD COLUMN outside_list TEXT");',
      "  const SCHEMA_MIGRATIONS = [",
      `    { version: 1, up: (db) => db.exec(${body}) },`,
      "  ];",
      '  db.exec("ALTER TABLE tasks ADD COLUMN after_list TEXT");',
      "  return SCHEMA_MIGRATIONS;",
      "}",
    ].join("\n");

  it("a column change in a string outside the migration list is a finding, in any file", () => {
    expect(texts(scan('db.exec("ALTER TABLE tasks ADD COLUMN extra TEXT");'), "columnChangeOutsideMigrations")).toEqual([
      "ALTER TABLE tasks ADD COLUMN extra TEXT",
    ]);
  });

  it("inside the SCHEMA_MIGRATIONS initializer of src/db/index.ts it is not; the same text outside the list, or in a list of that name elsewhere, is", () => {
    const src = indexWith("`ALTER TABLE tasks ADD COLUMN in_list TEXT`");
    expect(texts(scan(src, "src/db/index.ts"), "columnChangeOutsideMigrations")).toEqual([
      "ALTER TABLE tasks ADD COLUMN outside_list TEXT",
      "ALTER TABLE tasks ADD COLUMN after_list TEXT",
    ]);
    expect(texts(scan(src, "src/db/other-schema.ts"), "columnChangeOutsideMigrations")).toEqual([
      "ALTER TABLE tasks ADD COLUMN outside_list TEXT",
      "ALTER TABLE tasks ADD COLUMN in_list TEXT",
      "ALTER TABLE tasks ADD COLUMN after_list TEXT",
    ]);
  });

  it("a statement split over template parts and lines is caught, every statement of a literal on its own", () => {
    const f = scan(
      [
        "db.exec(`",
        "  ALTER TABLE ${table}",
        "    ADD COLUMN ${column} ${typeDecl};",
        "  ALTER",
        "  TABLE runs DROP COLUMN legacy;",
        "`);",
      ].join("\n"),
    );
    expect(texts(f, "columnChangeOutsideMigrations")).toEqual([
      "ALTER TABLE ${table} ADD COLUMN ${column} ${typeDecl}",
      "ALTER TABLE runs DROP COLUMN legacy",
    ]);
  });

  it("the COLUMN keyword is optional in SQLite: ADD, DROP and RENAME of a column without it are caught", () => {
    const f = scan('db.exec("ALTER TABLE t ADD c TEXT; ALTER TABLE t DROP c; ALTER TABLE t RENAME COLUMN a TO b; ALTER TABLE t RENAME a TO b");');
    expect(texts(f, "columnChangeOutsideMigrations")).toEqual([
      "ALTER TABLE t ADD c TEXT",
      "ALTER TABLE t DROP c",
      "ALTER TABLE t RENAME COLUMN a TO b",
      "ALTER TABLE t RENAME a TO b",
    ]);
  });

  it("look-alikes are not findings: a CREATE TABLE with a column list, a table rename", () => {
    const f = scan(
      [
        "db.exec(`CREATE TABLE IF NOT EXISTS t (",
        "  id INTEGER PRIMARY KEY,",
        "  added_column TEXT",
        ")`);",
        'db.exec("ALTER TABLE t RENAME TO t_old");',
        'db.exec("ALTER TABLE t\\n  RENAME\\n  TO t_old");',
      ].join("\n"),
    );
    expect(f.columnChangeOutsideMigrations).toEqual([]);
  });

  const helperFile = [
    "function addCol(table: string, column: string, t: string): void {",
    "  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${t}`);",
    "}",
    'addCol("runs", "a", "TEXT");',
    'addCol(\n  "runs",\n  "b",\n  "REAL",\n);',
  ].join("\n");

  it("a helper (a substituted table or column): its statement and each of its calls are findings", () => {
    expect(texts(scan(helperFile), "columnChangeOutsideMigrations")).toEqual([
      "ALTER TABLE ${table} ADD COLUMN ${column} ${t}",
      'addCol("runs", "a", "TEXT")',
      'addCol("runs", "b", "REAL")',
    ]);
    const f = scan(
      [
        "const dropCol = (c: string) => db.exec(`ALTER TABLE runs DROP COLUMN ${c}`);",
        "const addFlag = function (table: string) {",
        "  return db.exec(`ALTER TABLE ${table} ADD COLUMN flag INTEGER`);",
        "};",
        'dropCol("legacy");',
        'addFlag("runs");',
      ].join("\n"),
    );
    expect(texts(f, "columnChangeOutsideMigrations")).toEqual([
      "ALTER TABLE runs DROP COLUMN ${c}",
      "ALTER TABLE ${table} ADD COLUMN flag INTEGER",
      'dropCol("legacy")',
      'addFlag("runs")',
    ]);
  });

  it("a third call of a helper is NEW against a list holding the statement and two calls", () => {
    const file = "src/x.ts";
    const lock: Lock = {
      ...emptyLock(),
      columnChangeOutsideMigrations: texts(scan(helperFile, file), "columnChangeOutsideMigrations").map((text) => ({ file, text, reason: "frozen" })),
    };
    expect(compareLock(scan(helperFile, file), lock)).toEqual([]);
    expect(compareLock(scan(`${helperFile}\naddCol("runs", "c", "TEXT");`, file), lock)).toEqual([
      expect.stringMatching(/^NEW columnChangeOutsideMigrations src\/x\.ts:10 addCol\("runs", "c", "TEXT"\) — /),
    ]);
  });

  it("a helper's call inside the migration list of src/db/index.ts is not a finding; outside it is", () => {
    const src = [
      "function addCol(table: string, column: string): void {",
      "  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);",
      "}",
      "const SCHEMA_MIGRATIONS = [{ version: 1, up: () => addCol(\"runs\", \"in_list\") }];",
      'addCol("runs", "outside");',
    ].join("\n");
    expect(texts(scan(src, "src/db/index.ts"), "columnChangeOutsideMigrations")).toEqual([
      "ALTER TABLE ${table} ADD COLUMN ${column} TEXT",
      'addCol("runs", "outside")',
    ]);
  });

  it("an exported helper called from another file that imports it by name is a finding there", () => {
    const t = fixture({
      "src/db/helpers.ts": [
        "export function addCol(table: string, column: string): void {",
        "  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);",
        "}",
        "function dropCol(column: string): void {",
        "  db.exec(`ALTER TABLE runs DROP COLUMN ${column}`);",
        "}",
        "export { dropCol as removeCol };",
        "export function addFlag(): void {",
        '  db.exec("ALTER TABLE runs ADD COLUMN flag INTEGER");',
        "}",
      ].join("\n"),
      "src/feature/a.ts": [
        'import { addCol as ac, removeCol, addFlag } from "../db/helpers.js";',
        'ac("runs", "extra");',
        'removeCol("legacy");',
        "addFlag();",
      ].join("\n"),
      "src/feature/b.ts": 'import { addCol } from "./helpers.js";\naddCol("runs", "other");\n',
      "src/feature/helpers.ts": "export function addCol(a: string, b: string): void {}\n",
    });
    expect(t.findings.columnChangeOutsideMigrations.map((f) => `${f.file} ${f.text}`)).toEqual([
      "src/db/helpers.ts ALTER TABLE ${table} ADD COLUMN ${column} TEXT",
      "src/db/helpers.ts ALTER TABLE runs DROP COLUMN ${column}",
      "src/db/helpers.ts ALTER TABLE runs ADD COLUMN flag INTEGER",
      'src/feature/a.ts ac("runs", "extra")',
      'src/feature/a.ts removeCol("legacy")',
    ]);
  });

  it("a function that holds a fixed statement, or substitutes only the type, is not a helper: its calls are not findings", () => {
    const f = scan(
      [
        "function ensureFlag(): void {",
        '  db.exec("ALTER TABLE runs ADD COLUMN flag INTEGER");',
        "}",
        "function addNote(type: string): void {",
        "  db.exec(`ALTER TABLE runs ADD COLUMN note ${type}`);",
        "}",
        "ensureFlag();",
        "ensureFlag();",
        'addNote("TEXT");',
      ].join("\n"),
    );
    expect(texts(f, "columnChangeOutsideMigrations")).toEqual(["ALTER TABLE runs ADD COLUMN flag INTEGER", "ALTER TABLE runs ADD COLUMN note ${type}"]);
  });

  it("a comment is not a finding: only literal text is SQL", () => {
    const f = scan("// ALTER TABLE t ADD COLUMN c TEXT is what the list replaces\n/* ALTER TABLE t DROP COLUMN c */\nexport {};\n");
    expect(f.columnChangeOutsideMigrations).toEqual([]);
  });
});

describe("conventions lock — containerCallOutsideSeam", () => {
  it("starting the runtime's binary outside the seam is a finding; options and callbacks are not part of the text", () => {
    const f = scan(
      'import { spawn } from "node:child_process";\nconst p = spawn("docker", ["run", "--rm", image], { stdio: "pipe" });\n',
    );
    expect(texts(f, "containerCallOutsideSeam")).toEqual(['spawn("docker", ["run", "--rm", image])']);
  });

  it("the container module and the sandbox backend module are the seam", () => {
    const src = 'import { execFileSync } from "child_process";\nexecFileSync("docker", ["image", "inspect", i]);\n';
    for (const home of ["src/runners/container.ts", "src/runners/sandbox-backend.ts"])
      expect(texts(scan(src, home), "containerCallOutsideSeam"), home).toEqual([]);
    expect(texts(scan(src, "src/runners/opensandbox-backend.ts"), "containerCallOutsideSeam")).toHaveLength(1);
  });

  it("the command as the first word of a command string, a path's base name, a template head, a const", () => {
    const f = scan(
      [
        'import { exec, execSync, execFile } from "node:child_process";',
        'const BIN = "/usr/bin/podman";',
        'execSync("docker ps -a --format x");',
        "exec(`  docker-compose up ${svc}`, cb);",
        "execFile(BIN, args, cb);",
      ].join("\n"),
    );
    expect(texts(f, "containerCallOutsideSeam")).toEqual(['execSync("docker ps -a --format x")', "exec(` docker-compose up ${svc}`)", "execFile(BIN)"]);
  });

  it("the command as an array's first element: `X[0]` of a const array, a spread array", () => {
    const f = scan(
      [
        'import { spawnSync } from "node:child_process";',
        'const argv = ["docker", "ps"] as const;',
        "spawnSync(argv[0], argv.slice(1));",
        'spawnSync(...["nerdctl", "ps"]);',
        "spawnSync(...argv);",
        "spawnSync(argv[1], []);",
      ].join("\n"),
    );
    expect(texts(f, "containerCallOutsideSeam")).toEqual(["spawnSync(argv[0])", 'spawnSync(...["nerdctl", "ps"])', "spawnSync(...argv)"]);
  });

  it("a renamed import, a namespace import, a dynamic import and a promisified alias are caught", () => {
    const f = scan(
      [
        'import { execFile as ef } from "node:child_process";',
        'import * as cp from "child_process";',
        'import { promisify } from "node:util";',
        "const run = promisify(ef);",
        "const run2 = util.promisify(cp.execFile);",
        'ef("docker", ["ps"], cb);',
        'cp.spawn("docker", ["ps"]);',
        'await run("docker", ["ps"], { timeout: 5 });',
        'await run2("docker", ["ps"]);',
        'const { execSync: x } = await import("node:child_process");',
        'x("docker info");',
      ].join("\n"),
    );
    expect(texts(f, "containerCallOutsideSeam")).toEqual([
      'ef("docker", ["ps"])',
      'cp.spawn("docker", ["ps"])',
      'run("docker", ["ps"])',
      'run2("docker", ["ps"])',
      'x("docker info")',
    ]);
  });

  it("taking spawnContainer from the container module outside the seam is a finding: import, rename, dynamic import, namespace", () => {
    const f = scan(
      [
        'import { spawnContainer, generateContainerName } from "./container.js";',
        'import { spawnContainer as sc } from "../runners/container";',
        'import * as c from "./container.js";',
        "async function go() {",
        '  const { spawnContainer: late } = await import("./container.js");',
        "  return [c.spawnContainer, late, sc];",
        "}",
      ].join("\n"),
      "src/runners/heavy-runner.ts",
    );
    expect(texts(f, "containerCallOutsideSeam")).toEqual([
      'import {spawnContainer} from "./container.js"',
      'import {spawnContainer as sc} from "../runners/container"',
      'const {spawnContainer: late} = await import("./container.js")',
      "c.spawnContainer",
    ]);
  });

  it("spawnContainer in the seam, another export of the container module, or another module's spawnContainer is not", () => {
    const src = 'import { spawnContainer, imageExistsLocally } from "./container.js";\nexport { spawnContainer, imageExistsLocally };\n';
    expect(texts(scan(src, "src/runners/sandbox-backend.ts"), "containerCallOutsideSeam")).toEqual([]);
    expect(texts(scan(src, "src/runners/nanoclaw-runner.ts"), "containerCallOutsideSeam")).toHaveLength(1);
    const others = [
      'import { imageExistsLocally, buildDockerRunArgs } from "./container.js";',
      'import { spawnContainer } from "./other-container.js";',
      'import type { spawnContainer as T } from "./container.js";',
      'import { spawnContainer as up } from "../container.js";',
      "export { imageExistsLocally, buildDockerRunArgs, up };",
    ].join("\n");
    expect(texts(scan(others, "src/runners/heavy-runner.ts"), "containerCallOutsideSeam")).toEqual([]);
  });

  it("a child-process name destructured from another module's dynamic import is not a finding", () => {
    const f = scan(
      [
        "async function go() {",
        '  const { execSync } = await import("./other.js");',
        '  execSync("docker ps");',
        '  const ns = await import("./shell.js");',
        '  ns.spawn("docker", ["ps"]);',
        "}",
      ].join("\n"),
    );
    expect(f.containerCallOutsideSeam).toEqual([]);
  });

  it("look-alikes are not findings: a comment, a string, exec of a regex or a database, another binary", () => {
    const f = scan(
      [
        'import { spawn, execSync } from "node:child_process";',
        '// spawn("docker", ["run"]) is what the seam owns',
        'const doc = "execSync(\\"docker ps\\")";',
        'const m = /docker/.exec("docker ps");',
        'db.exec("docker ps");',
        'spawn("git", ["status"]);',
        'execSync("dockerd-check --help");',
        'execSync("echo docker");',
        "export { doc, m };",
      ].join("\n"),
    );
    expect(f.containerCallOutsideSeam).toEqual([]);
  });
});

describe("conventions lock — plainTextToolResult", () => {
  const TOOL_FILE = "src/tools/builtin/x.ts";
  const plain = (src: string, file = TOOL_FILE): string[] => texts(scan(src, file), "plainTextToolResult");
  const tool = (name: string, body: string): string => `export const t = { name: "${name}", async execute(args: { q: string }) {\n${body}\n} };`;

  it("a plain-text return of a tool handler is a finding, keyed by the tool name and the text", () => {
    const f = scan(tool("t_one", '  if (!args.q) return "Error: q is required";\n  return ("done" as string);'), TOOL_FILE).plainTextToolResult;
    expect(f).toEqual([
      { file: TOOL_FILE, line: 2, text: "t_one Error: q is required" },
      { file: TOOL_FILE, line: 3, text: "t_one done" },
    ]);
  });

  it("each handler form: an execute method, an execute property holding a function, a call wrapping one, a top-level function or const", () => {
    const src = [
      'function runD() { return "d"; }',
      'const runE = async () => { return "e"; };',
      "export const tools = [",
      '  { name: "a", async execute() { return "a"; } },',
      '  { name: "b", execute: async function () { return "b"; } },',
      '  { name: "c", execute: wrap("c", async () => { return "c"; }) },',
      '  { name: "d", execute: runD },',
      '  { name: "e", execute: runE },',
      '  { name: "f", execute: async () => "f" },',
      "];",
    ].join("\n");
    expect(plain(src)).toEqual(["a a", "b b", "c c", "d d", "e e", "f f"]);
  });

  it("an execute without a string name around it is not a handler: a class method, an object without a name", () => {
    const src = [
      'class Registry { async execute() { return "class"; } }',
      'export const noName = { execute() { return "no name"; } };',
      'export const computed = { name: toolName, execute() { return "computed name"; } };',
      'export const named = { name: "n", execute() { return "named"; } };',
    ].join("\n");
    expect(plain(src)).toEqual(["n named"]);
  });

  it("text that exists only at run time is not a finding: JSON, a call, a let, a var, a parameter, a property read", () => {
    const body = [
      '  if (args.q === "j") return JSON.stringify({ error: "q is j" });',
      '  if (args.q === "c") return format(args.q);',
      '  let s = "let text";',
      '  var v = "var text";',
      "  if (args.q === \"l\") return s;",
      "  if (args.q === \"v\") return v;",
      "  if (args.q === \"p\") return args.q;",
      "  return result.text;",
    ].join("\n");
    expect(plain(tool("t", body))).toEqual([]);
  });

  it("a conditional, `||` and `??` count as their branches", () => {
    const body = [
      '  if (args.q === "a") return ok ? "done" : JSON.stringify({ error: "failed" });',
      '  if (args.q === "b") return out || "nothing returned";',
      '  if (args.q === "c") return out ?? "no output";',
      '  return n > 0 ? (n > 1 ? "many" : "one") : "none";',
    ].join("\n");
    expect(plain(tool("t", body))).toEqual(["t done", "t nothing returned", "t no output", "t many", "t one", "t none"]);
  });

  it("a template and a `+` chain that starts with text are findings, each substitution shown as ${…}", () => {
    const body = [
      "  if (args.q === \"a\") return `Found ${n} rows in ${args.q}.`;",
      '  if (args.q === "b") return "Found " + n + " rows";',
      '  return n + " rows";',
    ].join("\n");
    expect(plain(tool("t", body))).toEqual(["t Found ${…} rows in ${…}.", "t Found ${…} rows"]);
  });

  it("an array literal that starts with text and is joined is a finding; an array built before it is joined is not", () => {
    const body = [
      '  if (args.q === "a") return ["Header", n, "footer"].join("\\n");',
      '  if (args.q === "b") return [n, "tail"].join("\\n");',
      '  const lines = ["Header"];',
      "  lines.push(String(n));",
      '  return lines.join("\\n");',
    ].join("\n");
    expect(plain(tool("t", body))).toEqual(["t Header ${…} footer"]);
  });

  it("a const name is followed in the handler and at the top of the file; a let of the handler and a const of another function are not", () => {
    const src = [
      'const TOP = "top-level text";',
      'function other() { const header = "another function\'s text"; const hidden = "hidden text"; return header + hidden; }',
      "export const tools = [",
      '  { name: "a", execute() { return TOP; } },',
      '  { name: "b", execute() { const local = "handler text"; return local; } },',
      '  { name: "c", execute(args: { q: string }) { let header = compute(args.q); return header; } },',
      '  { name: "d", execute() { return hidden; } },',
      '  { name: "e", execute() { let TOP = compute(); return TOP; } },',
      "];",
    ].join("\n");
    expect(plain(src)).toEqual(["a top-level text", "b handler text"]);
  });

  it("returns of a function nested in the handler are not findings; the handler's own returns are", () => {
    const body = [
      '  const names = items.map((i) => { return "mapped"; });',
      '  function inner() { return "inner"; }',
      '  rows.forEach(function () { return "callback"; });',
      '  return "outer";',
    ].join("\n");
    expect(plain(tool("t", body))).toEqual(["t outer"]);
  });

  it("a file outside src/tools/ is not scanned for the rule", () => {
    const src = tool("t", '  return "Error: plain";');
    expect(plain(src, "src/lib/x.ts")).toEqual([]);
    expect(plain(src, "src/tools/x.ts")).toEqual(["t Error: plain"]);
  });

  it("the key is the tool name and the first 60 characters of the normalised text; texts equal in them share a key", () => {
    const head = "Nothing was found for this query in any of the indexed sources";
    expect(Array.from(head).length).toBeGreaterThan(60);
    const body = `  if (args.q) return \`${head}, try again\`;\n  return "${head}\\n   and more";`;
    const key = `t ${Array.from(head).slice(0, 60).join("").trim()}`;
    expect(plain(tool("t", body))).toEqual([key, key]);
    expect(plain(tool("t", '  return "two   spaces\\n and a line break";'))).toEqual(["t two spaces and a line break"]);
  });

  it("a moved line keeps the key; a changed text changes it", () => {
    const src = tool("t", '  return "nothing to do";');
    const moved = scan("\n\n\n" + src, TOOL_FILE).plainTextToolResult;
    expect(moved.map((f) => f.text)).toEqual(plain(src));
    expect(moved[0].line).toBe(5);
    expect(plain(tool("t", '  return "nothing to do now";'))).not.toEqual(plain(src));
  });

  it("against the list: an allowed return gives no difference; a second equal return is NEW; a removed one leaves its entry STALE", () => {
    const entry: Entry = { file: TOOL_FILE, text: "t nothing to do", reason: "nothing to do is a result, not a failure" };
    const list: Lock = { ...emptyLock(), plainTextToolResult: [entry] };
    const one = scan(tool("t", '  return "nothing to do";'), TOOL_FILE);
    expect(compareLock(one, list)).toEqual([]);
    const two = scan(tool("t", '  if (args.q) return "nothing to do";\n  return "nothing to do";'), TOOL_FILE);
    expect(compareLock(two, list)).toEqual([
      `NEW plainTextToolResult ${TOOL_FILE}:3 t nothing to do — a tool failure is returned as JSON, not as plain text: return JSON.stringify({ error: <words> }) with error as the first key; an exception on purpose needs an entry in src/lib/conventions.lock.json with its reason`,
    ]);
    const none = scan(tool("t", '  return JSON.stringify({ error: "nothing to do" });'), TOOL_FILE);
    expect(compareLock(none, list)).toEqual([
      `STALE plainTextToolResult ${TOOL_FILE} t nothing to do — the exception matches nothing any more: delete the entry in the same commit`,
    ]);
  });
});

describe("conventions lock — the normalised text that keys an entry", () => {
  it("whitespace, line breaks, a trailing comma and bracket spacing give the same key; a changed argument does not", () => {
    const key = 'f("x", [1, 2], {k: v})';
    for (const variant of ['f( "x",\n   [ 1, 2, ],\n  { k: v }, )', 'f("x",  [1,\t2],  {k: v})', "\n  " + key + "  "])
      expect(normalise(variant), JSON.stringify(variant)).toBe(key);
    expect(normalise('f("y", [1, 2], {k: v})')).not.toBe(key);
    expect(normalise('f("x", [1, 3], {k: v})')).not.toBe(key);
  });
});

describe("conventions lock — the allow-list comparison", () => {
  const finding = (file: string, text: string, line = 1): Finding => ({ file, line, text });
  const lockOf = (rawCron: Entry[]): Lock => ({ ...emptyLock(), rawCron });
  const found = (rawCron: Finding[]): Findings => ({ ...empty(), rawCron });
  const entry = (file: string, text: string): Entry => ({ file, text, reason: "pending: to be moved to the scheduling wrapper" });

  it("equal: every finding has its entry and every entry its finding", () => {
    expect(compareLock(found([finding("src/a.ts", "cron.schedule(x)")]), lockOf([entry("src/a.ts", "cron.schedule(x)")]))).toEqual([]);
  });

  it("a finding the list does not hold is NEW, with its line and the way to fix it", () => {
    expect(compareLock(found([finding("src/a.ts", "cron.schedule(x)", 7)]), lockOf([]))).toEqual([
      "NEW rawCron src/a.ts:7 cron.schedule(x) — a raw schedule has no job name and its missed or failed runs are not recorded: schedule through scheduleCron(id, expr, fn, opts) from src/lib/cron.ts; an exception on purpose needs an entry in src/lib/conventions.lock.json with its reason",
    ]);
    // the same text in another file is another exception
    expect(compareLock(found([finding("src/b.ts", "cron.schedule(x)")]), lockOf([entry("src/a.ts", "cron.schedule(x)")]))).toHaveLength(2);
  });

  it("each rule's NEW message says what the rule is for", () => {
    const one = (rule: Rule): string => compareLock({ ...empty(), [rule]: [finding("src/a.ts", "t")] }, emptyLock())[0];
    expect(one("secondDatabaseHandle")).toContain(" — a second handle does not share the service handle's pragmas: use getDatabase()");
    expect(one("columnChangeOutsideMigrations")).toContain(
      " — a column change outside the numbered list runs on every boot and is not counted in the schema version: append a numbered entry",
    );
    expect(one("containerCallOutsideSeam")).toContain(" — the seam picks the sandbox backend and applies its guards: start containers through spawnSandbox()");
    expect(one("plainTextToolResult")).toContain(
      " — a tool failure is returned as JSON, not as plain text: return JSON.stringify({ error: <words> }) with error as the first key;",
    );
  });

  it("an entry that matches nothing is STALE", () => {
    expect(compareLock(found([]), lockOf([entry("src/a.ts", "cron.schedule(x)")]))).toEqual([
      "STALE rawCron src/a.ts cron.schedule(x) — the exception matches nothing any more: delete the entry in the same commit",
    ]);
  });

  it("multiplicity counts: two equal findings need two entries, and two entries need two findings", () => {
    const two = found([finding("src/a.ts", "cron.schedule(x)", 3), finding("src/a.ts", "cron.schedule(x)", 9)]);
    const one = lockOf([entry("src/a.ts", "cron.schedule(x)")]);
    expect(compareLock(two, one)).toEqual([expect.stringMatching(/^NEW rawCron src\/a\.ts:9 /)]);
    expect(compareLock(found([finding("src/a.ts", "cron.schedule(x)")]), lockOf([...one.rawCron, ...one.rawCron]))).toEqual([
      expect.stringMatching(/^STALE rawCron src\/a\.ts /),
    ]);
  });
});

describe("conventions lock — the production tree equals the allow-list", () => {
  let tree: ReturnType<typeof scanTree>;
  // The whole tree is read and parsed once per file run; generous for a loaded host.
  beforeAll(() => {
    tree = scanTree(REPO);
  }, 120_000);
  const lock = (): Lock => JSON.parse(readFileSync(LOCK_PATH, "utf8")) as Lock;

  it("the scan reads the production tree, and only it; each rule's home is where the rule says", () => {
    expect(tree.files.length).toBeGreaterThan(500);
    expect(tree.files.filter((f) => f.endsWith(".test.ts") || f.endsWith(".d.ts") || f.startsWith("src/test-utils/") || f.includes("/__fixtures__/"))).toEqual([]);
    expect(tree.files).toEqual(expect.arrayContaining([CRON_HOME, DB_HOME, ...SEAM_HOME]));
    const declares = (file: string, re: RegExp): boolean => re.test(readFileSync(join(REPO, file), "utf8"));
    expect(declares(CRON_HOME, /export function scheduleCron\(/)).toBe(true);
    expect(declares(DB_HOME, /const SCHEMA_MIGRATIONS\b/)).toBe(true);
    expect(declares("src/runners/sandbox-backend.ts", /export function spawnSandbox\(/)).toBe(true);
    // The migration list is found: its statements are not findings.
    const inList = scanSource(DB_HOME, readFileSync(join(REPO, DB_HOME), "utf8")).findings.columnChangeOutsideMigrations.length;
    const asOtherFile = scanSource("src/db/not-home.ts", readFileSync(join(REPO, DB_HOME), "utf8")).findings.columnChangeOutsideMigrations.length;
    expect(asOtherFile).toBeGreaterThan(inList);
  });

  it("the allow-list is well-formed: the five rules, sorted entries, a reason each, existing production files", () => {
    const l = lock();
    expect(Object.keys(l)).toEqual([...RULES]);
    const files = new Set(tree.files);
    expect(l.plainTextToolResult.filter((e) => !e.file.startsWith(TOOLS_DIR))).toEqual([]);
    for (const rule of RULES) {
      const order = l[rule].map((e) => `${e.file}\u0000${e.text}`);
      expect(order, rule).toEqual([...order].sort());
      for (const e of l[rule]) {
        expect(Object.keys(e), rule).toEqual(["file", "text", "reason"]);
        expect(files.has(e.file), `${rule} ${e.file}`).toBe(true);
        expect(e.text.length > 0 && e.text === normalise(e.text), `${rule} ${e.text}`).toBe(true);
        expect(e.reason.trim().length, `${rule} ${e.file} reason`).toBeGreaterThan(10);
      }
    }
  });

  it("every finding is on the allow-list and every entry still matches a finding", () => {
    const diff = compareLock(tree.findings, lock());
    expect(diff, diff.join("\n")).toEqual([]);
  });

  it("against a copy of the list with one entry taken out the tree reports it NEW; with an invented entry added, STALE", () => {
    const l = lock();
    const rule = RULES.find((r) => l[r].length > 0)!;
    const [first, ...rest] = l[rule];
    expect(compareLock(tree.findings, { ...l, [rule]: rest })).toEqual([expect.stringMatching(new RegExp(`^NEW ${rule} ${first.file}:\\d+ `))]);
    const invented: Entry = { file: first.file, text: `${first.text} /* no such call */`, reason: "invented" };
    expect(compareLock(tree.findings, { ...l, [rule]: [...l[rule], invented] })).toEqual([
      `STALE ${rule} ${invented.file} ${invented.text} — the exception matches nothing any more: delete the entry in the same commit`,
    ]);
  });
});
