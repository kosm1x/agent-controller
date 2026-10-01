/**
 * Host singleton guard — one mission-control process per database.
 *
 * A second process pointed at the same DB (`node dist/index.js`, `npm run
 * dev`, an agent session) would otherwise run reconcileOrphanedTasks() at
 * boot and fail every in-flight task of the live service before noticing the
 * HTTP port is taken — and with a different MC_PORT it never notices at all.
 *
 * The lock is a Linux abstract unix socket named from the real DB path.
 * Abstract sockets vanish with the owning process, so there is no stale lock
 * file and no pid-reuse problem.
 */

import { createHash } from "crypto";
import { createServer, type Server } from "net";
import { realpathSync } from "fs";
import { basename, dirname, join, resolve } from "path";

/**
 * The real path of the DB, so symlinked aliases share one lock. On first boot
 * the file may not exist yet: realpath its directory and append the basename.
 */
function realDbPath(dbPath: string): string {
  const resolved = resolve(dbPath);
  try {
    return realpathSync(resolved);
  } catch {
    try {
      return join(realpathSync(dirname(resolved)), basename(resolved));
    } catch {
      return resolved;
    }
  }
}

/**
 * Bind the per-DB singleton socket. Resolves the server (keep a reference for
 * the process lifetime) or null when the platform cannot provide the guard
 * (fail-open: a guard bug must never keep the real service from booting).
 * Rejects when another live process already holds this database.
 */
export function acquireSingleInstance(dbPath: string): Promise<Server | null> {
  const resolved = realDbPath(dbPath);
  const name =
    "\0mission-control:" +
    createHash("sha256").update(resolved).digest("hex").slice(0, 16);

  return new Promise((resolvePromise, reject) => {
    const server = createServer((socket) => socket.destroy());
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `Another mission-control instance already holds database ${resolved} — exiting without touching it`,
          ),
        );
      } else {
        console.warn(
          `[boot] single-instance guard unavailable: ${err.code ?? err.message}`,
        );
        resolvePromise(null);
      }
    });
    server.once("listening", () => {
      server.unref();
      resolvePromise(server);
    });
    server.listen(name);
  });
}
