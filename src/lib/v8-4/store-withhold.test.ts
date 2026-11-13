/**
 * The mailbox-password store rule: a value whose fingerprint is in the seen
 * set is replaced in stored text whether or not a run proved it. Values are
 * synthetic; databases are temp files.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import {
  PASSWORD_WITHHELD_PLACEHOLDER,
  passwordFingerprint,
} from "./password-gate.js";
import {
  _resetStoreWithhold,
  setStoreSeenCheck,
  storeReplacer,
  withholdForStore,
  type StoreSeenCheck,
} from "./store-withhold.js";
import {
  _resetMailboxPasswords,
  forgetProvenPasswords,
  provenPasswords,
  registerMailboxResult,
} from "./mailbox-passwords.js";

const PW = "FakeTestPassWordXYZ2345";
const OTHER = "FakeTestPassWordXYZ6789";
const P = PASSWORD_WITHHELD_PLACEHOLDER;

/** A seen check over the given values, counting its calls. */
function stubCheck(values: string[]): StoreSeenCheck & {
  sizeCalls: number;
  hasCalls: number;
} {
  const fps = new Set(values.map(passwordFingerprint));
  const c = {
    sizeCalls: 0,
    hasCalls: 0,
    size() {
      c.sizeCalls++;
      return fps.size;
    },
    has(fp: string) {
      c.hasCalls++;
      return fps.has(fp);
    },
  };
  return c;
}

// Runs first: the module load of mailbox-passwords.ts (imported above)
// registered its seen check; the leaf tests below replace it with stubs.
describe("with the mailbox registration (temp database)", () => {
  let dbPath: string | null = null;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mc-store-withhold-${process.pid}-${Date.now()}.db`);
    initDatabase(dbPath);
    _resetMailboxPasswords();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    closeDatabase();
    _resetMailboxPasswords();
    for (const suffix of ["", "-wal", "-shm"]) {
      const f = `${dbPath}${suffix}`;
      if (existsSync(f)) unlinkSync(f);
    }
    dbPath = null;
  });

  const shellResult = (pw: string) =>
    JSON.stringify({
      stdout: `verified: IMAP login OK\npassword: ${pw}\nlogin: box@example.test\n`,
      exit_code: 0,
    });

  it("a value the tool printed and this run proved is still withheld in stored text", () => {
    registerMailboxResult(
      "shell_exec",
      { command: "stalwart-inbox verify box@example.test" },
      shellResult(PW),
      "task-store-1",
    );
    expect(provenPasswords("task-store-1").has(passwordFingerprint(PW))).toBe(
      true,
    );
    expect(withholdForStore(`la contraseña es ${PW}`)).toBe(
      `la contraseña es ${P}`,
    );
    forgetProvenPasswords("task-store-1");
  });

  it("a value the tool prints after the first write is withheld on the next write", () => {
    const text = `la contraseña es ${PW}`;
    expect(withholdForStore(text)).toBe(text);
    registerMailboxResult(
      "shell_exec",
      { command: "stalwart-inbox verify box@example.test" },
      shellResult(PW),
      "task-store-2",
    );
    expect(withholdForStore(text)).toBe(`la contraseña es ${P}`);
    forgetProvenPasswords("task-store-2");
  });

  it("the first call loads the seen set lazily from the table", () => {
    getDatabase()
      .prepare("INSERT INTO mailbox_password_seen (fingerprint) VALUES (?)")
      .run(passwordFingerprint(PW));
    expect(withholdForStore(`x ${PW}`)).toBe(`x ${P}`);
  });

  it("before the seen table exists (KB seed during init), nothing is seen and nothing is warned", () => {
    getDatabase().exec("DROP TABLE mailbox_password_seen");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const text = `contraseña: ${PW}`;
    expect(withholdForStore(text)).toBe(text);
    expect(warn).not.toHaveBeenCalled();
  });

  it("a seen table that cannot be read fails towards writing the text as before, warned once", () => {
    getDatabase().exec(
      "DROP TABLE mailbox_password_seen; CREATE TABLE mailbox_password_seen (other TEXT)",
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const text = `contraseña: ${PW}`;
    expect(() => withholdForStore(text)).not.toThrow();
    expect(withholdForStore(text)).toBe(text);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("withholdForStore (leaf)", () => {
  afterEach(() => _resetStoreWithhold());

  it("with no seen check registered, the same string comes back", () => {
    _resetStoreWithhold();
    const text = `contraseña: ${PW}`;
    expect(withholdForStore(text)).toBe(text);
  });

  it("with an empty seen set, the same string comes back after one size check and no lookup", () => {
    const check = stubCheck([]);
    setStoreSeenCheck(check);
    const text = `contraseña: ${PW} y otra ${OTHER}`;
    expect(withholdForStore(text)).toBe(text);
    expect(check.sizeCalls).toBe(1);
    expect(check.hasCalls).toBe(0);
  });

  it("a seen value is replaced in place; an unseen one stays; no line is added", () => {
    setStoreSeenCheck(stubCheck([PW]));
    expect(withholdForStore(`a: ${PW}, b: ${OTHER}.`)).toBe(
      `a: ${P}, b: ${OTHER}.`,
    );
  });

  it("every occurrence is replaced", () => {
    setStoreSeenCheck(stubCheck([PW]));
    expect(withholdForStore(`${PW} ${PW}\n${PW}`)).toBe(`${P} ${P}\n${P}`);
  });

  it("an escaped value inside JSON text is replaced after the escape, and the text still parses", () => {
    setStoreSeenCheck(stubCheck([PW]));
    const json = JSON.stringify({ a: `línea\n${PW}`, b: `é${PW}` });
    const out = withholdForStore(json);
    expect(out).not.toContain(PW);
    expect(JSON.parse(out)).toEqual({ a: `línea\n${P}`, b: `é${P}` });
  });

  it("a seen check that throws: the text is written as before and one warning is logged", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setStoreSeenCheck({
      size: () => {
        throw new Error("seen store unavailable");
      },
      has: () => false,
    });
    const text = `contraseña: ${PW}`;
    expect(withholdForStore(text)).toBe(text);
    expect(withholdForStore(text)).toBe(text);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).not.toContain(PW);
  });

  it("a lookup that throws mid-scan also writes the text as before", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setStoreSeenCheck({
      size: () => 1,
      has: () => {
        throw new Error("seen store unavailable");
      },
    });
    const text = `contraseña: ${PW}`;
    expect(withholdForStore(text)).toBe(text);
  });
});

describe("storeReplacer", () => {
  afterEach(() => _resetStoreWithhold());

  it("JSON round trip: string leaves at any depth are withheld, keys and other leaves are not, and it parses", () => {
    setStoreSeenCheck(stubCheck([PW]));
    const value = {
      [PW]: PW,
      n: 7,
      ok: true,
      none: null,
      list: [PW, `x ${PW}`, 3],
      deep: { a: { b: { c: `contraseña: ${PW}` } } },
    };
    const out = JSON.stringify(value, storeReplacer);
    expect(JSON.parse(out)).toEqual({
      [PW]: P,
      n: 7,
      ok: true,
      none: null,
      list: [P, `x ${P}`, 3],
      deep: { a: { b: { c: `contraseña: ${P}` } } },
    });
  });

  it("with an empty seen set, the output is byte-identical to JSON.stringify", () => {
    setStoreSeenCheck(stubCheck([]));
    const value = { a: PW, b: [1, "x", { c: PW }], d: new Date(0) };
    expect(JSON.stringify(value, storeReplacer)).toBe(JSON.stringify(value));
  });
});

