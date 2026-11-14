/**
 * The seen and proven fingerprint sets and the one registration parser.
 * Fixtures copy the mailbox tool's output shape (a `verified:` line, then
 * `password: <value>` and the settings lines) wrapped the way shell_exec
 * returns stdout. Values are synthetic; databases are temp files.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import {
  SEEN_MAX_ROWS,
  VERIFYING_COMMANDS,
  _resetMailboxPasswords,
  forgetProvenPasswords,
  isSeenPassword,
  parseMailboxOutput,
  provenPasswords,
  recordUserPasswordProof,
  registerMailboxResult,
} from "./mailbox-passwords.js";
import { passwordFingerprint } from "./password-gate.js";
import { cpuMsPerCall } from "../../test-utils/cpu-time.js";

const PW = "FakeTestPassWordXYZ2345";
const PW2 = "FakeTestPassWordXYZ6789";
const BOX = "box@example.test";

const settings = (pw: string): string[] => [
  `password: ${pw}`,
  "the password contains no look-alike characters (no l, I, 1, O, 0); copy and paste it rather than typing where possible",
  `login: ${BOX}`,
  "incoming: IMAP mail.example.test port 993 SSL/TLS",
  "outgoing: SMTP mail.example.test port 465 SSL/TLS",
  "ports 587 and 143 are not served by this server",
  "This is the ONLY valid password for this mailbox; every password shown earlier is dead.",
  "Tell the user exactly this value; do not run set-password again unless the user asks for a new password.",
];
const verifiedBlock = (pw: string) =>
  ["verified: IMAP login OK", ...settings(pw)].join("\n") + "\n";
const shellResult = (stdout: string, stderr?: string) =>
  JSON.stringify({ stdout, exit_code: 0, ...(stderr && { stderr }) });
const fp = passwordFingerprint;

/** Bound on `growth4x().ratio`: linear work measures about 4, quadratic work about 16. */
const GROWTH_BOUND = 8;

/**
 * How the CPU time of `fn` grows from input `make(n)` to input `make(4 * n)`. Both sizes repeat
 * the call the same number of times, doubled until one run of the smaller size takes 40 ms, so
 * the figure is not lost in timer noise. Linear work grows about 4x and quadratic work about 16x,
 * whatever the machine's speed or load. The ratio is measured up to three times and the smallest
 * is kept, stopping at the first one under GROWTH_BOUND: on a busy machine one noisy measurement
 * can push a single ratio over the bound, but the noise does not repeat three times, while a real
 * super-linear change measures about 16x on every attempt and still fails. `largeMs` is the larger
 * size's CPU ms per call from the first attempt.
 */
function growth4x<T>(
  make: (size: number) => T,
  n: number,
  fn: (input: T) => unknown,
): { ratio: number; largeMs: number; label: string } {
  const small = make(n);
  const large = make(4 * n);
  let reps = 1;
  fn(small);
  for (;;) {
    const c0 = process.cpuUsage();
    for (let i = 0; i < reps; i++) fn(small);
    const d = process.cpuUsage(c0);
    if ((d.user + d.system) / 1000 >= 40 || reps >= 1_000_000) break;
    reps *= 2;
  }
  let ratio = Infinity;
  let largeMs = NaN;
  let label = "";
  for (let attempt = 1; attempt <= 3 && ratio >= GROWTH_BOUND; attempt++) {
    const a = cpuMsPerCall(() => fn(small), reps);
    const b = cpuMsPerCall(() => fn(large), reps);
    if (attempt === 1) largeMs = b;
    if (b / a < ratio) {
      ratio = b / a;
      label = `${b.toFixed(3)} ms / ${a.toFixed(3)} ms per call, ${reps} calls per run, attempt ${attempt}`;
    }
  }
  return { ratio, largeMs, label };
}

let tmpDbPath: string | null = null;
function freshFileDb(): string {
  tmpDbPath = join(tmpdir(), `mc-mailbox-pw-${process.pid}-${Date.now()}.db`);
  initDatabase(tmpDbPath);
  return tmpDbPath;
}

beforeEach(() => {
  _resetMailboxPasswords();
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  closeDatabase();
  _resetMailboxPasswords();
  if (tmpDbPath) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        if (existsSync(tmpDbPath + suffix)) unlinkSync(tmpDbPath + suffix);
      } catch {
        /* best-effort cleanup */
      }
    }
    tmpDbPath = null;
  }
});

describe("parseMailboxOutput", () => {
  it("every password line is taken, with or without the verified line", () => {
    expect(parseMailboxOutput(verifiedBlock(PW))).toEqual({ fingerprints: [fp(PW)], ignored: 0 });
    expect(parseMailboxOutput(settings(PW).join("\n"))).toEqual({ fingerprints: [fp(PW)], ignored: 0 });
    expect(parseMailboxOutput(`password: ${PW}`)).toEqual({ fingerprints: [fp(PW)], ignored: 0 });
    expect(parseMailboxOutput(`other\npassword: ${PW}\nnote\npassword: ${PW2}\n`)).toEqual({
      fingerprints: [fp(PW), fp(PW2)],
      ignored: 0,
    });
  });

  it("\\r\\n line ends are read the same way", () => {
    expect(parseMailboxOutput(verifiedBlock(PW).replace(/\n/g, "\r\n"))).toEqual({
      fingerprints: [fp(PW)],
      ignored: 0,
    });
  });

  it("a value with a symbol, a space or outside 16-64 is ignored and counted", () => {
    const out = [
      "verified: IMAP login OK",
      `password: ${PW}!`,
      `password: ${PW} x`,
      `password: ${"Ab3".repeat(5)}`,
      `password: ${"Ab3".repeat(22)}`,
      "password: SECRET_MAILBOX_KEY",
    ].join("\n");
    expect(parseMailboxOutput(out)).toEqual({ fingerprints: [], ignored: 5 });
  });

  it("only a line that starts with the label counts", () => {
    expect(parseMailboxOutput(`  password: ${PW}\nnew password: ${PW2}\n`)).toEqual({
      fingerprints: [],
      ignored: 0,
    });
  });
});

describe("registerMailboxResult", () => {
  it("only shell_exec running a verifying command registers; stderr never does", () => {
    expect(VERIFYING_COMMANDS).toEqual(["stalwart-inbox"]);
    const res = shellResult("", `verified: IMAP login OK\npassword: ${PW}\n`);
    expect(registerMailboxResult("shell_exec", { command: "stalwart-inbox show box" }, res, "t1")).toEqual({
      seen: 0,
      proven: 0,
      ignored: 0,
    });
    expect(registerMailboxResult("file_read", { command: "stalwart-inbox show box" }, shellResult(verifiedBlock(PW)), "t1")).toBeNull();
    expect(isSeenPassword(fp(PW))).toBe(false);
    expect(provenPasswords("t1").size).toBe(0);
  });

  describe("a command whose segment runs a verifying command as its program registers", () => {
    const qualifying = [
      "stalwart-inbox show box",
      "stalwart-inbox set-password box",
      "stalwart-inbox create box",
      "stalwart-inbox show box | head -12",
      "stalwart-inbox set-password box | head -12",
      "stalwart-inbox create box | head -12",
      "stalwart-inbox show box 2>&1",
      "stalwart-inbox show box; echo done",
      "stalwart-inbox show box 2>&1 | grep -i pass",
      "stalwart-inbox show box | tail -3",
      "/usr/local/bin/stalwart-inbox show box",
      "/usr/local/bin/stalwart-inbox show box 2>&1 | grep -i pass; echo done",
      "cd /tmp && stalwart-inbox show box",
      "echo start;stalwart-inbox show box",
      "true&stalwart-inbox show box",
      "true|stalwart-inbox show box",
      "(stalwart-inbox show box)",
      "stalwart-inbox",
      "stalwart-inbox\tshow box",
      "sudo stalwart-inbox show box",
      "timeout 30 stalwart-inbox show box",
      "X=1 stalwart-inbox show box",
      "(cd /tmp && stalwart-inbox show box)",
      "stalwart-inbox set-password box | tee /tmp/box-notes.txt",
      "echo 'a;b'; stalwart-inbox show box",
      "cat notes.md\nstalwart-inbox show box",
      "stalwart-inbox show box # la caja nueva",
      "# primero la caja\nstalwart-inbox show box",
      "stalwart-inbox show box#1",
      "echo a#b; stalwart-inbox show box",
      "echo 'x'#y; stalwart-inbox show box",
      "echo 'a # b'; stalwart-inbox show box",
      "echo \\#x; stalwart-inbox show box",
      "echo 'a << b'; stalwart-inbox show box",
      // An escaped space is part of the word, so the # after it is not a comment.
      "echo \\ #; stalwart-inbox show box",
      // A single < is an input redirection, not a here-document.
      "stalwart-inbox show box < /dev/null",
      "stalwart-inbox show \\\nbox",
    ];
    it.each(qualifying)("seen and proven: %s", (command) => {
      expect(registerMailboxResult("shell_exec", { command }, shellResult(verifiedBlock(PW)), "t1")).toEqual({
        seen: 1,
        proven: 1,
        ignored: 0,
      });
      expect(isSeenPassword(fp(PW))).toBe(true);
      expect(provenPasswords("t1").has(fp(PW))).toBe(true);
    });

    const notQualifying = [
      "/opt/tools/stalwart-inbox.bak show box",
      "stalwart-inbox.bak-2026 show box",
      "my-stalwart-inbox show box",
      "stalwart-inboxes show box",
      "xstalwart-inbox show box",
      "cat notes-about-stalwart-inbox-usage.txt",
      "echo stalwart-inbox-show",
      "echo stalwart_inbox",
      "cat notes.txt",
      "",
      "grep -A8 stalwart-inbox notes.md",
      "cat log.txt | grep -A8 stalwart-inbox",
      "echo stalwart-inbox",
      "ls /usr/local/bin/stalwart-inbox",
      "grep -E 'x|stalwart-inbox show' notes.md",
      'echo "a; stalwart-inbox show box"',
      'bash -c "stalwart-inbox show box"',
      "echo x\\;stalwart-inbox show box",
      '"stalwart-inbox" show box',
      "timeout stalwart-inbox show box",
      // A here-document anywhere makes the command non-qualifying: its body is text.
      "cat <<EOF\nstalwart-inbox\npassword: x\nEOF",
      "cat <<'EOF'\nstalwart-inbox show box\nEOF",
      "cat <<-EOF\n\tstalwart-inbox show box\nEOF",
      "stalwart-inbox show box <<EOF\nx\nEOF",
      "cat<<EOF\nstalwart-inbox\nEOF",
      // Text after an unquoted # that starts a word is a comment, not a segment.
      "echo hola # ; stalwart-inbox show box",
      "true #(stalwart-inbox show box)",
      "#stalwart-inbox show box",
      "echo x;# stalwart-inbox show box",
      "cat notes.md\t#; stalwart-inbox show box",
      "timeout # stalwart-inbox show box",
      // A backslash-newline is removed by the shell: it neither starts nor ends a word.
      "cat notes.md \\\n#; stalwart-inbox show box",
      "cat <\\\n<EOF\nstalwart-inbox show box\nEOF",
    ];
    it.each(notQualifying)("not a mailbox command, nothing registered: %s", (command) => {
      expect(registerMailboxResult("shell_exec", { command }, shellResult(verifiedBlock(PW)), "t1")).toBeNull();
      expect(isSeenPassword(fp(PW))).toBe(false);
      expect(provenPasswords("t1").size).toBe(0);
    });

    it("a later qualifying segment counts even after one that does not", () => {
      const command = "ls /opt/tools/stalwart-inbox.bak; stalwart-inbox show box";
      expect(registerMailboxResult("shell_exec", { command }, shellResult(verifiedBlock(PW)), "t1")).toEqual({
        seen: 1,
        proven: 1,
        ignored: 0,
      });
    });

    it("stdout cut to the single password line: seen and proven", () => {
      expect(
        registerMailboxResult(
          "shell_exec",
          { command: "stalwart-inbox show box 2>&1 | grep -i pass" },
          shellResult(`password: ${PW}\n`),
          "t1",
        ),
      ).toEqual({ seen: 1, proven: 1, ignored: 0 });
      expect(isSeenPassword(fp(PW))).toBe(true);
      expect(provenPasswords("t1").has(fp(PW))).toBe(true);
    });

    it.each([
      ["segments", "grep 'a;b' stalwart-inbox; "],
      ["comment lines", "true # stalwart-inbox 'x\n"],
    ])("the command check is linear on a long command: %s", (_name, piece) => {
      const command = piece.repeat(20_000) + "stalwart-inbox show box";
      expect(registerMailboxResult("shell_exec", { command }, shellResult(verifiedBlock(PW)), "t1")).toEqual({
        seen: 1,
        proven: 1,
        ignored: 0,
      });
      // 5,000 to 20,000 pieces: about 4x for linear work, 16x for quadratic; 2 s ceiling.
      const g = growth4x(
        (n) => piece.repeat(n) + "stalwart-inbox show box",
        5_000,
        (cmd) => registerMailboxResult("shell_exec", { command: cmd }, shellResult(verifiedBlock(PW)), "t1"),
      );
      expect(g.ratio, g.label).toBeLessThan(GROWTH_BOUND);
      expect(g.largeMs, g.label).toBeLessThan(2000);
    });
  });

  it("a value one past the length bound is ignored and counted, nothing seen", () => {
    const long = "Ab3".repeat(21) + "Ab"; // 65 characters
    expect(registerMailboxResult("shell_exec", { command: "stalwart-inbox show box" }, shellResult(`password: ${long}\n`), "t1")).toEqual({
      seen: 0,
      proven: 0,
      ignored: 1,
    });
    expect(isSeenPassword(fp(long))).toBe(false);
  });

  it("a failing seen write still leaves this run's value proven and seen in this process, and does not throw", () => {
    initDatabase(":memory:");
    getDatabase().exec(
      "CREATE TRIGGER refuse_seen BEFORE INSERT ON mailbox_password_seen BEGIN SELECT RAISE(ABORT, 'refused'); END",
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() =>
      registerMailboxResult("shell_exec", { command: "stalwart-inbox show box" }, shellResult(verifiedBlock(PW)), "t1"),
    ).not.toThrow();
    expect(provenPasswords("t1").has(fp(PW))).toBe(true);
    expect(isSeenPassword(fp(PW))).toBe(true);
    expect(warn.mock.calls.map((c) => c.join(" "))).toEqual(["[v8-4] mailbox-passwords registration failed"]);
  });

  it("a result that is not JSON registers nothing and does not throw", () => {
    expect(
      registerMailboxResult("shell_exec", { command: "stalwart-inbox show box" }, verifiedBlock(PW), "t1"),
    ).toBeNull();
    expect(registerMailboxResult("shell_exec", { command: "stalwart-inbox show box" }, undefined, "t1")).toBeNull();
    expect(isSeenPassword(fp(PW))).toBe(false);
  });

  it("outside a run the value is seen and nothing is proven", () => {
    expect(
      registerMailboxResult("shell_exec", { command: "stalwart-inbox show box" }, shellResult(verifiedBlock(PW)), undefined),
    ).toEqual({ seen: 1, proven: 0, ignored: 0 });
    expect(isSeenPassword(fp(PW))).toBe(true);
  });

  it("the log line carries counts only", () => {
    const log = vi.mocked(console.log);
    registerMailboxResult("shell_exec", { command: "stalwart-inbox show box" }, shellResult(verifiedBlock(PW)), "t1");
    const lines = log.mock.calls.map((c) => c.join(" "));
    expect(lines).toEqual(["[v8-4] mailbox-passwords registered seen=1 proven=1 ignored=0"]);
  });
});

describe("proven set", () => {
  it("the user's message gives proof for its task only; freeing the task closes it for good", () => {
    recordUserPasswordProof("t1", `ponle ${PW2} por favor`);
    expect(provenPasswords("t1").has(fp(PW2))).toBe(true);
    expect(provenPasswords("t2").size).toBe(0);
    forgetProvenPasswords("t1");
    expect(provenPasswords("t1").size).toBe(0);
    // A record that arrives after the task was freed is refused.
    recordUserPasswordProof("t1", `ponle ${PW2}`);
    registerMailboxResult("shell_exec", { command: "stalwart-inbox show box" }, shellResult(verifiedBlock(PW)), "t1");
    expect(provenPasswords("t1").size).toBe(0);
    expect(provenPasswords(undefined).size).toBe(0);
  });
});

describe("seen store — persistence", () => {
  it("stores the fingerprint only: the value appears nowhere in the table", () => {
    initDatabase(":memory:");
    registerMailboxResult("shell_exec", { command: "stalwart-inbox show box" }, shellResult(verifiedBlock(PW)), "t1");
    const rows = getDatabase().prepare("SELECT * FROM mailbox_password_seen").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0])).toEqual(["fingerprint", "first_seen"]);
    expect(rows[0].fingerprint).toBe(fp(PW));
    expect(JSON.stringify(rows)).not.toContain(PW);
  });

  it("survives a re-open of the database (a new process reads it lazily)", () => {
    const path = freshFileDb();
    registerMailboxResult("shell_exec", { command: "stalwart-inbox show box" }, shellResult(verifiedBlock(PW)), "t1");
    closeDatabase();
    _resetMailboxPasswords();
    initDatabase(path);
    expect(isSeenPassword(fp(PW))).toBe(true);
    expect(isSeenPassword(fp(PW2))).toBe(false);
  });

  it("follows the database in use: a different database has its own set", () => {
    initDatabase(":memory:");
    registerMailboxResult("shell_exec", { command: "stalwart-inbox show box" }, shellResult(verifiedBlock(PW)), "t1");
    expect(isSeenPassword(fp(PW))).toBe(true);
    closeDatabase();
    initDatabase(":memory:");
    expect(isSeenPassword(fp(PW))).toBe(false);
  });

  it(`keeps the newest ${SEEN_MAX_ROWS} rows, and the cache follows`, () => {
    const path = freshFileDb();
    const value = (n: number) => `FakeTestPassWord${String(n).padStart(6, "0")}`;
    const total = SEEN_MAX_ROWS + 3;
    const stdout = Array.from({ length: total }, (_, n) => `password: ${value(n)}`).join("\n");
    registerMailboxResult("shell_exec", { command: "stalwart-inbox list" }, shellResult(stdout), "t1");
    const count = () =>
      (getDatabase().prepare("SELECT COUNT(*) AS n FROM mailbox_password_seen").get() as { n: number }).n;
    expect(count()).toBe(SEEN_MAX_ROWS);
    for (const n of [0, 1, 2]) expect(isSeenPassword(fp(value(n)))).toBe(false);
    for (const n of [3, total - 1]) expect(isSeenPassword(fp(value(n)))).toBe(true);
    closeDatabase();
    const raw = new Database(path, { readonly: true });
    expect((raw.prepare("SELECT COUNT(*) AS n FROM mailbox_password_seen").get() as { n: number }).n).toBe(
      SEEN_MAX_ROWS,
    );
    raw.close();
  });
});
