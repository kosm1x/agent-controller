/**
 * X-poster barrel + router factory (multi-account).
 *
 * `getXRouter(account)` resolves a handle → [cookie, api] backends for THAT
 * account. Build fresh per call so env edits (cookie rotation, arming the API
 * backend, adding an account) take effect on the next post without a restart.
 */

import { XPostRouter } from "./router.js";
import { CookieBackend } from "./cookie-backend.js";
import { ApiBackend } from "./api-backend.js";
import { resolveAccount, listXAccounts, getAccountCreds } from "./config.js";
import type { RouterProbe } from "./types.js";

export { XPostRouter } from "./router.js";
export { CookieBackend } from "./cookie-backend.js";
export { ApiBackend } from "./api-backend.js";
export * from "./types.js";
export * from "./config.js";

/**
 * Router for one account. `account` is resolved (explicit → default → sole).
 * Returns null when no account can be resolved (none configured / ambiguous).
 */
export function getXRouter(account?: string): XPostRouter | null {
  const handle = resolveAccount(account);
  if (!handle) return null;
  // Unknown/unconfigured handle → null so the tool surfaces noAccountError with the
  // real configured list, rather than a backend "X_AUTH_TOKEN__<typo> unset" error.
  if (!getAccountCreds(handle)) return null;
  return new XPostRouter([new CookieBackend(handle), new ApiBackend(handle)]);
}

/** Probe every configured account → { account, probe } per account. */
export async function probeAllAccounts(): Promise<
  Array<{ account: string; probe: RouterProbe }>
> {
  const accounts = listXAccounts();
  return Promise.all(
    accounts.map(async (account) => {
      const router = new XPostRouter([
        new CookieBackend(account),
        new ApiBackend(account),
      ]);
      return { account, probe: await router.probe() };
    }),
  );
}
