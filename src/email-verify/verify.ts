/**
 * email-verify — orchestrator. syntax → lists → MX → provider rules →
 * governed SMTP probe (MX failover, catch-all cache, greylist retry) →
 * classification → verdict.
 *
 * Verdict semantics (same contract as the upstream Rust tool so results
 * are comparable):
 *   safe    — server accepted RCPT TO and nothing lowers confidence
 *   risky   — deliverable but disposable / role account / catch-all / full inbox
 *   invalid — bad syntax, no mail host, or server rejected the mailbox
 *   unknown — we could not get a trustworthy answer (blocked, greylisted,
 *             unreachable, cap exhausted, circuit open)
 */

import * as os from "node:os";
import { readFileSync } from "node:fs";
import { createLogger } from "../lib/logger.js";
import { errMsg } from "../lib/err-msg.js";
import { TtlCache } from "./cache.js";
import { classifyEnvelope, classifyRcpt, type ReplyKind, type SmtpReply } from "./classify.js";
import { DEFAULT_GOVERNANCE, Governor, governanceFromEnv, type GovernanceConfig } from "./governance.js";
import { isDisposableDomain, isFreeProvider, isRoleAccount } from "./lists.js";
import { lookupMx, systemMxLookup, type MxHost, type MxLookup, type MxResult } from "./mx.js";
import { rulesFor, type Provider } from "./providers.js";
import { ProbeError, probeMailbox, resolveMxTargets, type ProbeOptions, type ProbeResult } from "./smtp-client.js";
import type { LookupAddress } from "node:dns";
import { checkSyntax, suggestDomain } from "./syntax.js";

const log = createLogger("email-verify");

export type Verdict = "safe" | "risky" | "invalid" | "unknown";

export interface SmtpDetails {
  readonly host: string;
  readonly deliverable: boolean;
  readonly catchAll: boolean;
  readonly fullInbox: boolean;
  readonly disabled: boolean;
  readonly replyCode: number;
  readonly reply: string;
}

export interface VerifyResult {
  readonly email: string;
  readonly verdict: Verdict;
  /** Machine-readable reason, e.g. "deliverable", "mailbox_rejected", "no_mx", "greylisted". */
  readonly reason: string;
  readonly syntax: { readonly valid: boolean; readonly normalized: string | null; readonly suggestion: string | null };
  readonly mx: { readonly acceptsMail: boolean; readonly hosts: readonly string[]; readonly provider: Provider | null };
  readonly smtp: SmtpDetails | null;
  readonly misc: { readonly disposable: boolean; readonly roleAccount: boolean; readonly freeProvider: boolean };
  readonly note: string | null;
  readonly durationMs: number;
}

export interface VerifierOptions {
  readonly heloName?: string;
  readonly fromEmail?: string;
  readonly port?: number;
  /** Per-step SMTP deadline. */
  readonly timeoutMs?: number;
  /** Delay before the single greylist retry. */
  readonly greylistRetryMs?: number;
  /** How many MX hosts to try before giving up. */
  readonly maxMxHosts?: number;
  /** Wall-clock bound for one address across all hosts and retries (default 90 s). */
  readonly maxVerifyMs?: number;
  readonly governance?: GovernanceConfig;
  /** Test seams — real DNS and real sockets by default. */
  readonly mxLookup?: MxLookup;
  readonly probe?: (opts: ProbeOptions) => Promise<ProbeResult>;
  readonly resolveTargets?: (host: string, allowPrivate: boolean) => Promise<LookupAddress[]>;
  readonly allowPrivateAddresses?: boolean;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface VerifyOptions {
  /** Stop after syntax + lists + MX; never open an SMTP connection. */
  readonly skipSmtp?: boolean;
  /** Disable the random-address catch-all probe for this call. */
  readonly catchAllProbe?: boolean;
  /**
   * Wall-clock bound for a whole `verifyMany` call (default 240 s, under the
   * 300 s goal timeout). Rows not started by then return `batch_deadline`.
   */
  readonly maxBatchMs?: number;
}

export interface BatchSummary {
  readonly total: number;
  readonly safe: number;
  readonly risky: number;
  readonly invalid: number;
  readonly unknown: number;
}

const MX_TTL_MS = 60 * 60_000;
const CATCH_ALL_TTL_MS = 6 * 60 * 60_000;
const RESULT_TTL_MS = 24 * 60 * 60_000;

/** `mail.eurekams.net` → `eurekams.net`; a bare host stays as is. */
export function deriveMailDomain(hostname: string): string {
  const labels = hostname.split(".").filter(Boolean);
  return labels.length >= 3 ? labels.slice(1).join(".") : hostname;
}

/**
 * MAIL FROM. Default is `postmaster@<helo domain>`: Microsoft's consumer MX
 * (the largest bucket in MX-Mexico lists) answered the mailbox status for it
 * in the 2026-09-11 live probe and refused a null-sender probe. RFC 5321
 * §4.5.1 requires postmaster@ to exist — it does NOT yet on Stalwart
 * ("550 5.1.2 Mailbox does not exist"), so cPanel/Exim sender-callout hosts
 * answer `blocked` until the operator creates it. `EMAIL_VERIFY_FROM=""`
 * selects the null reverse path `<>` explicitly.
 */
export const NULL_SENDER = "";

/**
 * HELO must be a fully-qualified name (RFC 5321 §4.1.1.1; stock Postfix
 * `reject_non_fqdn_helo_hostname` refuses anything else). `os.hostname()`
 * returns the SHORT name on this box ("mail"), so do what `hostname -f`
 * does — look the short name up in /etc/hosts — without spawning a process
 * on the event loop (audit R5 W-4).
 */
export function discoverFqdn(hostsFile = "/etc/hosts"): string {
  const short = os.hostname();
  if (short.includes(".")) return short;
  let hosts = "";
  try {
    hosts = readFileSync(hostsFile, "utf8");
  } catch {
    return short;
  }
  for (const raw of hosts.split("\n")) {
    const line = raw.split("#")[0].trim();
    if (!line) continue;
    const names = line.split(/\s+/).slice(1);
    if (names.includes(short)) {
      const fqdn = names.find((n) => n.includes("."));
      if (fqdn) return fqdn;
    }
  }
  return short;
}

const BOGUS_HOST_RE = /(^|\.)(localhost|localdomain|local|internal|invalid|lan|home|example|test)$|^\(none\)$|^\[/i;

/** Why the verifier must not probe with these envelope settings; null when fine. */
export function envelopeConfigError(heloName: string, fromEmail: string): string | null {
  if (!heloName.includes(".") || BOGUS_HOST_RE.test(heloName)) {
    return `HELO name "${heloName}" is not a public fully-qualified name; set EMAIL_VERIFY_HELO=<fqdn>`;
  }
  if (fromEmail !== NULL_SENDER) {
    const syn = checkSyntax(fromEmail);
    if (!syn.isValid || BOGUS_HOST_RE.test(syn.domain)) {
      return `MAIL FROM "${fromEmail}" is not a routable address; set EMAIL_VERIFY_FROM=<mailbox> or "" for the null sender`;
    }
  }
  return null;
}

export function verifierOptionsFromEnv(): VerifierOptions {
  const heloName = process.env.EMAIL_VERIFY_HELO?.trim() || discoverFqdn();
  const fromEnv = process.env.EMAIL_VERIFY_FROM;
  const fromEmail = fromEnv === undefined ? `postmaster@${deriveMailDomain(heloName)}` : fromEnv.trim() || NULL_SENDER;
  const timeoutMs = Number.parseInt(process.env.EMAIL_VERIFY_TIMEOUT_MS ?? "", 10);
  return {
    heloName,
    fromEmail,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined,
    governance: governanceFromEnv(),
  };
}

interface Attempt {
  kind: ReplyKind | "unreachable" | "cap_exhausted" | "deadline";
  host: string;
  reply: SmtpReply | null;
  catchAll: boolean | null;
  error: string | null;
}

export class EmailVerifier {
  private readonly heloName: string;
  private readonly fromEmail: string;
  private readonly port: number;
  private readonly timeoutMs: number;
  private readonly greylistRetryMs: number;
  private readonly maxMxHosts: number;
  private readonly maxVerifyMs: number;
  /** Non-null ⇒ every SMTP probe is refused with reason `misconfigured`. */
  readonly configError: string | null;
  private readonly mxLookup: MxLookup;
  private readonly probe: (opts: ProbeOptions) => Promise<ProbeResult>;
  private readonly resolveTargets: (host: string, allowPrivate: boolean) => Promise<LookupAddress[]>;
  private readonly allowPrivateAddresses: boolean;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  readonly governor: Governor;
  private readonly mxCache: TtlCache<MxResult>;
  private readonly catchAllCache: TtlCache<boolean>;
  private readonly resultCache: TtlCache<VerifyResult>;

  constructor(opts: VerifierOptions = {}) {
    this.heloName = opts.heloName ?? discoverFqdn();
    this.fromEmail = opts.fromEmail ?? `postmaster@${deriveMailDomain(this.heloName)}`;
    this.configError = envelopeConfigError(this.heloName, this.fromEmail);
    if (this.configError) log.error({ helo: this.heloName, from: this.fromEmail }, `email-verify disabled: ${this.configError}`);
    this.port = opts.port ?? 25;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.greylistRetryMs = opts.greylistRetryMs ?? 2_000;
    this.maxMxHosts = opts.maxMxHosts ?? 3;
    this.maxVerifyMs = opts.maxVerifyMs ?? 90_000;
    this.mxLookup = opts.mxLookup ?? systemMxLookup;
    this.probe = opts.probe ?? probeMailbox;
    this.resolveTargets = opts.resolveTargets ?? resolveMxTargets;
    this.allowPrivateAddresses = opts.allowPrivateAddresses ?? false;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.governor = new Governor(opts.governance ?? DEFAULT_GOVERNANCE, this.now, this.sleep);
    this.mxCache = new TtlCache(MX_TTL_MS, 5000, this.now);
    this.catchAllCache = new TtlCache(CATCH_ALL_TTL_MS, 5000, this.now);
    this.resultCache = new TtlCache(RESULT_TTL_MS, 20_000, this.now);
  }

  clearCaches(): void {
    this.mxCache.clear();
    this.catchAllCache.clear();
    this.resultCache.clear();
  }

  private async mx(domain: string): Promise<MxResult> {
    const hit = this.mxCache.get(domain);
    if (hit) return hit;
    const res = await lookupMx(domain, this.mxLookup);
    // Do not cache transient DNS errors.
    if (res.reason !== "dns_error") this.mxCache.set(domain, res);
    return res;
  }

  async verify(input: string, options: VerifyOptions = {}): Promise<VerifyResult> {
    const start = this.now();
    const finish = (r: Omit<VerifyResult, "durationMs">): VerifyResult => ({ ...r, durationMs: this.now() - start });

    const syntax = checkSyntax(input);
    const base = {
      email: syntax.normalized ?? input.trim(),
      syntax: { valid: syntax.isValid, normalized: syntax.normalized, suggestion: null as string | null },
      mx: { acceptsMail: false, hosts: [] as string[], provider: null as Provider | null },
      smtp: null as SmtpDetails | null,
      misc: { disposable: false, roleAccount: false, freeProvider: false },
      note: null as string | null,
    };
    if (!syntax.isValid || !syntax.normalized) {
      return finish({ ...base, verdict: "invalid", reason: `syntax: ${syntax.reason}` });
    }
    const email = syntax.normalized;
    const cached = this.resultCache.get(email);
    if (cached && !options.skipSmtp) return cached;

    const misc = {
      disposable: isDisposableDomain(syntax.domain),
      roleAccount: isRoleAccount(syntax.localPart),
      freeProvider: isFreeProvider(syntax.domain),
    };
    base.misc = misc;
    if (misc.disposable) {
      // A disposable mailbox is never worth an SMTP probe: it exists today and not tomorrow.
      return finish({ ...base, verdict: "risky", reason: "disposable_domain" });
    }

    const mx = await this.mx(syntax.domain);
    base.mx = { acceptsMail: mx.hosts.length > 0, hosts: mx.hosts.map((h) => h.exchange), provider: null };
    if (mx.hosts.length === 0) {
      base.syntax.suggestion = suggestDomain(syntax.localPart, syntax.domain);
      if (mx.reason === "dns_error") return finish({ ...base, verdict: "unknown", reason: "dns_error" });
      return finish({ ...base, verdict: "invalid", reason: mx.reason ?? "no_mx" });
    }
    const rules = rulesFor(mx.hosts[0].exchange, syntax.domain);
    base.mx.provider = rules.provider;
    base.note = rules.note;

    if (options.skipSmtp) {
      const verdict: Verdict = misc.roleAccount ? "risky" : "unknown";
      return finish({ ...base, verdict, reason: "smtp_skipped" });
    }

    if (this.configError) {
      return finish({ ...base, verdict: "unknown", reason: `misconfigured: ${this.configError}` });
    }
    if (this.governor.breakerOpen()) {
      return finish({ ...base, verdict: "unknown", reason: "circuit_open" });
    }
    if (this.governor.remainingToday() === 0) {
      return finish({ ...base, verdict: "unknown", reason: "daily_cap_reached" });
    }
    const release = await this.governor.acquire();
    let attempt: Attempt;
    try {
      attempt = await this.probeWithFailover(email, syntax.domain, mx.hosts, {
        skipCatchAll: rules.skipCatchAll || options.catchAllProbe === false,
        timeoutMs: Math.max(this.timeoutMs, rules.minTimeoutMs),
        deadline: this.now() + Math.max(this.maxVerifyMs, rules.minTimeoutMs * 2),
      });
    } finally {
      release();
    }

    if (attempt.kind !== "accepted") base.syntax.suggestion = suggestDomain(syntax.localPart, syntax.domain);
    const result = finish(this.toResult(base, misc, attempt));
    if (result.verdict !== "unknown") this.resultCache.set(email, result);
    return result;
  }

  private async probeWithFailover(
    email: string,
    domain: string,
    hosts: readonly MxHost[],
    cfg: { skipCatchAll: boolean; timeoutMs: number; deadline: number },
  ): Promise<Attempt> {
    let last: Attempt = { kind: "unreachable", host: hosts[0].exchange, reply: null, catchAll: null, error: "no MX host tried" };
    const cachedCatchAll = this.catchAllCache.get(domain);

    /**
     * One governed connection: resolves first (a dead DNS name costs no
     * budget), then charges the cap, paces the host, and clips the probe's
     * total budget to the deadline.
     */
    const connectAndProbe = async (opts: ProbeOptions): Promise<ProbeResult | Attempt> => {
      const unreachable = (error: string): Attempt => ({ kind: "unreachable", host: opts.host, reply: null, catchAll: null, error });
      if (cfg.deadline - this.now() <= 0) return { kind: "deadline", host: opts.host, reply: null, catchAll: null, error: "verify deadline exceeded" };
      let addresses: LookupAddress[];
      try {
        addresses = opts.addresses ? [...opts.addresses] : await this.resolveTargets(opts.host, this.allowPrivateAddresses);
      } catch (err) {
        const msg = err instanceof ProbeError ? `${err.stage}: ${err.message}` : errMsg(err);
        log.debug({ email, host: opts.host, err: msg }, "MX host not resolvable");
        return unreachable(msg);
      }
      if (this.governor.remainingToday() === 0) {
        return { kind: "cap_exhausted", host: opts.host, reply: null, catchAll: null, error: "daily cap reached" };
      }
      await this.governor.paceHost(opts.host);
      const totalBudgetMs = cfg.deadline - this.now();
      if (totalBudgetMs <= 0) return { kind: "deadline", host: opts.host, reply: null, catchAll: null, error: "verify deadline exceeded" };
      // Charge only now: DNS, pacing and the deadline can all end the attempt without a packet.
      if (!this.governor.chargeConnection()) {
        return { kind: "cap_exhausted", host: opts.host, reply: null, catchAll: null, error: "daily cap reached" };
      }
      try {
        return await this.probe({ ...opts, addresses, totalBudgetMs, timeoutMs: Math.min(opts.timeoutMs, totalBudgetMs) });
      } catch (err) {
        if (err instanceof ProbeError && err.code === "budget") {
          return { kind: "deadline", host: opts.host, reply: null, catchAll: null, error: `verify deadline exceeded at ${err.stage}` };
        }
        const msg = err instanceof ProbeError ? `${err.stage}: ${err.message}` : errMsg(err);
        log.debug({ email, host: opts.host, err: msg }, "probe failed");
        return unreachable(msg);
      }
    };
    const isAttempt = (x: ProbeResult | Attempt): x is Attempt => "kind" in x;

    for (const mxHost of hosts.slice(0, this.maxMxHosts)) {
      const host = mxHost.exchange;
      const probeOpts: ProbeOptions = {
        host,
        port: this.port,
        heloName: this.heloName,
        fromEmail: this.fromEmail,
        toEmail: email,
        domain,
        skipCatchAll: cfg.skipCatchAll || cachedCatchAll !== undefined,
        timeoutMs: cfg.timeoutMs,
        allowPrivateAddresses: this.allowPrivateAddresses,
      };

      const res = await connectAndProbe(probeOpts);
      if (isAttempt(res)) {
        last = res;
        if (res.kind === "cap_exhausted" || res.kind === "deadline") return last;
        continue; // unreachable: next host
      }

      if (res.envelopeFailure) {
        last = this.envelopeAttempt(host, res.envelopeFailure.reply, email);
        if (last.kind === "blocked") return last;
        continue; // busy / greylisted at envelope: next host
      }

      let catchAll = cachedCatchAll ?? null;
      if (res.catchAll) {
        // Only a definite answer is evidence; a 4xx on the random address leaves the cache alone (audit W3).
        const k = classifyRcpt(res.catchAll);
        if (k === "accepted") catchAll = true;
        else if (k === "invalid" || k === "unknown_reply") catchAll = false;
        if (catchAll !== null) this.catchAllCache.set(domain, catchAll);
      }
      if (!res.rcpt) {
        last = { kind: "unreachable", host, reply: null, catchAll, error: "no RCPT reply" };
        continue;
      }
      let rcptReply = res.rcpt;
      let kind = classifyRcpt(rcptReply);
      last = { kind, host, reply: rcptReply, catchAll, error: null };

      if (kind === "greylisted") {
        await this.sleep(this.greylistRetryMs);
        const retry = await connectAndProbe({ ...probeOpts, skipCatchAll: true });
        if (isAttempt(retry)) {
          last = retry;
          if (retry.kind === "cap_exhausted" || retry.kind === "deadline") return retry;
          continue;
        }
        if (retry.envelopeFailure) {
          last = this.envelopeAttempt(host, retry.envelopeFailure.reply, email);
          if (last.kind === "blocked") return last;
          continue;
        }
        if (!retry.rcpt) continue;
        rcptReply = retry.rcpt;
        kind = classifyRcpt(rcptReply);
        last = { kind, host, reply: rcptReply, catchAll, error: null };
      }

      if (kind === "temp_failure" || kind === "greylisted") continue;
      // A 4xx about us is still "blocked" (stop this address) but not a strike: prose-heavy
      // greylisters must not be able to open the breaker (audit R4 W-2).
      if (kind === "blocked" && rcptReply.code >= 500) this.governor.recordBlocked();
      return last;
    }
    return last;
  }

  private envelopeAttempt(host: string, reply: SmtpReply, email: string): Attempt {
    const kind = classifyEnvelope(reply);
    if (kind === "blocked") {
      if (reply.code >= 500) this.governor.recordBlocked();
      // Address only at debug: the journal is not a place for prospect lists.
      log.warn({ host, code: reply.code, reply: reply.text }, "MX refused our envelope");
      log.debug({ email, host }, "envelope refused for address");
    }
    return { kind, host, reply, catchAll: null, error: null };
  }

  private toResult(
    base: Omit<VerifyResult, "verdict" | "reason" | "durationMs">,
    misc: VerifyResult["misc"],
    a: Attempt,
  ): Omit<VerifyResult, "durationMs"> {
    const reply = a.reply;
    const details = (deliverable: boolean, extra: Partial<SmtpDetails> = {}): SmtpDetails => ({
      host: a.host,
      deliverable,
      catchAll: a.catchAll ?? false,
      fullInbox: false,
      disabled: false,
      replyCode: reply?.code ?? 0,
      reply: reply?.text ?? "",
      ...extra,
    });

    switch (a.kind) {
      case "accepted": {
        const smtp = details(true);
        const risky = misc.roleAccount || smtp.catchAll;
        return {
          ...base,
          smtp,
          verdict: risky ? "risky" : "safe",
          reason: smtp.catchAll ? "catch_all_domain" : misc.roleAccount ? "role_account" : "deliverable",
        };
      }
      case "invalid":
        return { ...base, smtp: details(false), verdict: "invalid", reason: "mailbox_rejected" };
      case "disabled":
        return { ...base, smtp: details(false, { disabled: true }), verdict: "invalid", reason: "mailbox_disabled" };
      case "full_inbox":
        return { ...base, smtp: details(false, { fullInbox: true }), verdict: "risky", reason: "full_inbox" };
      case "blocked":
        return { ...base, smtp: details(false), verdict: "unknown", reason: "blocked_by_host" };
      case "greylisted":
        return { ...base, smtp: details(false), verdict: "unknown", reason: "greylisted" };
      case "temp_failure":
        return { ...base, smtp: details(false), verdict: "unknown", reason: "temporary_failure" };
      case "unknown_reply":
        return { ...base, smtp: details(false), verdict: "unknown", reason: "unrecognized_reply" };
      case "unreachable":
        return { ...base, smtp: null, verdict: "unknown", reason: `smtp_unreachable: ${a.error ?? "unknown"}` };
      case "cap_exhausted":
        return { ...base, smtp: null, verdict: "unknown", reason: "daily_cap_reached" };
      case "deadline":
        return { ...base, smtp: null, verdict: "unknown", reason: "verify_deadline" };
    }
  }

  /**
   * Verify many addresses. Addresses are de-duplicated and interleaved by
   * domain so the same MX host is never hit back-to-back; `concurrency`
   * workers pull from that queue.
   */
  async verifyMany(inputs: readonly string[], options: VerifyOptions = {}): Promise<{ results: VerifyResult[]; summary: BatchSummary }> {
    const seen = new Set<string>();
    const byDomain = new Map<string, string[]>();
    for (const raw of inputs) {
      const s = checkSyntax(raw);
      const key = s.normalized ?? raw.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const domain = s.isValid ? s.domain : "";
      byDomain.set(domain, [...(byDomain.get(domain) ?? []), raw]);
    }
    const queue: string[] = [];
    const groups = [...byDomain.values()];
    for (let i = 0; groups.some((g) => i < g.length); i++) {
      for (const g of groups) if (i < g.length) queue.push(g[i]);
    }

    const results: VerifyResult[] = new Array(queue.length);
    const batchDeadline = this.now() + (options.maxBatchMs ?? 240_000);
    const skipped = (input: string, reason: string): VerifyResult => {
      const syn = checkSyntax(input);
      return {
      email: syn.normalized ?? input.trim().toLowerCase(),
      verdict: "unknown",
      reason,
      syntax: { valid: syn.isValid, normalized: syn.normalized, suggestion: null },
      mx: { acceptsMail: false, hosts: [], provider: null },
      smtp: null,
      misc: { disposable: false, roleAccount: false, freeProvider: false },
      note: null,
      durationMs: 0,
      };
    };
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const idx = next++;
        if (idx >= queue.length) return;
        if (this.now() >= batchDeadline) {
          results[idx] = skipped(queue[idx], "batch_deadline");
          continue;
        }
        try {
          results[idx] = await this.verify(queue[idx], options);
        } catch (err) {
          // A seam or bug must not sink the whole batch: report the row as unknown.
          log.error({ err: errMsg(err) }, "verify threw");
          results[idx] = skipped(queue[idx], `internal_error: ${errMsg(err)}`);
        }
      }
    };
    await Promise.all(Array.from({ length: this.governor.config.concurrency }, worker));

    const summary = results.reduce<BatchSummary>(
      (acc, r) => ({ ...acc, [r.verdict]: acc[r.verdict] + 1 }),
      { total: results.length, safe: 0, risky: 0, invalid: 0, unknown: 0 },
    );
    return { results, summary };
  }
}

let shared: EmailVerifier | null = null;

/** Process-wide verifier (one governor, one set of caches). */
export function getSharedVerifier(): EmailVerifier {
  shared ??= new EmailVerifier(verifierOptionsFromEnv());
  return shared;
}
