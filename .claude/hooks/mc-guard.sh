#!/bin/bash
# PreToolUse hook "mc-guard": repo copy for Claude Code CLOUD sessions (2026-10-03).
#
# The VPS runs a user-level mc-guard (/root/.claude/hooks/scripts/mc-guard.sh, not
# in this repo); that copy stays canonical on the VPS. This file reconstructs its
# documented rules so a cloud clone gets the same seatbelt. On the VPS both copies
# run; two identical denials are harmless.
#
# It is a SEATBELT, NOT A SANDBOX. The embedded node program does a small shell
# lex of the Bash command (quotes, backslashes, $(...) and `...` substitutions,
# subshells, redirections, heredocs, ; & && || | and newlines), strips transparent
# wrappers (sudo, env, timeout, nice, xargs, eval, ...) and re-checks the strings
# handed to bash -c / eval / watch / a heredoc or pipe into a shell. Text inside
# quotes and the body of a heredoc fed to a non-shell (cat, tee, gh, git) is data,
# not a command. Known-open spellings (not resolved here): variables and globs that
# name the target ($D/mc.db, mc.d?), aliases and functions, paths assembled inside
# an interpreter (python -c, node -e), args arriving on stdin (echo X | xargs sh),
# scripts that call deploy.sh themselves, case-statement parens. A false DENY on a
# harmless command is acceptable; rewrite the command.
#
# Denied (CLAUDE.md Infrastructure / Invariants):
#   a. running deploy.sh: any word naming deploy.sh unless the program is a
#      reader/editor (cat less grep sed git diff vim ...) -- operator-run.
#   b. sqlite3 on *mc.db (also file: URIs) without -readonly or ?mode=ro --
#      DDL/writes are operator-run.
#   c. destroying or overwriting mc.db / -wal / -shm: rm mv truncate shred unlink
#      tee, cp/install/rsync/ln onto it, dd of=, > >> >| &> onto it, rm of the
#      data dir, git clean -x/-X, find -delete / -exec rm on a db or data path --
#      never reset the DB without explicit approval.
#   d. systemctl start/stop/restart/reload/kill/... mission-control, disable/mask
#      --now, isolate, and service mission-control <verb> -- operator-run deploy.
#
# Input: the PreToolUse JSON on stdin. Output: a deny decision as JSON on stdout
# (exit 0), or nothing (exit 0) to allow. Needs node (always present: the service
# and the toolchain are node); without it, exits 1 (non-blocking) with a note.
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "mc-guard: node not found on PATH; guard NOT applied to this command." >&2
  exit 1
fi

IFS= read -r -d '' prog <<'JS' || true
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "su"]);
const READERS = new Set(["cat", "less", "more", "head", "tail", "grep", "egrep", "fgrep", "rg", "sed", "awk",
  "git", "wc", "ls", "diff", "stat", "file", "vim", "vi", "nano", "code", "bat", "echo", "printf", "find", "fd",
  "test", "[", "[[", "shellcheck", "chmod", "sha256sum", "md5sum", "which", "type", "command", "gh"]);
// cp/mv/rsync/install read their sources: deploy.sh only counts as the destination.
const COPIERS = new Set(["cp", "mv", "rsync", "install"]);
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "}", "time"]);
// Wrapper -> [options that take a value, positional args after options].
const WRAPPERS = {
  sudo: [["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T", "--user", "--group"], 0],
  doas: [["-u", "-C"], 0],
  env: [["-u", "-C", "-S", "--unset", "--chdir"], 0],
  timeout: [["-s", "-k", "--signal", "--kill-after"], 1],
  nice: [["-n", "--adjustment"], 0],
  ionice: [["-c", "-n", "-p", "-P", "-u", "--class", "--classdata"], 0],
  chrt: [[], 1],
  flock: [["-w", "-E", "--timeout", "--conflict-exit-code"], 1],
  xargs: [["-I", "-L", "-n", "-P", "-d", "-E", "-s", "-a", "--max-args", "--delimiter"], 0],
  watch: [["-n", "--interval"], 0],
  stdbuf: [["-i", "-o", "-e"], 0],
  time: [["-f", "-o"], 0],
  exec: [["-a"], 0],
  setsid: [[], 0], nohup: [[], 0], command: [[], 0], builtin: [[], 0], eval: [[], 0],
};
const DB_RE = /(^|[\/:])mc\.db(-wal|-shm)?($|\?)/;
const DEPLOY_RE = /(^|\/)deploy\.sh$/;
// The repo's data dir only: `data`, `./data/`, `data/*`, or <...>/mission-control(-jarvis)/data.
const DATA_DIR_RE = /^(\.\/)?data\/?(\*)?$|(^|\/)mission-control(-jarvis)?\/data\/?(\*)?$/;
const DATA_PATH_RE = /^(\.\/)?data(\/|$)|(^|\/)mission-control(-jarvis)?\/data(\/|$)/;
const MAX_DEPTH = 6;
const R_DEPTH = "command nests eval/bash -c/heredocs too deeply to check; flatten it.";
const SYSTEMCTL_VERBS = new Set(["start", "stop", "restart", "reload", "kill", "try-restart", "reload-or-restart",
  "try-reload-or-restart", "condrestart", "force-reload"]);
const SERVICE_VERBS = new Set(["start", "stop", "restart", "reload", "force-reload", "try-restart", "condrestart"]);
const WRITE_REDIRS = new Set([">", ">>", ">|", "&>", "&>>", "<>"]);

const R_DEPLOY = "scripts/deploy.sh is operator-run (CLAUDE.md Infrastructure); ask the operator to deploy.";
const R_SQLITE = "sqlite3 on mc.db without -readonly is denied; DDL and writes are operator-run. Use sqlite3 -readonly.";
const R_DB = "deleting, moving, truncating or overwriting mc.db is denied; never reset the DB without explicit operator approval.";
const R_SVC = "starting/stopping/restarting mission-control is an operator-run deploy step (CLAUDE.md Infrastructure).";

const base = (w) => (w ?? "").replace(/\/+$/, "").split("/").pop();

/** Lex `src` into simple commands: {words, redirs, heredocs, herestrings, group}. */
function lex(src) {
  const ctx = { segs: [], pending: [], groups: 0 };
  parse(src, 0, null, ctx);
  return ctx.segs;
}

function parse(src, i, term, ctx) {
  const n = src.length;
  let seg = { words: [], redirs: [], heredocs: [], herestrings: [], group: ++ctx.groups };
  let depth = 0;
  const end = (sep) => {
    if (seg.words.length || seg.redirs.length) ctx.segs.push(seg);
    seg = { words: [], redirs: [], heredocs: [], herestrings: [], group: sep === "|" ? seg.group : ++ctx.groups };
  };
  const readHeredocs = (j) => {
    while (ctx.pending.length && j < n) {
      const h = ctx.pending.shift();
      while (j < n) {
        let nl = src.indexOf("\n", j);
        if (nl < 0) nl = n;
        const line = src.slice(j, nl);
        j = Math.min(nl + 1, n);
        if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
        h.body += line + "\n";
      }
    }
    return j;
  };
  const readDouble = (j, acc) => {
    while (j < n && src[j] !== '"') {
      const c = src[j];
      if (c === "\\" && j + 1 < n) { acc.t += '"\\$`\n'.includes(src[j + 1]) ? src[j + 1] : c + src[j + 1]; j += 2; }
      else if (c === "$" && src[j + 1] === "(" && src[j + 2] !== "(") { j = parse(src, j + 2, ")", ctx); acc.t += "\u0001"; }
      else if (c === "`") { j = parse(src, j + 1, "`", ctx); acc.t += "\u0001"; }
      else { acc.t += c; j++; }
    }
    return j + 1;
  };
  const readWord = (j) => {
    const acc = { t: "" };
    let quoted = false;
    while (j < n) {
      const c = src[j];
      if (" \t\n;&|()<>".includes(c) || (c === "`" && term === "`")) break;
      if (c === "'") { let k = src.indexOf("'", j + 1); if (k < 0) k = n; acc.t += src.slice(j + 1, k); j = k + 1; quoted = true; }
      else if (c === '"') { j = readDouble(j + 1, acc); quoted = true; }
      else if (c === "\\") { if (src[j + 1] !== "\n") acc.t += src[j + 1] ?? ""; j += 2; }
      else if (c === "$" && src[j + 1] === "(" && src[j + 2] === "(") { let k = src.indexOf("))", j); if (k < 0) k = n - 2; acc.t += src.slice(j, k + 2); j = k + 2; }
      else if (c === "$" && src[j + 1] === "(") { j = parse(src, j + 2, ")", ctx); acc.t += "\u0001"; }
      else if (c === "$" && src[j + 1] === "{") { let k = src.indexOf("}", j); if (k < 0) k = n - 1; acc.t += src.slice(j, k + 1); j = k + 1; }
      else if (c === "`") { j = parse(src, j + 1, "`", ctx); acc.t += "\u0001"; }
      else { acc.t += c; j++; }
    }
    return { text: acc.t, quoted, i: j };
  };
  const OPS = ["<<<", "<<-", "&>>", "<<", "<>", "<&", "<(", ">>", ">|", ">&", "&>", ">(", "<", ">"];
  const readRedirect = (j) => {
    const op = OPS.find((o) => src.startsWith(o, j));
    j += op.length;
    if (op === "<(" || op === ">(") return parse(src, j, ")", ctx);
    while (src[j] === " " || src[j] === "\t") j++;
    const w = readWord(j);
    seg.redirs.push({ op, target: w.text });
    if (op === "<<" || op === "<<-") {
      const h = { delim: w.text, strip: op === "<<-", body: "" };
      seg.heredocs.push(h);
      ctx.pending.push(h);
    } else if (op === "<<<") seg.herestrings.push(w.text);
    return w.i;
  };

  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t") { i++; continue; }
    if (c === "\\" && src[i + 1] === "\n") { i += 2; continue; }
    if (term === "`" && c === "`") { end(""); return i + 1; }
    if (c === "\n") { end("\n"); i = readHeredocs(i + 1); continue; }
    if (c === "#") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === ";") { end(";"); i += src[i + 1] === ";" ? 2 : 1; continue; }
    if (c === "&") {
      if (src[i + 1] === "&") { end("&&"); i += 2; }
      else if (src[i + 1] === ">") i = readRedirect(i);
      else { end("&"); i++; }
      continue;
    }
    if (c === "|") {
      if (src[i + 1] === "|") { end("||"); i += 2; }
      else { end("|"); i += src[i + 1] === "&" ? 2 : 1; }
      continue;
    }
    if (c === "(") { end("("); depth++; i++; continue; }
    if (c === ")") {
      if (term === ")" && depth === 0) { end(""); return i + 1; }
      depth = Math.max(0, depth - 1); end(")"); i++; continue;
    }
    if (c === "<" || c === ">") { i = readRedirect(i); continue; }
    const w = readWord(i);
    i = w.i;
    // `2>file`: an unquoted all-digit word glued to a redirection is its fd.
    if (!w.quoted && /^\d+$/.test(w.text) && (src[i] === "<" || src[i] === ">")) { i = readRedirect(i); continue; }
    if (w.text !== "" || w.quoted) seg.words.push(w.text);
  }
  end("");
  return i;
}

/** Strip assignments, keywords and wrappers; returns {prog, base, args, reparse}. */
function resolve(words) {
  let k = 0;
  for (;;) {
    while (k < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k]) || KEYWORDS.has(words[k]))) k++;
    if (k >= words.length) return null;
    const b = base(words[k]);
    const wr = WRAPPERS[b];
    if (!wr) break;
    if (b === "command" && /^-[vV]$/.test(words[k + 1] ?? "")) break; // a lookup, not a run
    k++;
    while (k < words.length && words[k].startsWith("-") && words[k] !== "-") {
      if (words[k] === "--") { k++; break; }
      k += wr[0].includes(words[k]) ? 2 : 1;
    }
    if (b === "env") while (k < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k])) k++;
    k += wr[1];
    if (b === "eval" || b === "watch") return { reparse: words.slice(k).join(" ") };
  }
  return { prog: words[k], base: base(words[k]), args: words.slice(k + 1) };
}

/** The -c string of a shell, or undefined. */
function shellC(r) {
  const ci = r.args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
  return ci >= 0 ? r.args[ci + 1] ?? "" : undefined;
}

function check(cmd, depth = 0) {
  if (depth > MAX_DEPTH) return R_DEPTH;
  const segs = lex(cmd);
  const resolved = segs.map((s) => resolve(s.words));
  for (let si = 0; si < segs.length; si++) {
    const s = segs[si];
    const r = resolved[si];
    for (const rd of s.redirs) if (WRITE_REDIRS.has(rd.op) && DB_RE.test(rd.target)) return R_DB;
    if (!r) continue;
    if (r.reparse !== undefined) { const x = check(r.reparse, depth + 1); if (x) return x; continue; }
    const { base: b, args } = r;
    const all = [r.prog, ...args];

    // a. deploy.sh
    const firstPos = args.findIndex((a) => !a.startsWith("-"));
    const lead = firstPos < 0 ? args : args.slice(0, firstPos); // options before the script / command
    const syntaxOnly = SHELLS.has(b) && b !== "su" && lead.some((a) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(a)); // bash -n
    const reader = READERS.has(b) || syntaxOnly || (b === "npx" && args[0] === "prettier");
    if (COPIERS.has(b)) {
      const pos = args.filter((a) => !a.startsWith("-"));
      if (pos.length && DEPLOY_RE.test(pos[pos.length - 1])) return R_DEPLOY;
    } else if (!reader && all.some((w) => !/\s/.test(w) && DEPLOY_RE.test(w))) return R_DEPLOY;
    if (SHELLS.has(b) && !syntaxOnly) {
      if (s.redirs.some((rd) => rd.op === "<" && DEPLOY_RE.test(rd.target))) return R_DEPLOY;
      const c = shellC(r);
      for (const body of [c, ...s.heredocs.map((h) => h.body), ...s.herestrings]) {
        if (body === undefined) continue;
        const x = check(body, depth + 1);
        if (x) return x;
      }
      // A shell reading stdin in a pipeline runs what the earlier stages print.
      if (c === undefined && !args.some((a) => !a.startsWith("-"))) {
        for (let pj = 0; pj < si; pj++) {
          if (segs[pj].group !== s.group) continue;
          const p = resolved[pj];
          const fed = [...segs[pj].heredocs.map((h) => h.body), ...segs[pj].herestrings];
          // Expand \n and \t as printf / echo -e (and dash's echo) would.
          if (p && !p.reparse && (p.base === "echo" || p.base === "printf")) {
            fed.push(p.args.filter((a) => !a.startsWith("-")).join(" ").replace(/\\n/g, "\n").replace(/\\t/g, "\t"));
          }
          for (const body of fed) { const x = check(body, depth + 1); if (x) return x; }
        }
      }
    }

    // b. sqlite3 without -readonly
    if (b === "sqlite3") {
      // Any mention counts (ATTACH 'data/mc.db' inside the SQL); ?mode=ro only on the DB argument itself.
      const mentions = args.filter((a) => /mc\.db/.test(a));
      const ro = args.includes("-readonly") || args.includes("--readonly") ||
        mentions.every((a) => DB_RE.test(a) && /[?&]mode=ro(&|$)/.test(a));
      if (mentions.length && !ro) return R_SQLITE;
    }

    // c. destroying or overwriting the DB
    if (["rm", "mv", "truncate", "shred", "unlink", "tee"].includes(b) && args.some((a) => DB_RE.test(a))) return R_DB;
    if (b === "rm" && args.some((a) => DATA_DIR_RE.test(a))) return R_DB;
    if (["cp", "install", "rsync", "ln"].includes(b)) {
      const pos = args.filter((a) => !a.startsWith("-"));
      if (pos.length && DB_RE.test(pos[pos.length - 1])) return R_DB;
    }
    if (b === "dd" && args.some((a) => a.startsWith("of=") && DB_RE.test(a.slice(3)))) return R_DB;
    if (b === "git") {
      const ci = args.indexOf("clean");
      if (ci >= 0 && args.slice(ci + 1).some((a) => /^-[a-zA-Z]*[xX]/.test(a))) return R_DB;
    }
    if (b === "find") {
      const ei = args.findIndex((a) => ["-exec", "-execdir", "-ok", "-okdir"].includes(a));
      const destroys = args.includes("-delete") ||
        (ei >= 0 && ["rm", "shred", "unlink", "truncate", "mv"].includes(base(args[ei + 1])));
      if (destroys && args.some((a) => /mc\.db|\*\.db/.test(a) || DATA_PATH_RE.test(a))) return R_DB;
    }

    // d. service lifecycle
    if (b === "systemctl") {
      const unit = args.some((a) => /^mission-control(\.service)?$/.test(a));
      if (args.includes("isolate")) return R_SVC;
      if (unit && args.some((a) => SYSTEMCTL_VERBS.has(a))) return R_SVC;
      if (unit && args.includes("--now") && (args.includes("disable") || args.includes("mask"))) return R_SVC;
    }
    if (b === "service" && /^mission-control(\.service)?$/.test(args[0] ?? "") && SERVICE_VERBS.has(args[1])) return R_SVC;
  }
  return null;
}

let raw = "";
process.stdin.on("data", (d) => (raw += d)).on("end", () => {
  const j = JSON.parse(raw);
  if (j.tool_name !== "Bash") return;
  const reason = check(String((j.tool_input || {}).command || ""));
  if (reason) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "mc-guard: " + reason },
    }) + "\n");
  }
});
JS

exec node -e "$prog"
