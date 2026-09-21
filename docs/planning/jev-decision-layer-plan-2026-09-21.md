# Jev decision layer — plan (2026-09-21, rev 2)

**Status:** DRAFT rev 2.2 — Phase B harness built (`1fd0f1a`), audited twice and dry-run; the operator's key answers (09-21 one-question probe: HTTP 200 in 0.32 s, 313 input tokens billed); the 400-message replay has NOT run; nothing in the live path. Rev 1 (`fa3db57`) was reviewed the same day against the Hermes ecosystem and against our own journal; the review **removed rev 1's headline benefit** (§3) and reordered the phases. Supersedes `jarvis-kb/projects/agent-controller/jev-implementation-plan.md` (09-17).
**Goal:** let Jarvis use TypeSafe's Jev for small typed decisions **next to** the Claude models, without touching how Claude generates, plans or calls tools.

## 1. What Jev is

Verified 2026-09-21 against `docs.typesafe.ai` and the live endpoint:

| Fact | Value |
| --- | --- |
| Endpoint | `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <key>` |
| Model | `jev-1.13.0` (`jev-latest` alias) |
| Primitives | `noul` → probability 0–1 (**no confidence field**) · `choice` → `choice` + `probabilities` + `confidence` · `score` → same |
| Not available | multi-select, text generation, tool calling, images |
| Batching | questions in one request are answered independently; `state` is billed once (vendor cookbook: 13 questions over a 54k-char document, 0.27 s batched vs 2.71 s as 13 calls) |
| Limits | 64k tokens/request (32k `state`), 255 options per choice, 1,200 req/min ("can change without notice") |
| Price | $0.042 / MTok input, output free |
| Latency | vendor claims 70–500 ms; one community measurement: 419 ms mean over **4** calls. We measure our own. |
| Calibration | "calibrated" is asserted; the docs publish no calibration measurement. `confidence` is "a statistic computed from the probability distribution". Vendor advice: conservative thresholds, tuned on your own data. |
| Documented weaknesses | literal reading of negations and scoping words · accuracy falls as `state` grows with unrelated content · "content written to adversarially steer the model can move the answer" · English best, other languages "not equally well" |
| Data | privacy policy: no training on user data; zero retention is enterprise-only; retention terms are in their DPA (not yet read) |
| Vendor age | npm package created 2026-09-12, repo 2026-09-04 |

## 2. How the Hermes ecosystem uses it (research, 2026-09-21)

| Source | What it does | What it teaches us |
| --- | --- | --- |
| NousResearch/hermes-agent issue #113837 + PR #113847 (both **open**, P3, no maintainer review) | Registers Jev as a **credential-only** provider: `TYPESAFE_API_KEY` discovery in setup/auth/doctor. Tests assert Jev is **not** in the chat-model picker; aux/compression must not default to it. Consumers stay out-of-tree. A wider "DecisionProvider runtime" RFC (#113008) is explicitly out of scope; an in-core computer-use decision lane (#113850) was closed. | Upstream's own posture is "judgment-only, never a chat backend, no core runtime yet". A search summary claiming "native Jev integration in Hermes core" is wrong. |
| TypeSafe cookbook `skill_suggestion` — measured on **Hermes' 182-skill catalog**, 488 requests (315 covered, 173 deliberately uncovered) | Multi-label without multi-select: request 1 = one `choice` ranking all candidates + 3 `noul` "is any action needed"; request 2 = one `noul` per shortlisted candidate. Thresholds 0.30. | Wrong loads 16.8 % → 7.3 % (oracle 2.5 %); needless loads 9.8 % → 4.0 %; **fixed 37 requests, broke 7**. 60-char descriptions were ambiguous; full descriptions fixed most conflicts. This is the only measured harness result anywhere. |
| keeltrace/hermes-jev (community, dev build) | `jev_decide` / `jev_rank` / `jev_verify` (PASS·RETRY·REPLAN·ESCALATE) / `jev_assess` (≤ 16 questions, one state); context-retention scoring. | Design rule: **"ordinary Hermes execution does not wait for Jev"** — classification runs in the background at turn ingress. The synchronous tool gate is opt-in and discouraged. Shadow before apply is mandatory. |
| LangChain blog "Building a harness with Jev" | A per-run model router (`choice`) and a `bash` risk gate (`noul`). | No accuracy, latency or threshold data. The post itself concedes attacker-written instructions remain a risk. |
| aglowinthefield/hermes-typesafe-plugins (tool gate + model/effort router, "shadow mode, fail-open") | — | Repo returns 404 on 09-21 — gone within days of publication. |

Pattern across all of them: Jev as an **advisory, off-critical-path, shadow-first** judgment. Nobody has published a measured result for a synchronous gate or a router.

## 3. Review of rev 1 — what changed and why

1. **Rev 1's headline benefit does not exist as designed.** Rev 1 made the scope classifier the first consumer to save "seconds of wall time on the turn". The classifier runs in `Promise.all` with `enrichContext()` (`router.ts:2250`), and enrichment makes its own model call (`expandQuery`, 5 s timeout) and then a pgvector search that *consumes* the expansion. Measured from the journal, 82 paired turns since 09-10: the classifier's finish line lands a median **0.29 s after** the expansion line (p10 −0.50 s … p90 +0.21 s); expansion finishes later in 21 of 82 turns; the classifier is more than 1 s later in **2 of 82**. Enrichment still has the vector search to run after that line. The turn waits for the slower branch, so a 300 ms classifier would save about nothing. Jev cannot replace `expandQuery` — that is text generation.
2. **Neither branch is timed.** There is no duration in the classifier, in `expandQuery` or in `enrichContext`; the numbers above come from log-line arithmetic. Rev 1 planned a vendor integration before measuring the thing it claimed to speed up.
3. **Sequential fall-through taxed the uncertain turns.** Rev 1 ran Jev, then Sonnet on low confidence: worst case = deadline + Sonnet. keeltrace's rule (never wait for Jev) is the right one.
4. **Question design was thinner than the one measured design.** 27 bare `noul`s from one-line criteria. The cookbook's lessons apply directly: add one `choice` over the groups in the same request (free ranking signal, state billed once), use the full group descriptions from `CLASSIFIER_SYSTEM_PROMPT`, add an "is any tool group needed at all" `noul`.
5. **The shell-gate rejection stands, with a more exact reason.** A deny-only extra layer cannot fail *worse* than today, so "fails open" alone is not the argument. The arguments are: every shell command (paths, occasionally secrets) leaves the box; false blocks from a model with no published calibration stall Jarvis's dev work; a synchronous call per `shell_exec`; and nobody — vendor included — has measured one. It does not close the three documented open spellings, because an attacker-steerable classifier is not a closer.
6. Kept from rev 1: one dependency-free client, hard deadline, `null` on any failure, dormant by default, exact model pin, criteria fixed before results, the three operator rulings.

## 4. Architecture (unchanged in shape)

```
caller ── decide({ state, questions }, { deadlineMs }) ──▶ src/inference/jev.ts ── fetch ──▶ api.typesafe.ai
   ◀── answers | null        (one attempt, hard deadline, no retries, never throws)
```

- Plain `fetch` + `AbortSignal`, default deadline 1,200 ms; `null` on missing key, non-2xx, timeout, or a body that does not match the question set.
- Builders `noul()`, `choice()`, `score()` mirroring the HTTP schema.
- Circuit: 5 consecutive failures → skip for 5 min, one `[jev] circuit open` line.
- Every call: `jev.decision` trace event (caller, question ids, latency, outcome, input tokens), `mc_jev_calls_total{caller,outcome}`, `mc_jev_latency_ms`, `recordCost()` (`src/budget/service.ts`).
- **No npm dependency** (`@typesafe-ai/sdk` is 9 days old, 10 s per attempt with retries and no total budget; the API is one POST).
- `TYPESAFE_API_KEY` in `.env` (operator adds it). No key ⇒ `decide()` returns `null` without a fetch. Per-consumer flags default `off`.
- **Callers never await Jev on a path the user is waiting on**, unless a measured phase gate says the wait pays.
- Never on a security boundary (shell gate, write-guard, Rule-of-Two, provenance, `detectScopeMiss`); returns no text, so `sanitizeDeliverable` is untouched.

## 5. Phases

Criteria are fixed here, before any result exists.

### Phase A — measure the turn (no vendor, no ruling, no spend) ← next

Add durations to the three places that have none: classifier call, `expandQuery`, `enrichContext` total; emit one `turn.prelude` trace event per chat turn with all three plus which branch finished last.

- **Read after 7 days / ≥ 150 turns.** The classifier is a Jev candidate for latency only if it is the slower branch by ≥ 1 s in ≥ 30 % of turns. The 82-pair sample says it will not be (2 of 82).
- Whatever the result, the numbers say where the pre-inference seconds actually go — which is the question the 09-17 plan assumed an answer to.

### Phase B — offline replay of the classifier question (≥ $0.09; harness BUILT 09-21 `1fd0f1a`, `--run` needs rulings 1–2)

Worth running even if Phase A rules out the latency case, because it prices Jev's **accuracy on our Spanish traffic**, which every later consumer depends on. `scripts/validate-jev-scope.ts`, spend behind `--run`.

- Corpus: the most recent 400 distinct `scope_telemetry` messages with a non-empty `tools_called` **and a non-empty `active_groups`** (1,502 distinct messages qualify on 09-21; 349 of the 400 are Spanish). Population count printed first; < 300 usable ⇒ stop (below that the held-out half cannot reach its 80 scored rows, so the run could only fail after the spend). Credential-shaped messages are dropped before anything is sent (27 on 09-21; the filter is biased toward dropping). Telemetry keeps the first 500 chars of a message, so long messages are replayed truncated.
- **Why `active_groups` must be non-empty (found by the dry run):** `fast-runner.ts` writes a synthetic telemetry row with `activeGroups: []` for every task that bypassed the router (rituals, schedules, direct API). Their scope is the task's own tool list, no classifier decided it, and their `message` is a task prompt, not user text. With them in the corpus the harness's own ceiling — the LIVE groups replayed through the production scoper — was 83.2 % (228/274; every miss an empty-group row: `gmail_send` ×30, `calendar_list` ×14, `tweet_post` ×9), so the 95 % bar was unreachable for any classifier. Without them the ceiling is 100 % (270/270). The ceiling line is printed on every run; a run whose ceiling is below the bar measures the harness, not Jev. Consequence: over-selection on a turn that needed no group at all is not measured.
- Scoring: Jev's selected groups go through the production path (`withDeterministicGroups` + `scopeToolsForMessage`), so deterministic injections count for Jev exactly as they do for Sonnet. Tool→group ownership is derived from `scopeToolsForMessage` one group at a time (34 baseline tools, 172 group-owned); 129 of the 400 turns called only baseline tools or `ToolSearch` and are not scored for coverage.
- Threshold picked on one half of the Spanish rows, PASS judged on the other half (117 scored rows on 09-21 — a 95 % bar on that n carries roughly ±4 points). The verdict is a pure, tested function (`judge` in `src/tuning/jev-scope-replay.ts`), and `--self-test` runs the whole reporting path on answers fabricated from the live groups (must print PASS; on 09-21 it does, mean groups 3.78 vs live 3.78).
- Request shape per §3.4: 26 group `noul`s + a ranking `choice`, ≈ 5.5k tokens of questions per request; `state` = the message text only (§8 binding rule). The group descriptions go in **verbatim** from `CLASSIFIER_SYSTEM_PROMPT`: a first version moved their "NOT …" sentences into the `false` criterion and the QA audit showed it corrupted 6 of 26 groups (it inverted `northstar_write`, whose point is "deletion is northstar_write, NOT destructive") — a rewrite of the descriptions would have been graded instead of Jev. The questions therefore name our sites and projects to the vendor. The any-tool question was dropped: the corpus has no turn it could be graded on. Ground truth = the tools the turn actually called. Known bias: a tool can only be called if it was in scope, so the live classifier scores ~100 % here by construction — the bar is absolute, and live `active_groups` is used only for the bloat comparison.
- Report split es / en: coverage, mean groups and tools per threshold (live tool count printed beside it; tool-count bloat is reported, not gated), latency p50/p95/max from this host measured to the parsed answer, errors/429s, the rank question's hit rate, and the input tokens the vendor actually billed. The $0.09 is a chars/4 floor: the 09-21 probe billed 313 input tokens for ~50 tokens of text, so there is a fixed overhead of unknown shape (per request ≈ +$0.004; per question ≈ +$0.12). A fixed-vs-broke count against the live groups is NOT reported — live scores 100 % by construction, so it could only ever show "broke".
- **PASS** (Spanish turns, held-out half): ≥ 90 % of sent requests answered · p95 over **every** sent request ≤ 800 ms (a timeout is a slow answer, not a missing one) · ≥ 80 scored held-out rows · coverage ≥ 95 % · mean groups after the scoper's injections ≤ live + 1 (live mean is 3.78, so this is a loose bar) · the run did not stop early (a 401 or a < 50 % answer rate after 40 requests stops it, and a stopped run never passes). A FAIL ends the Jev work; record the numbers. `--run` writes the replayed message text and raw vendor bodies to `data/jev-scope-replay-*.json` (git-ignored, 0600) — delete it once the numbers are recorded.

### Phase C — client + first async consumer (shadow)

Build `src/inference/jev.ts` with mutation-verified tests (happy path, non-2xx, timeout, malformed body, circuit, no-key = no fetch). First consumer is chosen by Phase A/B evidence, from decisions that today are **regex because a model call was too dear, and that nobody waits on**:

| Candidate | Today | Why it fits |
| --- | --- | --- |
| Turn feedback signal (`scope_telemetry.feedback_signal`; since 08-21: 1,457 `none` / 61 `implicit_positive` / 38 `implicit_rephrase` / 14 `positive` / 6 `rephrase` / 5 `negative`) | pattern heuristics, written after the turn | async, feeds the case miner and usability KPIs, a wrong label costs nothing live |
| Scope classifier in **hedged** form | Sonnet | only if Phase A shows a latency consumer: Jev and Sonnet start together, a confident Jev answer wins and the Sonnet call is abandoned — never sequential |
| Skill suggestion | the model picks | the one measured Hermes result; our catalog is 10 skills, so the expected gain is small — listed for completeness |

Shadow = log Jev's answer beside the live one for 7 days / ≥ 150 decisions; agreement and disagreement samples reviewed by hand before anything acts on it.

### Phase D — act on it

One consumer goes live behind its flag, with a 14-day watch on the metric it feeds. Model bumps re-run the Phase B harness first; `jev-1.13.0` is pinned, never `jev-latest`.

**Explicitly out:** shell/package-manager gating (§3.5), sycophancy rewrite (module has no live caller since V8.2 retired), model-tier routing (tiering exists; Opus NO SWAP; the LangChain router has no measurements), memory deletion decisions, anything that replaces `expandQuery`.

## 6. Failure modes designed for

| Failure | Behaviour |
| --- | --- |
| No key / vendor down / 429 / 529 | `null` → existing path; circuit stops repeated waits |
| Slow answer | hard deadline; and no user-facing path awaits Jev |
| Model bump changes answers | exact pin; harness re-run before changing it |
| Prompt injection in the state | no gate depends on Jev; worst case is a wrong advisory label or a wider tool scope for one turn |
| Vendor disappears (one Hermes plugin repo already did) | delete one file and one env var; no dependency, no schema |

## 7. Open rulings (operator) — block Phase B onward, not Phase A

1. Second vendor for closed decisions under the 09-15 Claude-only ruling — allowed or not? (Hermes upstream made the same split: judgment provider yes, chat backend never.)
2. User message text leaving the box to TypeSafe (no zero-retention on the self-serve tier; DPA to be read first).
3. ~~API key for Phase B~~ — DONE 09-21: operator added `TYPESAFE_API_KEY` to `.env`; a synthetic one-question probe returned HTTP 200. Rulings 1–2 stay open: running `--run` IS the decision on both.

## 8. Paper review — "Jev Engineering for Coding Agents" (unofficial synthesis of TypeSafe founder notes, Sept 2026)

Read 2026-09-21. Evidence grade: **low** — a third-party compilation of unpublished notes; its only numbers are list-price arithmetic, an "illustrative" token-share table and one Microsoft figure (reading + searching = 46.5 % of main-agent tokens). No Jev harness is measured anywhere in it. Idea grade: useful, mostly for things that need no Jev.

**What it changes here**

1. **Jev `state` sensitivity rule (new, binding on §4).** The paper's §IX routes work by the sensitivity of the files it touches and keeps secrets/infra on first-party frontier models only. Applied to Jev itself — a weeks-old vendor with no self-serve zero-retention — `state` may carry the user's message text and our own labels, and never file contents, command output, env values or KB bodies. This also removes the paper's permission gate and chunk-scoring ideas for us, since both need exactly that content.
2. **The prelude is a free latency window.** Rev 2 found the classifier is not the slower branch; the converse is that any Jev call running inside the same `Promise.all` and finishing before `expandQuery` costs the turn nothing. Phase A's timings size that window. New Phase C candidate, ahead of the others: **KB conditional-row relevance** — today `conditionMatches` (`src/messaging/kb-injection.ts`) is keyword-gated, the class behind the 09-19 "directive written is not injected" incident; one `noul` per conditional row ("does this directive apply to this message?", row *conditions* only — not bodies — in `state`), shadowed against the keyword result. This is the paper's §VIII "conditional instructions" in the one place Jarvis already has them.
3. **Confirms two exclusions.** Its own routing arithmetic (pure Opus 4.15 vs Opus→Sonnet→Opus 6.19, checked) says tier routing loses unless the helper gets a small purpose-built context — which Prometheus's economy executor already does; a Jev tier router adds nothing. And its headline "meta-attention" (score every context chunk per query, rebuild the cache) requires owning the inner loop; the paper says so itself ("cannot be delivered as a plugin"). Jarvis's inner loop, transcript, cache and compaction belong to the Claude Agent SDK. We own the per-turn prelude only.

**For Jarvis's code tasks — none of it needs Jev**

- Our own mix, coding-scope turns since 08-07 (646 turns, 4,839 tool calls): `shell_exec` 35 %, `ToolSearch` 11 %, `file_edit` 7 %, `file_read` 7 %, `grep` 1.5 %. Reads and searches run through the shell, so command output — the paper's "balloons on failure" bucket — is our largest lever, and tiered tool disclosure already exists and already costs one call in nine.
- **Per-directory footguns files, loaded by condition.** Only a `Stop` hook is wired in `claude-sdk.ts` today. A `PreToolUse` hook on `file_edit`/`file_write` that injects `<dir>/GOTCHAS.md` by path is deterministic, survives SDK compaction, and targets the defects seen in PR #36 (a log line added to a swallowed error instead of feeding the caller's failure path; `git stash` in the worktree). Candidate for the queue, separate from Jev.
- Structural search / output compressors (ast-grep, rtk, headroom, fff): new dependencies — discuss after a measurement of shell-output tokens per coding task, not before.
- Not adopted: intent-to-tool routing with harness-built arguments (Jev cannot generate arguments), allow/ask/deny by Jev (no measurement; vendor's own limits page says adversarial content moves the answer), lock-based mass parallelism.

## Sources

docs.typesafe.ai (`api`, `models`, `confidence`, `model-jaggedness/jev-1.13`, `cookbooks/skill_suggestion`, `cookbooks/parallel_questions`, `legal`) · github.com/NousResearch/hermes-agent issue 113837, PR 113847 · github.com/keeltrace/hermes-jev · langchain.com/blog/building-a-harness-with-jev · github.com/typesafe-ai/typesafe-sdk-js
