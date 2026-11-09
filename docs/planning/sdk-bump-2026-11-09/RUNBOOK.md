# Runbook: Claude Agent SDK 0.3.285 -> 0.3.316 (mission-control / Jarvis)

Prepared 2026-11-09 in a scratch copy of the live tree at HEAD `cb6b9a5e`
(clean tree apart from `.claude/agent-memory/qa-auditor/MEMORY.md`). The ruling
commit `5e99494a` (queue 4cc) landed during the preparation. It is docs-only, and
package files, `src/`, `scripts/` and `prompt_modules/` are identical to
`cb6b9a5e`. Nothing
under `/root/claude/mission-control` was installed, edited or restarted. Every
step below is for the operator.

Script for steps (a)-(f): `/root/sdk-bump-2026-11-09.sh`. It refuses to run
without a PASS gate log (step g), stops the service, installs, checks,
typechecks, runs the scoped tests and commits. It does not deploy.

**Order: (g) first, from a copy, while the service runs. Then (a)-(f) (the
script), then (h)-(j).**

## Why 0.3.316
- Newest version past `.npmrc` `min-release-age=7`: published 2026-10-31
  00:39 UTC. 0.3.317 (11-03), 0.3.318 (11-03) and 0.3.319 (11-06) are younger
  than 7 days. Do not override the age rule.
- Bundled CLI 2.1.316: `claudeCodeVersion` in package.json, `VERSION:"2.1.316"`
  in the linux-x64 binary, and the binary's sha256 matches `manifest.json`
  (`fd13c700…d824`). The binary contains `claude-opus-5-5`, `claude-sonnet-5-5`,
  `claude-haiku-5-5` and `claude-opus-4-8`. The "version X or newer is required"
  refusal is server-side, so it can only be confirmed by a real call (step i).
- Peer ranges unchanged: `zod ^4.0.0`, `@anthropic-ai/sdk >=0.93.0`,
  `@modelcontextprotocol/sdk ^1.29.0`. The repo has zod 4.4.3, sdk 0.111.0
  and MCP SDK 1.32.0. `engines.node` moves from `>=18.0.0` to `>=18.14.0`
  (host and CI run Node 22).
- Lockfile: only the SDK and its 8 platform packages change (37 lines added,
  37 removed, plus the root pin). `npm audit` reads 33 before and after
  (1 low, 9 moderate, 18 high, 5 critical; the same advisories).
  `npx -y npm@10 ci --ignore-scripts` (npm 10.9.9, as in CI) on the new
  lockfile added 419 packages with 0 peer warnings and 0 ERESOLVE, so the bump is CI-safe.
  `npm install-scripts ls`: `No packages with unreviewed install scripts.`

## Type delta (sdk.d.ts and the other .d.ts files, 0.3.285 -> 0.3.316)
Additive only. No declaration or export was removed.
- Repo imports: `tool`, `createSdkMcpServer`, `query`, `HookCallback`, `HookInput`,
  `HookJSONOutput`, `StopHookInput` (tests), `Options`, `SDKResultSuccess`,
  `SDKResultError`, `SDKUserMessage`, `SdkMcpToolDefinition`, `TerminalReason`,
  `ModelUsage`, `ThinkingConfig`. Signatures of `tool`/`createSdkMcpServer`/`query`, and
  `ThinkingConfig`, `EffortLevel`, `TerminalReason`, `HookCallback`,
  `HookInput`, `HookJSONOutput`, `StopHookInput` (block byte-identical),
  `SdkMcpToolDefinition` and `SettingSource`, are all identical.
- The other `.d.ts` files: `core.d.ts` gains 3 exports (`BUILTIN_TOOL_NAMES`,
  `LEGACY_TOOL_NAME_ALIASES`, `prewarm`). `sdk-tools.d.ts` is additive
  (`OfferChromeSetupInput`/`OfferChromeSetupOutput` plus optional fields, 62
  lines added, 1 removed). `bridge.d.ts` and `browser-sdk.d.ts` change 24 lines
  each, mostly doc comments, plus a few optional fields and
  `suspendSseStream`/`resumeSseStream` in `browser-sdk.d.ts`. The package's
  `exports["."].types` is `./sdk.d.ts`, so none of these reach the repo's imports.
- `Options`: no key was added or removed (only doc comments changed, including the
  omitted-`permissionMode` default; Jarvis passes `permissionMode: "dontAsk"`).
- `Settings` gains `attributionProject`, `attributionProjectPolicy`,
  `autoMode`, `idleCompaction`, `skipAutoPermissionPrompt`, `sshHostCommands`,
  `useAutoModeDuringPlan`. `autoMemoryEnabled`, `syncClaudeAiSkills` and
  `syncClaudeAiPlugins` are still declared.
- `ModelUsage` gains `cacheCreationEphemeral5mInputTokens` and
  `cacheCreationEphemeral1hInputTokens`. `SDKResultSuccess` gains
  `first_text_post_queue_wait_ms` and `first_text_post_queued_behind`.
  `SDKAssistantMessage` and `SDKUserMessage` gain `agent_id`.
  `AgentDefinition` gains `autoCompactWindow`.
- Unions widened: `SDKStartupFailureReason` (+3), the settings `source` (+`mcpMount`),
  the usage-warning keys, and `USAGE_TRANSITION_PREFIXES` (+1).
- New exports: `BUILTIN_TOOL_NAMES`, `LEGACY_TOOL_NAME_ALIASES`,
  `SDKControlGetTaskOutputRequest/Response`.

## Changelog review (SDK 0.3.286-0.3.316, CLI 2.1.286-2.1.316), watch list
Behaviour that reaches Jarvis:
- **MCP tool description cap** (0.3.295/0.3.296, CLI 2.1.295/2.1.296), in-process
  SDK servers included. In the binaries the cap was a single
  `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH ?? 2048` in 2.1.285. In 2.1.316 it is
  `?? (loadedThroughToolSearch ? 16384 : 4096)`. Of 191 statically exported
  registry tools, 6 have descriptions over 2,048 characters:
  `jarvis_file_write` 2165, `submit_report` 2105 and `wp_publish` 2057 (core),
  plus `google_workspace_cli` 2594, `infographic_generate` 2551 and
  `video_html_compose` 5278 (deferred). Until now the model saw these cut at
  2,048 characters, which drops their tail (usually the `DO NOT USE WHEN:`
  section). Tool search is armed in production (`TOOL_SEARCH_ENABLED` is
  true), so the three core tools are now sent in full up front (cap 4,096),
  and the three deferred tools take the 16,384 cap when ToolSearch loads them:
  all three reach the model in full, `video_html_compose` with all 5,278
  characters. This is a **tool-description change seen by the model**, so
  the eval gate (step g) is required. If the gate fails because of this,
  setting `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH: "2048"` in the child `env`
  in `claude-sdk.ts` restores the old behaviour exactly. That is a code change and is not
  part of this bump.
- `alwaysLoad` (CLI 2.1.287): a server-level `alwaysLoad: false` now defers
  all of that server's tools, but only for stdio/http/sse configs. For an
  in-process server, `createSdkMcpServer` still turns the server flag into
  per-tool `_meta['anthropic/alwaysLoad']: true` when the flag is true and sends no server flag. The
  code is identical in 0.3.285 and 0.3.316, so the OR with per-tool
  `alwaysLoad: !deferred` still holds. Step (j) re-proves it.
- Tool search fixes (CLI 2.1.300, 2.1.302, 2.1.304, 2.1.305, 2.1.314) and
  "tool search on by default behind a custom `ANTHROPIC_BASE_URL`" (2.1.304).
  Tool search is armed in production (`TOOL_SEARCH_ENABLED` is true), so
  these fixes are on the live path: deferred tools load through ToolSearch
  and take the 16,384 description cap. The default-on change does not alter
  that. With the flag off, Jarvis passes `tools: []`, which removes
  ToolSearch, so the default could not arm it either. Step (j) re-validates
  the armed contract.
- `thinking: { type: 'disabled' }` now runs as adaptive thinking on models
  that cannot turn thinking off (0.3.300). `defaultThinkingFor` sends
  `disabled` only to non-5.x-Sonnet/Opus ids (Haiku 4.5, Opus 4.8), which accept it,
  so nothing changes. A future `claude-haiku-5-5` would now run adaptive
  instead of being refused.
- Settings isolation: a settings file excluded by `settingSources` no longer
  supplies auto-mode rules and saved permission consents (0.3.314, CLI 2.1.314).
  This tightens `settingSources: []`.
- Argument passing: named option values go as `--flag=value` (0.3.295).
  `--setting-sources=` (empty, from `settingSources: []`) has the same shape as before.
  The `settings` option still reaches the CLI as the `--settings` flag layer
  (same code path in `sdk.mjs`).
- `persistSession: false` still maps to `--no-session-persistence`. The only
  `CLAUDE*`/`NODE*`/`ANTHROPIC*` env names that `sdk.mjs` deletes are
  `NODE_OPTIONS` and `CLAUDE_CONFIG_DIR`, as in 0.3.285, so
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY` and `ENABLE_TOOL_SEARCH` still reach the child.
- No changelog entry touches `autoMemoryEnabled`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY`,
  `syncClaudeAiSkills`/`syncClaudeAiPlugins` or `persistSession`. The one
  memory entry (CLI 2.1.311: stale MEMORY.md after compaction) does not apply
  with auto-memory off.

No impact: hook `updatedInput` validation (PreToolUse/PermissionRequest only;
Jarvis has only a Stop hook), the omitted-`permissionMode` default (Jarvis
passes `dontAsk`), fork subagents on by default (Jarvis exposes no Agent
tool), the Opus 4.8 fast-mode deprecation (Jarvis does not use fast mode), and
MCP reserved names (the server is named `jarvis`).

## Auto-memory fix (8311e655) on CLI 2.1.316
Evidence comes from the linux-x64 binary (minified names change per build):
- (a) `autoMemoryEnabled` setting: **HOLDS**. It is read from the merged settings,
  `function _I(){let e=ft();if(e.autoMemoryEnabled!==void 0)return e.autoMemoryEnabled;return!0}`
  (0.3.285: `$L()`/`Ye()`).
- (b) `CLAUDE_CODE_DISABLE_AUTO_MEMORY` wins over the setting: **HOLDS**.
  `function pQ(){switch(yh()){case"off":return!1;case"forced_on":return!0;case"unset":break}if(UPt())return!1;return _I()}`
  with
  `function yh(){if(Gr())return"off";if(lk())return"off";if(X())return"off";let e=process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;if(Oe(e))return"off";if(Go(e))return"forced_on";return Sh()?"off":"unset"}`.
  `Oe` accepts `1/true/yes/on`, so `"1"` returns `"off"` before `_I()` is consulted.
  This is the 0.3.285 `R2()`/`DS()` pair, with one extra `"off"` guard
  (`X()`).
- (c) `syncClaudeAiSkills`/`syncClaudeAiPlugins`: **HOLDS**. Only `false` is honoured
  (`if(e==="syncClaudeAiSkills"||e==="syncClaudeAiPlugins")return o===!1`).
  The setting description still says "In .claude/settings.local.json or
  --settings: downloads stop and synced skills are blocked and hidden for
  sessions in that workspace or invocation only". The sync gate still reads
  `["userSettings","localSettings","flagSettings"]`.

Spec pins in `src/inference/claude-sdk.test.ts` pass on 0.3.316 (step e).

## Expected downtime
Measured in the scratch copy:
- `npm install …@0.3.316 --save-exact`: 11 s. `tsc --noEmit`: 10 s.
- Scoped tests: 14 s. `claude-sdk.test.ts` on its own: 3 s.
- Commit: about 1 s. Only `package.json` and `package-lock.json` are staged, and the
  pre-commit hook skips when no `.ts` file is staged. The full suite runs in
  CI on push (3 shards).
- `deploy.sh`: migration preflight, build, then a **sandbox image rebuild**,
  because the lockfile changed and the drift gate rebuilds the image. No
  rebuild time is on record: the 10-07 bump runbook left it unmeasured, and the
  09-01 bump (0.3.207 -> 0.3.245, first live proof of the drift rebuild)
  recorded only the result, a 3.04 GB image. Unmeasured.
- The eval gate (step g) runs before the stop, with zero downtime.

Expect about a minute of stopped service before `deploy.sh`, plus the image
rebuild.

## Sequence

### (g) Eval gate first, from a copy, while mission-control runs
House rule: the gate must PASS before deploy, with the result logged to
`/root/eval-gate-20261109.log`. The gate can run from a copy with the new SDK
while the service keeps running, and its verdict is valid for the live
deploy:
- **Same source.** The copy's `src/`, `scripts/`, `prompt_modules/` and config are byte-identical
  to HEAD (checked below). The baseline is `src/tuning/eval-baseline.json`
  inside the copy, the v4 incumbent 78.63 (`f606d04`).
- **Same cases.** The gate snapshots the db named by `MC_DB_PATH` (a
  read-only `VACUUM INTO` into a temp dir), so it reads the live `mc.db`.
- **Same env.** `loadLiveEnv()` copies the running service's environment from
  `/proc/<MainPID>/environ`, with names already in your shell winning. This only
  works while the service RUNS. With the service stopped, the gate would run
  without the service env, so the live-tree gate after (b) is not equivalent.
- **The only difference** is the SDK 0.3.316 / CLI 2.1.316, which is the change under test.
- **Path catch.** The service env sets `MC_DB_PATH` to a RELATIVE `./data/…`
  path, and the copy has no `data/`. Set `MC_DB_PATH` to the absolute live path on
  the command line, as below. Do not pass `--percase-out` from the copy: it
  needs a git checkout to prove the target is ignored and refuses otherwise.
- **Residual, what the gate does not measure.**
  - The CLI child's cwd is the copy path, and the copy has no `.git`.
    Auto-memory is off and `settingSources: []` loads nothing from the cwd.
    Whether the CLI puts the cwd text (or a git-status block) into a request
    that carries a custom system prompt was not verified. If it does, the
    difference is a few tokens.
  - The gate's probe tools (`buildProbeTools` in `src/inference/claude-sdk.ts`)
    carry no `alwaysLoad`/deferred metadata, and inline tools all load up
    front. The gate does not reproduce the live core/deferred split, so it
    measures the 4,096 cap but not the 16,384 ToolSearch path. That path is
    how `google_workspace_cli`, `infographic_generate` and
    `video_html_compose` reach the model in production.
  - The gate registers no MCP servers (`eval-gate.ts`: "no MCP servers"), so
    MCP-bridged tool descriptions over 2,048 characters are neither measured
    nor gated.
  - The auto-memory fix is not exercised by the gate: the copy's cwd maps to
    an empty memory dir, so a regression could not show there. The evidence is
    the binary reading above plus the request-shape pins in
    `src/inference/claude-sdk.test.ts`. The audit's two mutants against those
    pins (M1, M2) both went RED.

```bash
rsync -a --exclude=/.git --exclude=/data --exclude='/.env*' --exclude=/dist --exclude=/.claude --exclude='/node_modules/.cache' /root/claude/mission-control/ /root/tmp-sdk-bump-gate/
git -C /root/claude/mission-control rev-parse --short=8 HEAD > /root/tmp-sdk-bump-gate/GATE_HEAD    # the HEAD the copy was taken from
cd /root/tmp-sdk-bump-gate && npm install @anthropic-ai/claude-agent-sdk@0.3.316 --save-exact && npm install-scripts ls
for d in src scripts prompt_modules; do diff -rq /root/claude/mission-control/$d $d; done && echo SOURCE-IDENTICAL
grep -o '"claudeCodeVersion": *"[^"]*"' node_modules/@anthropic-ai/claude-agent-sdk/package.json    # 2.1.316
```
Anchor the excludes with a leading `/`. A bare `--exclude=dist` also strips every
`node_modules/*/dist` (hono, the MCP SDK and others), and `tsc` and `tsx` then fail.

Run a free DRY pass in both trees (exit 3) and compare their `[eval-gate]` lines.
`registered N tools`, `cases=` and the classifier prompt sha must match:
```bash
cd /root/claude/mission-control && npm run eval:gate 2>&1 | grep '^\[eval-gate\]'
cd /root/tmp-sdk-bump-gate && MC_DB_PATH=/root/claude/mission-control/data/mc.db npm run eval:gate 2>&1 | grep '^\[eval-gate\]'
```
Then the paid run (about $6 and 25 min on 11-07: 278 cases, $6.12, 1473 s):
```bash
cd /root/tmp-sdk-bump-gate && MC_DB_PATH=/root/claude/mission-control/data/mc.db npm run eval:gate -- --run 2>&1 | tee /root/eval-gate-20261109.log; RC=${PIPESTATUS[0]}; { echo "sdk claudeCodeVersion=$(node -p "require('/root/tmp-sdk-bump-gate/node_modules/@anthropic-ai/claude-agent-sdk/package.json').claudeCodeVersion")"; echo "head=$(cat /root/tmp-sdk-bump-gate/GATE_HEAD)"; echo "exit $RC"; } | tee -a /root/eval-gate-20261109.log
```
The run takes about 25 minutes. Start it from a detached terminal (tmux or
screen) so a dropped connection does not kill a paid run. Do not wrap the line
in `nohup bash -c '…'`: the single quotes inside `require('…')` end the wrapper's
string, the version line logs empty, and the script refuses the log (a wasted
paid run).
- Its first line must show `livePid=<the running pid>` and
  `db=/root/claude/mission-control/data/mc.db (snapshot)`.
- The line appends three lines to the log, in this order:
  - `sdk claudeCodeVersion=<CLI version>`, read from the COPY's installed SDK.
    It must be `2.1.316`.
  - `head=<8-char sha of the live HEAD when the copy was taken>` (from `GATE_HEAD`).
  - `exit <code>` as the LAST line.

  The script (step a) refuses a log without `sdk claudeCodeVersion=2.1.316`, so a
  PASS from a 0.3.285 run cannot satisfy it. It also refuses a log whose last line
  is not `exit 0`, and a `head=` whose code, prompt or package paths differ from
  the current HEAD. A later docs-only commit is accepted with a note.
- PASS = `VERDICT: PASS` and `exit 0`. On exit 1 (FAIL) or exit 2 (no verdict),
  do not bump. See the description-cap note above.
- Do not pass `--update-baseline`.
- Remove the copy after the deploy: `rm -rf /root/tmp-sdk-bump-gate`.

### (a) Check the working tree and in-flight tasks (the script does this)
```bash
cd /root/claude/mission-control && git status --porcelain
sqlite3 -readonly /root/claude/mission-control/data/mc.db "SELECT COUNT(*) FROM tasks WHERE status='running';"
```
- Expect only ` M .claude/agent-memory/qa-auditor/MEMORY.md` plus this
  directory (untracked, or modified if it was committed earlier).
- Wait for 0 running tasks. A task left `running` by the stop makes
  `deploy.sh` BLOCK without `--force`. Rituals also run inference, so pick a
  quiet window.
- The script also checks:
  - package files, `.npmrc`, `src/`, `scripts/`, `prompt_modules/`,
    `tsconfig.json` and `vitest.config.ts` are unchanged since `cb6b9a5e`;
  - the index is empty;
  - `npm -v` is 12.x;
  - the gate log has `VERDICT: PASS` and `sdk claudeCodeVersion=2.1.316`, its
    `head=` is HEAD (or differs only outside those paths), and its last line is
    `exit 0`.

### (b) Stop the service
```bash
systemctl stop mission-control
```

### (c) Install
Do not pass `--ignore-scripts`. `allowScripts` in package.json decides which
install scripts run.
```bash
cd /root/claude/mission-control && npm install @anthropic-ai/claude-agent-sdk@0.3.316 --save-exact && npm install-scripts ls
```
- Expect `No packages with unreviewed install scripts.`
- The script then checks:
  - the exact pin in package.json;
  - that `git diff HEAD -- package.json` is exactly one line pair, the SDK pin;
  - `claudeCodeVersion` 2.1.316;
  - the binary sha256 against `manifest.json`;
  - that the lockfile changed only `@anthropic-ai/claude-agent-sdk*` entries plus the root pin.
- The scratch lockfile sha256 is `f122cb34…462e`. A mismatch is only a note,
  because the scope check is the gate.

### (d) Patch: none
No code change is needed:
- tsc is clean on 0.3.316.
- The type delta is additive, with no removed or changed name the repo uses.
- All three auto-memory/sync levers hold.
- The behaviour changes in the changelog either do not reach Jarvis or are measured
  by the gate (the description cap).

The comment in `claude-sdk.ts` that names `DS()` "in 0.3.285" stays accurate as
history. The 0.3.316 equivalent is `yh()`.

### (e) Typecheck and scoped tests
```bash
./node_modules/.bin/tsc --noEmit
systemd-run --scope -p MemoryMax=6G -p MemorySwapMax=0 --quiet -- npx vitest run src/inference/ src/runners/fast-runner.test.ts src/lib/v8-4/ src/audit/critic.test.ts
```
Scratch results on 0.3.316: tsc clean. The scope above passed 34 files and
1197/1197 tests. `src/inference/claude-sdk.test.ts` on its own passed
173/173, including the `settings` pin (sync opt-out + `autoMemoryEnabled: false`)
and the `CLAUDE_CODE_DISABLE_AUTO_MEMORY` env pin. These tests mock `query()`,
so they prove the request shape, not the CLI's behaviour. The CLI side is the
binary evidence above.

### (f) Commit (the script does this)
The script stages `package.json` and `package-lock.json`, refuses any other
staged path, and commits with the message below. If this directory is
untracked or modified, it then commits it as a separate docs-only commit, so a
revert of the bump keeps the record. If the directory is already tracked and
clean, it skips that commit and says so.
```
deps: Claude Agent SDK 0.3.285 -> 0.3.316 (CLI 2.1.316)

0.3.316 (published 2026-10-31) is the newest release past
min-release-age=7; 0.3.317-0.3.319 are younger than 7 days. Peer
ranges unchanged (zod ^4.0.0, @anthropic-ai/sdk >=0.93.0,
@modelcontextprotocol/sdk ^1.29.0); engines.node moves to >=18.14.0.
The lockfile changes only the SDK and its 8 platform packages; npm audit
unchanged (33); npm 10 ci on the new lockfile: 0 peer warnings, 0 ERESOLVE.

Type delta is additive: no removed exports or Options keys;
ThinkingConfig, EffortLevel, TerminalReason, HookCallback/HookInput/
HookJSONOutput, StopHookInput, SdkMcpToolDefinition unchanged; ModelUsage
gains the 5m/1h cache-creation split, Settings gains auto-mode and
attribution keys, SDKResultSuccess gains two remote-latency fields.
tsc clean, no code change.

Auto-memory fix (8311e655) holds on CLI 2.1.316: autoMemoryEnabled is
still read from the merged settings, CLAUDE_CODE_DISABLE_AUTO_MEMORY is
still checked first and a truthy value still returns "off" before the
setting is consulted, and the syncClaudeAiSkills/syncClaudeAiPlugins
opt-out is still honoured from --settings.

Model-visible behaviour change: the CLI's cap on MCP tool descriptions
(in-process SDK servers included) rose from 2,048 to 4,096 characters up
front and 16,384 for tools loaded through tool search (armed in
production), so 6 registry tools over 2,048 characters now reach the
model longer or in full. The eval gate must PASS on this version before
deploy; its probe tools all load up front, so it measures the 4,096 cap,
not the tool-search path.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Kn6Qryrcb6iw5w92juWkRC
```

### (h) Deploy
```bash
cd /root/claude/mission-control && ./scripts/deploy.sh
```
Expect:
- `[deploy] Migration gate OK …`
- `[deploy] Sandbox image lockfile drift (image=… host=f122cb34472e…) — rebuilding mission-control:latest...`
- `[deploy] OK — newPid=… build=<HEAD sha>…`. HEAD is the docs commit on top
  of the bump. A `+dirty` suffix can only come from the modified qa-auditor
  MEMORY.md.

Add `--force` only if step (a) left orphaned `running` rows.

### (i) Smoke checks (never print prompt or message text)
```bash
curl -s localhost:8080/health | head -c 400; echo
journalctl -u mission-control --since "-5 min" -o cat | grep -E 'SONNET_MODEL_ID override|\[mc\] Tool source "builtin" initialized|\[claude-sdk\] Completed:' | head -5
journalctl -u mission-control --since "-15 min" -o cat | grep -cE 'does not support this model|or newer is required|startup_failure'
sqlite3 -readonly /root/claude/mission-control/data/mc.db "SELECT id, created_at, agent_type, model, cost_usd FROM cost_ledger ORDER BY id DESC LIMIT 3;"
```
- `SONNET_MODEL_ID override` names the same id as before the deploy.
- `Tool source "builtin" initialized (N tools)` with N the same as before.
- The count of version refusals must be `0`.
- The first ledger row after the restart carries a real model id and
  `cost_usd` > 0. If no task runs, send one Telegram chat message. The
  `Completed:` line holds counts, cost and tokens only.

### (j) Tool-search contract re-validation (paid, about $0.80, live tree)
Run this only while tool search is armed in the service env
(`TOOL_SEARCH_ENABLED` true). It is armed as of 2026-11-09, so run it.
```bash
cd /root/claude/mission-control && npx tsx scripts/validate-tool-search.ts --run
```
All five phases must PASS. It covers `terminal_reason`, `deferred_tool_use`
and `_meta['anthropic/alwaysLoad']`, which the CLI's tool-search changes in
2.1.287-2.1.314 touch. It snapshots `data/mc.db` relative to the script, so
it runs in the live tree, not the copy. Push after (h)-(j) pass
(`gh auth status` first).

## Rollback

The script failed before the bump commit. The files may already be staged, so
it restores both the index and the worktree from HEAD (a plain
`git checkout -- <file>` restores from the index and does nothing once the files are staged).
It prints this line:
```bash
cd /root/claude/mission-control && git checkout HEAD -- package.json package-lock.json && npm ci && npm install-scripts ls && systemctl start mission-control
```
The script failed after the bump commit (for example in the docs commit). It
prints the post-(f) line with the real sha, and the service is still stopped:
```bash
cd /root/claude/mission-control && [git reset -q -- docs/planning/sdk-bump-2026-11-09 && ]git revert --no-edit <sha> && npm ci && npm install-scripts ls && systemctl start mission-control
```
The bracketed unstage is printed only when the runbook dir was staged, because
`git revert` refuses a dirty index.
`dist/` was not rebuilt, so the start runs the previous build on the restored
`node_modules`. `npm ci` took 26 s fresh with npm 10 and `--ignore-scripts`.
The live run also runs the allowScripts packages, so it takes longer.

After the script finished, whether or not (h) ran (`<sha>` = the bump commit). The tree
carries no WIP this time, so `git revert` works:
```bash
cd /root/claude/mission-control && git revert --no-edit <sha>
systemctl stop mission-control && npm ci && npm install-scripts ls && ./scripts/deploy.sh
```
`deploy.sh` sees lockfile drift again and rebuilds the image back to 0.3.285.
If (h) never ran, `systemctl start mission-control` after `npm ci` is
enough, because `dist/` is still the old build.
