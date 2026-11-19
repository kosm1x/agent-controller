/**
 * The runners' image pre-flights — `docker image inspect` for presence and for
 * the lockfile label — run as async children (MCEventLoopBlock): they ran sync
 * on the service's event loop before every container task, with no timeout.
 * A separate file because container.test.ts uses the real execFile. No process
 * starts: the child is mocked and settles on a later tick.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const child = vi.hoisted(() => ({
  impl: vi.fn<(...args: unknown[]) => unknown>(),
  stdinEnds: [] as Array<ReturnType<typeof vi.fn>>,
}));
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  const { promisify } = await import("util");
  return {
    ...actual,
    execFileSync: () => {
      throw new Error("refused: sync child in this test");
    },
    execFile: Object.assign(vi.fn(), {
      [promisify.custom]: (...args: unknown[]) => {
        const end = vi.fn();
        child.stdinEnds.push(end);
        let out: unknown;
        let err: unknown;
        try {
          out = child.impl(...args);
        } catch (e) {
          err = e;
        }
        const settled = new Promise((res, rej) =>
          setImmediate(() => (err ? rej(err) : res({ stdout: out, stderr: "" }))),
        );
        return Object.assign(settled, { child: { stdin: { end } } });
      },
    }),
  };
});
vi.mock("../config.js", () => ({
  getConfig: () => ({ heavyRunnerImage: "img:test" }),
}));

import {
  IMAGE_LOCK_LABEL,
  imageExistsLocally,
  imageLockDrift,
  imageLockLabel,
} from "./container.js";

const noImage = () => {
  throw Object.assign(
    new Error("Command failed: docker image inspect x\nError: No such image: x"),
    { code: 1 },
  );
};

/** What execFile rejects with when its timeout kills the child. */
const timedOut = () => {
  throw Object.assign(new Error("Command failed: docker image inspect img"), {
    killed: true,
    signal: "SIGTERM",
    code: null,
  });
};

beforeEach(() => {
  child.impl.mockReset();
  child.stdinEnds.length = 0;
});

describe("imageExistsLocally — async docker image inspect", () => {
  it("true when inspect exits 0; argv unchanged, no shell, stdin closed", async () => {
    child.impl.mockReturnValueOnce("[{}]");
    expect(await imageExistsLocally("mission-control:latest")).toBe(true);
    expect(child.impl).toHaveBeenCalledTimes(1);
    expect(child.impl.mock.calls[0]).toEqual([
      "docker",
      ["image", "inspect", "mission-control:latest"],
      { timeout: 10_000 },
    ]);
    expect(child.stdinEnds[0]).toHaveBeenCalledTimes(1);
  });

  it("false when inspect fails (image absent, daemon down)", async () => {
    child.impl.mockImplementationOnce(noImage);
    expect(await imageExistsLocally("x")).toBe(false);
  });
});

describe("imageLockLabel — async docker image inspect --format", () => {
  it("returns the trimmed label value", async () => {
    child.impl.mockReturnValueOnce(`${"c".repeat(64)}\n`);
    expect(await imageLockLabel("img")).toBe("c".repeat(64));
    expect(child.impl.mock.calls[0]).toEqual([
      "docker",
      [
        "image",
        "inspect",
        "img",
        "--format",
        `{{index .Config.Labels "${IMAGE_LOCK_LABEL}"}}`,
      ],
      { encoding: "utf8", timeout: 10_000 },
    ]);
    expect(child.stdinEnds[0]).toHaveBeenCalledTimes(1);
  });

  it("null for an empty label and for a failed inspect", async () => {
    child.impl.mockReturnValueOnce("\n").mockImplementationOnce(noImage);
    expect(await imageLockLabel("img")).toBeNull();
    expect(await imageLockLabel("img")).toBeNull();
  });

  it("imageLockDrift reads the label through it by default", async () => {
    const host = "a".repeat(64);
    child.impl.mockReturnValueOnce(`${"b".repeat(64)}\n`);
    expect(await imageLockDrift("img", { host })).toEqual({
      host,
      image: "b".repeat(64),
    });
    child.impl.mockReturnValueOnce(`${host}\n`);
    expect(await imageLockDrift("img", { host })).toBeNull();
  });
});

// A hung daemon no longer blocks the loop, so without a timeout a runner task
// would wait forever; with it, a timeout must fail CLOSED at both pre-flights.
describe("docker inspect timeout fails closed", () => {
  it("imageExistsLocally → false (the runner refuses: image not found)", async () => {
    child.impl.mockImplementationOnce(timedOut);
    expect(await imageExistsLocally("img")).toBe(false);
  });

  it("imageLockDrift → drift with image: null (the runner refuses), never 'no drift'", async () => {
    const host = "a".repeat(64);
    child.impl.mockImplementationOnce(timedOut);
    expect(await imageLockDrift("img", { host })).toEqual({ host, image: null });
  });
});
