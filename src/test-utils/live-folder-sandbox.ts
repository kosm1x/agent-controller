/**
 * Test helper, not a test file: the `fs` module a video test installs with
 * `vi.mock("fs")` so that no call can reach the service's live video folders.
 *
 * - The calls the cases need are mapped. A path under a live folder becomes
 *   `<root>/<sub>/...` in the test's throwaway tree (`existsSync`, `statSync`),
 *   and `mkdirSync`, `writeFileSync` and `rmSync` are refused for any target
 *   outside that tree. These five take string paths only.
 * - Every other function and class, and every `promises` function, is refused
 *   when one of its first two arguments (a string, a file URL or a Buffer)
 *   names a path under a live folder; anywhere else it is the real one.
 * - A live path while the throwaway root is unset or missing is refused, never
 *   recreated, so a broken mapping fails the case instead of reaching a live
 *   folder.
 * - `fs/promises` (any spelling) gets the same guard through
 *   `liveFolderSandboxPromises`; a test mocks it next to `fs`, because a
 *   module that imports it by name does not go through the `fs` mock.
 *
 * Limits:
 * - A path is recognised by its text (after resolving `.` and `..`), not by
 *   where it leads: a symbolic link that points into a live folder is not
 *   recognised, so a test must never create one.
 * - A refused call throws at once, also for callback-style and promise-style
 *   functions: the error is not passed to the callback nor returned as a
 *   rejected promise.
 *
 * It never imports `fs`: the caller passes the real module from
 * `importOriginal`, so the helper cannot pick up the mock it builds.
 */

import path from "path";
import { fileURLToPath } from "url";

/** Live folder → its stand-in under the throwaway root. */
export const LIVE_VIDEO_FOLDERS: Readonly<Record<string, string>> = {
  "/tmp/video-jobs": "video-jobs",
  "/root/tmp-video-frames": "video-frames",
  "/root/tmp-video-html": "video-html",
};

const MAPPED_READS = ["existsSync", "statSync"];
const MAPPED_WRITES = ["mkdirSync", "writeFileSync", "rmSync"];

type Fn = (...args: unknown[]) => unknown;

const under = (p: string, dir: string): boolean =>
  p === dir || p.startsWith(`${dir}/`);

function liveFolderOf(p: string): string | undefined {
  const abs = path.resolve(p);
  return Object.keys(LIVE_VIDEO_FOLDERS).find((dir) => under(abs, dir));
}

function asPath(arg: unknown): string | undefined {
  if (typeof arg === "string") return arg;
  if (arg instanceof URL) {
    return arg.protocol === "file:" ? fileURLToPath(arg) : undefined;
  }
  if (Buffer.isBuffer(arg)) return arg.toString();
  return undefined;
}

function refuseLive(name: string, args: unknown[]): void {
  for (const arg of args.slice(0, 2)) {
    const p = asPath(arg);
    if (p !== undefined && liveFolderOf(p)) {
      throw new Error(`refused: fs.${name} on a live video folder: ${p}`);
    }
  }
}

// Calls and `new` are checked; own function properties (realpathSync.native)
// are guarded the same way.
function guard(name: string, fn: Fn): Fn {
  return new Proxy(fn, {
    apply(target, thisArg, args: unknown[]) {
      refuseLive(name, args);
      return Reflect.apply(target, thisArg, args);
    },
    construct(target, args: unknown[], newTarget) {
      refuseLive(name, args);
      return Reflect.construct(target, args, newTarget) as object;
    },
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === "function" &&
        Object.prototype.hasOwnProperty.call(target, prop)
        ? guard(`${name}.${String(prop)}`, value as Fn)
        : value;
    },
  });
}

function guardAll(obj: object, prefix: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    out[key] =
      typeof value === "function" ? guard(prefix + key, value as Fn) : value;
  }
  return out;
}

export function liveFolderSandboxFs<T extends object>(
  real: T,
  sandbox: { root: string },
): T {
  const fs = real as unknown as Record<string, Fn> & { promises: object };
  const map = (name: string, p: unknown): string => {
    if (typeof p !== "string") {
      throw new Error(`refused: fs.${name} with a non-string path`);
    }
    const live = liveFolderOf(p);
    if (!live) return p;
    if (!sandbox.root || !fs.existsSync(sandbox.root)) {
      throw new Error(`refused: no throwaway root for ${path.resolve(p)}`);
    }
    return path.join(
      sandbox.root,
      LIVE_VIDEO_FOLDERS[live],
      path.relative(live, path.resolve(p)),
    );
  };

  const out = guardAll(real, "");
  for (const name of MAPPED_READS) {
    out[name] = (p: unknown, ...rest: unknown[]) => fs[name](map(name, p), ...rest);
  }
  for (const name of MAPPED_WRITES) {
    out[name] = (p: unknown, ...rest: unknown[]) => {
      const target = map(name, p);
      if (!sandbox.root || !under(path.resolve(target), sandbox.root)) {
        throw new Error(`refused: fs.${name} outside the throwaway root: ${target}`);
      }
      return fs[name](target, ...rest);
    };
  }
  out.promises = guardAll(fs.promises, "promises.");
  out.default = out;
  return out as T;
}

/** The `fs/promises` module for a test's `vi.mock("fs/promises")`. */
export function liveFolderSandboxPromises<T extends object>(real: T): T {
  const out = guardAll(real, "promises.");
  out.default = out;
  return out as T;
}
