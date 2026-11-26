/**
 * The Agent SDK's native helper, resolved once per process.
 *
 * Without `pathToClaudeCodeExecutable` the SDK looks for its helper on each
 * `query()`, and on linux it first calls `process.report.getReport()` to
 * choose between the glibc and musl packages. That report is synchronous and
 * does reverse name lookups for the open sockets on the main thread.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

export interface HelperPathDeps {
  platform: NodeJS.Platform;
  arch: string;
  /** Module resolution as the SDK does it; throws when the request is absent. */
  resolve: (request: string) => string;
  exists: (path: string) => boolean;
}

/** The SDK's own resolution: a require anchored at the SDK package. */
function defaultDeps(): HelperPathDeps {
  return {
    platform: process.platform,
    arch: process.arch,
    resolve: (request) => {
      const sdkEntry = createRequire(import.meta.url).resolve(SDK_PACKAGE);
      return createRequire(sdkEntry).resolve(request);
    },
    exists: existsSync,
  };
}

/** The helper path when exactly one of the two linux candidates exists;
 *  otherwise undefined, and the SDK decides by itself. */
export function findSdkHelperPath(deps: HelperPathDeps): string | undefined {
  if (deps.platform !== "linux") return undefined;
  const found: string[] = [];
  for (const pkg of [
    `${SDK_PACKAGE}-linux-${deps.arch}`,
    `${SDK_PACKAGE}-linux-${deps.arch}-musl`,
  ]) {
    let path: string;
    try {
      path = deps.resolve(`${pkg}/claude`);
    } catch {
      // A candidate that does not resolve is absent, as in the SDK.
      continue;
    }
    if (deps.exists(path)) found.push(path);
  }
  return found.length === 1 ? found[0] : undefined;
}

let memo: { path: string | undefined } | undefined;

/** `findSdkHelperPath` computed on the first call of the process. */
export function sdkHelperPath(deps?: HelperPathDeps): string | undefined {
  if (!memo) {
    const d = deps ?? defaultDeps();
    memo = { path: findSdkHelperPath(d) };
    if (memo.path === undefined && d.platform === "linux") {
      console.warn(
        "[claude-sdk] native helper not resolved; the SDK will look it up on each query",
      );
    }
  }
  return memo.path;
}

/** Keeps the network section, and its name lookups, out of diagnostic
 *  reports of this process. */
export function excludeNetworkFromReports(): void {
  const report = process.report as { excludeNetwork?: boolean } | undefined;
  if (report) report.excludeNetwork = true;
}
