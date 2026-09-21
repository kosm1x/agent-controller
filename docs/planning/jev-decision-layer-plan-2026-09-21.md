# Jev decision layer — plan (2026-09-21, rev 2)

**Status:** DRAFT rev 2.2 — Phase B harness built (`1fd0f1a`), audited twice and dry-run; the operator's key answers (09-21 one-question probe: HTTP 200 in 0.32 s, 313 input tokens billed); the 400-message replay RAN 09-21 19:09 UTC: **FAIL** (62.6 % coverage at live-sized scope vs a 95 % bar; misses are almost all the `coding` group, and the harness withheld conversation state the live path has — see "Phase B result"); nothing in the live path. Rev 1 (`fa3db57`) was reviewed the same day against the Hermes ecosystem and against our own journal; the review **removed rev 1's headline benefit** (§3) and reordered the phases. Supersedes `jarvis-kb/projects/agent-controller/jev-implementation-plan.md` (09-17).
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

#### Phase B result — 2026-09-21 19:09 UTC: **FAIL** (pre-registered rule), with a confound in the harness

Operator ruled the same day: Jev MAY be a second vendor for closed decisions (ruling 1), and ordered the replay (ruling 2). 400 sent · 400 answered · 0 errors · p50 183 ms · p95 298 ms · max 647 ms · billed 2,378,720 input tokens = **$0.100** (estimate $0.094; the probe's overhead is per request, not per question).

| Spanish, 243 scored turns | coverage | mean groups | mean tools |
| --- | --- | --- | --- |
| live (Sonnet + recent context + sticky scope) | 100 % by construction | 3.78 | 80 |
| Jev T=0.20 | 77.0 % | 8.92 | 107 |
| Jev T=0.30 | 62.6 % | 4.09 | 76 |
| Jev T=0.50 | 47.3 % | 1.83 | 58 |
| production regex detector, message alone (control) | 37.4 % | — | 46 |
| `coding` alone, no classifier (control) | 61.3 % | 1 | 56 |
| Jev T=0.30 + `coding` always on (post-hoc) | 92.6 % | — | 89 |
| Jev T=0.20 + `coding` always on (post-hoc) | 95.1 % | — | 116 |

No threshold reaches 95 % on the tune half, so the verdict is FAIL and it stands as recorded. English rows (n=28 scored) are worse: 57 % at T=0.20. The rank question alone hits 52 %.

**What the FAIL does and does not show.** The misses are one group: `coding` was needed on 183 of 243 scored turns and Jev gave it ≥ 0.30 on 92 (median 0.31); `google` 47/65, every other group near-complete. Live carries `coding` on 266 of 349 Spanish rows — far more than the message text supports (the regex detector finds a coding signal in 61 of those) — because the live scope is NOT a function of the message alone: the classifier also reads the last two conversation turns (`recentContext`, `router.ts`), and the router unions in the previous turn's groups within the sticky TTL (`previousScopeGroups`). The harness sent Jev the message alone and then scored it against tools that were callable only because of that conversation state. The ceiling check could not see this: it replays the live groups, which already contain the inherited ones. CLASS: a ceiling built from the incumbent's outputs inherits the incumbent's inputs — check that the candidate is given the same inputs, not only that the measure is reachable.

So: on the message alone Jev beats the regex fallback by 25 points and is nowhere near the live path; how it compares with Sonnet on EQUAL inputs is unmeasured. The post-hoc rows are exploratory (chosen after seeing the data, not held out) and cannot turn the FAIL into a PASS.

**Decision for the operator.** (a) Stop here — the plan said a FAIL ends the Jev scope work, and rev 2 already showed the classifier is not the turn's critical path, so the upside was cost, not latency. (b) One fair retest (~$0.10): `state` = message + the same two-turn `recentContext`, sticky union simulated from thread-ordered telemetry, same PASS rule, registered before the run. Needs a thread key joined onto `scope_telemetry` (it has `task_id`, no thread). The raw answers are kept in `data/jev-scope-replay-2026-09-21T19-09-03-213Z.json` (0600, git-ignored, holds message text) so message-alone re-analysis needs no new spend — delete it once (a) or (b) is chosen.

#### Phase B retest — equal inputs. REGISTERED 2026-09-21 BEFORE the run (operator chose (b): "Run the fair retest with equal inputs")

Harness: `scripts/validate-jev-scope-chain.ts` + `src/tuning/jev-scope-chain.ts`. Everything in this subsection was fixed before any vendor answer existed; nothing here changes after the run, and no prompt, threshold, population or exclusion chosen after seeing answers counts toward the verdict. Informational rows the report prints cannot move the verdict in either direction.

**What Jev gets — the same four things the live classifier path has.**

1. The message, normalized with `normalizeForMatching` (as `router.ts` does before classifying).
2. `recent_context`: the router's exact `recentContext` string. The router appends the current message to the thread BEFORE slicing the last two turns, so the string is [previous thread turn, the message itself], 150 chars each — one turn of history, not two. The thread is rebuilt from the `conversations` rows tagged `telegram` written strictly BEFORE the message arrived (last 15, parsed like `getThreadTurns`, poisoned replies dropped with the router's own `isPoisonedExchange`). Telemetry is stamped at message arrival and the exchange row after the reply, so the current reply cannot leak in (checked by the audit: of 977 matched exchanges none is written in its own scope row's second; the handful written earlier are genuine re-sends of the same text, which live's buffer also held).
3. The classifier prompt's 11 RULES bullets and 5 annotated examples, verbatim, in `state` (vendor guidance: policy text belongs in `state`); the 26 group descriptions verbatim as noul criteria. One instruction wording, written before the run, never iterated. No rank question.
4. The sticky chain: the router's own exported `decideActiveGroups` + `STICKY_SCOPE_TTL_MS` (45 min) walked over the thread in order, then `withDeterministicGroups` and the pure production scoper with the router's `recentUserMessages` recipe (last 4 user messages INCLUDING the current one + google/wp words of the last 2 replies). The prior is **Jev's own previous base answer** — live's recorded groups never enter Jev's scope.

**Population.** Every router turn on the `telegram` thread from the first task row that carries `threadId` (2026-08-17 23:38 UTC) to the registered cut `2026-09-21 19:45:00 UTC`: 1,013 turns after merging 71 repeats of the previous message within 10 min. Turns that called no tool stay in the chain (they move the prior) and are not scored. Ground truth = the tools the turn really called (both rows of a merged repeat, unioned).

**Exclusions, fixed now.**

- (i) 67 messages are never sent and not scored — and most of them are NOT secrets: 46 carry a ≥ 32-char alphanumeric run (the key-shaped rule; in this corpus mostly Google-Docs/Drive URLs, file paths and slugs), 12 an e-mail address, 9 credential keywords or a login block. The structural `label: opaque-token` rule added after R2 withholds nothing the other rules do not already catch on this corpus; it is there for the spelling nobody listed. Over-withholding is the safe side for privacy and costs both sides the same turns (6.6 % of the window). In the chain they leave Jev's prior as it was (neither narrowed to the regex base nor informed by live) and refresh its clock, as every live turn does; a prior that was already past the TTL (or behind a restart) at the withheld turn is dropped, not resurrected by the refreshed clock.
- (ii) A context TURN whose 150-char slice trips the same test goes out whole as `role: [omitted]` (60 sent turns) — Jev sees less than Sonnet did there; a second-half readout without those turns is printed as information only. The harness refuses to run if any outgoing context (role labels stripped) still trips the test; that guard shares the predicate, so it catches a redactor bug, not a detector miss — the detector is pinned by its own tests.
- (iii) 30 turns that the groups live RECORDED for the turn's first run cannot cover through today's scoper are unscoreable for any classifier and leave the denominator (the recorded set is the final one — sticky union + injections; the classifier's raw answer is not persisted anywhere): the second telemetry row of a repeat is usually the router's scope-miss re-run (live's first classification missed, the re-run widened the scope), a few are tools regrouped since. Scoring them would fail a classifier that reproduces live exactly (the second half alone has more such turns than the 95 % bar allows misses). Jev's coverage on them is printed as information only — it is the one place Jev could show it beats live's first run, and it still does not count. A live turn recorded with NO groups stays empty in live's baseline (it is not handed the regex fallback).
- (iv) Unanswered requests are NOT excluded: the turn is scored on the regex fallback the router would use. No retry — a vendor 429/5xx counts against the answer rate.

**PASS rule — unchanged from the first replay except the split.** Spanish turns; threshold = the LARGEST grid value (0.20…0.70 step 0.05) whose coverage on the FIRST half of the window is ≥ 95 %; judged on the SECOND half (chronological, because neighbouring turns share a conversation): run not stopped early · ≥ 90 % of sent requests answered · p95 over every sent request ≤ 800 ms · ≥ 80 scored second-half turns · coverage ≥ 95 % · mean groups ≤ live + 1. Group counts on both sides are taken through the SAME chain (live's recorded list is pre-injection; counting it raw would charge the scoper's injected groups to Jev alone).

**Free validations, run before the spend (09-21).** Scoper env options fitted on live's recorded tool lists, independent of Jev: `{google, wordpress, crm: on; memory: off}` reproduces the recorded list exactly on 190 of the last 200 turns. Ceiling: live's recorded first-run groups through the chain cover 410/410 scored Spanish turns once the 30 are out (with them in, live's own first run is 410/437 = 93.8 % — below the bar Jev is held to, which is why they are out). `--self-test` (answers fabricated from live's groups, sticky off; exit code 2, never 0) passes all 7 checks with 191 first-half / 219 second-half scored turns. **Control, same chain, no classifier at all (regex fallback + inheritance): 82.2 % (337/410) at 2.82 groups over the whole window, 76.7 % (168/219) at 2.74 groups on the judged second half** — the second figure is the one Jev has to clearly beat to be worth anything, and it sits 18.3 points under the bar; in the first replay the message-alone regex control was 37 %.

**What stays tilted, declared.** Toward live: called tools were chosen FROM live's scope, so live is 100 % by construction and a tool only Jev would have offered cannot count for Jev; 48 messages were recorded cut at 500 chars while live classified the whole text; Sonnet's raw per-turn answer is not logged anywhere, so there is no like-for-like Sonnet chain — the bar is the absolute 95 %, not "beat Sonnet". Toward Jev: process restarts wipe the in-memory prior and are only known since the journal starts (09-15), so the verdict ignores them and Jev's chain keeps slightly more prior than live had (`--restarts <file>` prints the effect on the 09-16→ window); the user half of a poisoned exchange stays in the rebuilt thread, which live's in-memory buffer drops until a restart re-hydrates it; and exclusion (i) lets Jev's prior ride through a withheld turn unchanged where live's prior moved to whatever Sonnet answered there — on the ~50 turns that directly follow a withheld one inside the TTL, Jev inherits a prior it earned earlier (when that prior was still alive) rather than none — the least-bad of the options that keep live's answers out of Jev's chain; and coverage is scored through TODAY's scoper, which offers more tools than live did at the time (≈ 79 per turn simulated vs ≈ 72 recorded; no env-option mask reproduces the recorded list on the oldest 200 turns, the fitted one is exact on 190 of the newest 200) while the called tools were picked from the narrower real scope — a cushion every classifier and the control get equally, so it softens the absolute 95 % bar, not the comparison with the control.

**Audit.** qa-auditor R1 (pre-spend): FAIL — a context-redaction bug that would have sent 14 credential-shaped lines minus their last character; the repeat-merge folding live's re-run into live's baseline (tilt against Jev); `recent_context` built from two history turns where live has one plus the message (tilt toward Jev). All folded, plus its 5 warnings. R2 (pre-spend): FAIL — `looksSensitive` missed the spelling `Pswd:` (two login+password messages in the window; the keyword list had already been widened once, so the fix is structural: any `label: opaque-token` line, a login block, e-mail addresses — pinned by tests with negatives for prose, URLs, paths, dates and numeric ids); the ceiling was labelled "first-pass" though telemetry records the final set; empty recorded groups were handed the regex fallback in live's baseline (tilt toward Jev); the results file kept withheld text. All folded; the unsent count moved 54 → 67, omitted-context turns 52 → 60, and every number above was recomputed after the folds. 7 of 8 auditor mutants went RED; the pre-registered numbers reproduced. R3 (pre-spend): PASS — an independent detector (not `looksSensitive`) over every byte that would leave the box found no credential; every registered number reproduced; 15 of 17 mutants RED (the two survivors widen withholding or need a suffix-triggered rule; one now pinned). Its findings were declaration accuracy, folded above before the run: what the 67 withheld messages really are, the control on the judged half, the size of the withheld-turn tilt, the scoper drift. One code fold, against Jev and RED-first: a withheld turn refreshed the clock of a prior the TTL had already killed and so brought it back — it is now dropped (no registered number moved). The script layer itself has no tests (guards proven by the audit firing them, not by a pin) — do not reuse it as if pinned.

**Disclosure — first replay.** That detector miss was already live in the first replay: its sample included one message carrying a Fantasy-league login and password (`Pswd:` spelling), and it WAS sent to the vendor and answered. The operator is told to rotate that password. The second such message in the window was not in that sample.

**Data leaving the box.** Wider than the first replay and than §8 allows for live use: besides user message text, `recent_context` carries up to 150 chars of the previous thread turn (usually Jarvis's reply), and every request carries the classifier RULES/examples/descriptions, which name internal projects and hosts. Approved for this one offline run by the operator's choice of the context retest; it does NOT settle ruling 2 for live traffic. The results file (0600, git-ignored) holds the sent text and the answers only — thread history is dropped and the text of withheld turns is nulled. Cost ≈ $0.23 (946 requests × ≈ 5.8k tokens), not the ~$0.10 quoted in (b) — the rules/examples block and the longer window doubled it.

#### Phase B retest — RESULT 2026-09-21 20:37 UTC: FAIL (harness `27f2af5`, registered and pushed before the run)

946/946 answered · p50 187 ms · p95 254 ms · max 532 ms · billed 5,518,402 input tokens ≈ $0.232. Six of seven checks pass; the one that fails is the one that matters:

| Check | Result |
| --- | --- |
| run completed, answer rate ≥ 90 %, p95 ≤ 800 ms | ok (100 %, 254 ms) |
| threshold = largest grid value with first-half coverage ≥ 95 % | **0.70** — 97.4 % (186/191) |
| ≥ 80 scored second-half turns | ok (219) |
| **second-half coverage ≥ 95 %** | **FAIL — 89.5 % (196/219)** |
| second-half mean groups ≤ live through the same chain + 1 | ok — 3.17 vs 4.05 |

**Reading, without rescue.** Equal inputs moved Jev a long way: 62.6 % message-alone → 89.5 % on held-out turns, 12.8 points over the no-classifier control (76.7 %) and at a NARROWER scope than live (3.17 vs 4.05 groups). It still leaves a called tool out of scope on 1 turn in 10, against a live path that — by construction of this test — leaves none. The confound of the first replay is gone; the FAIL stands on equal inputs.

Two things the tables show that do NOT count, stated so nobody rediscovers them as a rescue: (1) the first half passed at EVERY threshold, so the registered "largest passing" rule picked the narrowest scope (0.70); on the second half only 0.30 (and below) would have cleared the bar — 209/219 = 95.4 % at 4.62 groups, the minimum passing count; 0.35 prints as 95.0 % but is 208/219 = 94.98 %, under it. A one-turn margin at a threshold chosen after seeing the answers is exactly what the registration forbids. (2) Coverage fell 7.9 points from the first half to the second at the same threshold (97.4 % → 89.5 %): a threshold tuned on one month does not hold on the next, which is its own argument against shipping a fixed one. Informational rows: without omitted-context turns 89.4 % (178/199) — the privacy redaction did not cause the miss; on the 27 turns live's own first run could not cover, Jev covers 15 at 0.70; English/other 74.0 % (37/50); restart sensitivity no effect (96.9 % both ways on the 09-16→ window, 65 turns).

**Consequence per this plan.** A Phase B FAIL ends the Jev *scope classifier* work: no Phase C consumer is built on it. The vendor itself measured well twice (1,346 requests, 100 % answered, p95 < 300 ms, $0.33 total), so the ruling that Jev MAY be a second vendor stands for a future closed decision with a cheaper failure mode than dropping a tool from scope; none is proposed here. Delete `data/jev-scope-replay-*.json` and `data/jev-scope-chain-*.json` (0600, git-ignored, hold message text) once the operator closes this.

#### Operator ruling 2026-09-21 (after the retest): ENABLE at 89.5 % — shipped `3c33771`

"Enable JEV in the Jarvis' classifier. 89.5% is enough for me." This overrides the consequence written above (a FAIL ends the scope-classifier work); the FAIL against the registered 95 % bar stands as measured. Shipped as: Jev first at the registered 0.70 threshold with the retest's exact request, Sonnet as the fallback on every non-answer, regex last; `SCOPE_CLASSIFIER_PROVIDER=sonnet` is the kill switch. With this the operator also rules on §8 for this consumer: live message text + ≤ 150 chars of the previous turn + the classifier prompt leave the box on every turn, minus credential-shaped text, bare opaque tokens and e-mail addresses (those turns stay on Sonnet). What to expect live: ≈ 1 tool-using Spanish turn in 10 starts without a needed tool (the scope-miss re-run is the net), English turns worse (74 %, n=50), classifier latency ≈ 0.25 s instead of ≈ 4 s. Open after ship: a provider column on `scope_telemetry` so the live rate is measurable without the journal; Jev spend (≈ $0.00025/turn) is in no cost ledger while `aux:scope-classifier` spend drops — that drop is not a saving of the same size.

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

1. ~~Second vendor for closed decisions under the 09-15 Claude-only ruling~~ — RULED 09-21: allowed ("we can have Jev as a second vendor for Jarvis and not claude-only"). Original question: allowed or not? (Hermes upstream made the same split: judgment provider yes, chat backend never.)
2. (Operator ordered the Phase B replay on 09-21 with the send described; a STANDING answer for live traffic is still open.) User message text leaving the box to TypeSafe (no zero-retention on the self-serve tier; DPA to be read first).
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
