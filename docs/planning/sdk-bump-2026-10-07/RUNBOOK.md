# Runbook: Claude Agent SDK 0.3.245 -> 0.3.285 (mission-control / Jarvis)

Prepared 2026-10-07 in a scratch copy of the live working tree. Nothing under
`/root/claude/mission-control` was edited, installed or restarted. Every step
below is for the operator.

`P=/root/claude/mission-control/docs/planning/sdk-bump-2026-10-07`
(holds `sdk-bump.patch`)

## Why 0.3.285
- Bundled CLI 2.1.285 (`claudeCodeVersion` in package.json, `VERSION:"2.1.285"` in
  the linux-x64 binary, binary sha256 matches `manifest.json`). This clears the
  "2.1.280 or newer is required" refusal for Opus 5.5: the binary contains
  `claude-opus-5-5` (53 occurrences), while the live 0.3.245 binary has none.
- Newest version past `min-release-age=7` (published 2026-09-29 17:35 UTC).
  0.3.286 becomes eligible around 2026-10-07 17:17 UTC. Latest is 0.3.292.
- Peer deps unchanged (`zod ^4`, `@anthropic-ai/sdk >=0.93.0`, `@modelcontextprotocol/sdk ^1.29.0`).

## Expected downtime
Measured on the scratch copy:
- `npm install` on a copy of the live `node_modules`: 11 s.
- `tsc --noEmit`: 15 s.
- `deploy.sh`: migration preflight, then build, then a **sandbox image rebuild**
  (the lockfile changes, so the lockfile-drift gate triggers it). The image rebuild
  was not measured here; the last one produced a 3.04 GB image.
- Rollback `npm ci`: 27 s fresh with npm 10 and `--ignore-scripts`. The live run
  also runs the allowScripts packages, so it takes longer.

Expect a few minutes of downtime, mostly the image rebuild.

## Sequence

### (a) Check the working tree and in-flight tasks
```bash
cd /root/claude/mission-control && git status --porcelain
```
Expect the 13 modified files from the eval-scoring-v3 session, including
`src/inference/claude-sdk.ts` and `src/inference/claude-sdk.test.ts`.
`deploy.sh` builds that work in progress into the binary, and its build line
will read `build=<sha>+dirty`. Do NOT `git stash` or `git checkout` those files.

```bash
sqlite3 -readonly /root/claude/mission-control/data/mc.db "SELECT COUNT(*) FROM tasks WHERE status='running';"
```
Wait for 0. A task that is still `running` when you stop the service is left
as `running` in the db, and `deploy.sh` will then BLOCK unless you pass
`--force`.

### (b) Stop the service
```bash
systemctl stop mission-control
```

### (c) Install
Do not pass `--ignore-scripts`. `allowScripts` in package.json decides which
install scripts run.
```bash
cd /root/claude/mission-control && npm install @anthropic-ai/claude-agent-sdk@0.3.285 --save-exact && npm install-scripts ls
```
Expect: `No packages with unreviewed install scripts.`

In scratch, the lockfile diff touched only the SDK and its 8 platform packages.
`npm audit` stayed at 35 (2 low, 11 moderate, 17 high, 5 critical), the same as
before. `npx -y npm@10 ci --ignore-scripts` on the new lockfile installed 419
packages with 0 peer warnings and 0 ERESOLVE errors, so it is CI-safe. Optional
check:
```bash
grep -o '"claudeCodeVersion": *"[^"]*"' node_modules/@anthropic-ai/claude-agent-sdk/package.json   # 2.1.285
```

### (d) Apply sdk-bump.patch (it touches claude-sdk.ts, which holds the other session's WIP)
The patch adds `settings: { syncClaudeAiSkills: false, syncClaudeAiPlugins: false }`
to the SDK options, plus a spec pin. It typechecks on 0.3.245 as well, because
`Settings` has a `[k: string]: unknown` index signature. On CLI 2.1.245 the
plugin key is simply unknown; the skills key already existed there.

Apply it to the INDEX against HEAD (this stages only the patch) and to the
WORKING TREE on top of the WIP:
```bash
cd /root/claude/mission-control && git apply --cached --check $P/sdk-bump.patch && git apply --cached $P/sdk-bump.patch && patch -p1 < $P/sdk-bump.patch
```
Verified in scratch:
- `patch --dry-run` applies cleanly to the current live WIP files.
- It also applies to HEAD, with offsets.
- After both applies, `git diff --cached` contains only the 31 added lines, and
  `git diff` (the unstaged WIP) contains no `syncClaudeAi` line.

### (e) Typecheck and run the scoped tests
```bash
./node_modules/.bin/tsc --noEmit
npx vitest run src/inference/claude-sdk.test.ts
```
Scratch results (WIP + 0.3.285 + patch):
- tsc clean.
- `src/inference/`, `src/runners/fast-runner.test.ts`, `src/lib/v8-4/` and
  `src/audit/critic.test.ts`: 32 files, 1004/1004 tests passed.
- Mutation check: removing the `settings` line turns the new pin RED.

### (f) Commit (stages only the bump, never the WIP)
```bash
git add package.json package-lock.json
git diff --cached --stat   # expect: package.json, package-lock.json, src/inference/claude-sdk.ts (+8), src/inference/claude-sdk.test.ts (+23)
git commit -m "deps: Claude Agent SDK 0.3.245 -> 0.3.285 (CLI 2.1.285) to reach Opus 5.5

CLI 2.1.245 refused claude-opus-5-5 (400: 2.1.280 or newer is required).
0.3.285 is the newest release past min-release-age=7. The type delta is
additive only: no removed exports or Options keys, ThinkingConfig/EffortLevel/
TerminalReason unchanged, ModelUsage gains costBasis + thinkingTokens.

Opt out of the claude.ai skill/plugin sync (CLI 2.1.275+): the operator
account syncs 13 skills and the 'data' plugin, and the CLI re-syncs plugins at
every launch of a session signed in with that account. settingSources: [] does
not gate it; the --settings layer does. Pinned by spec.

System-prompt snapshot (CLI 2.1.267) needs no change: Jarvis never resumes
(persistSession: false) and passes one string per query()."
```
The pre-commit hook runs the full suite on the working tree, so the WIP tests
run in it too.

### (g) Deploy
```bash
./scripts/deploy.sh
```
Add `--force` only if step (a) left orphaned `running` rows. Expect:
- `Sandbox image lockfile drift … rebuilding`
- `[deploy] OK — newPid=… build=<sha>+dirty`

### (h) Smoke checks
```bash
curl -s localhost:8080/health | head -c 400; echo
journalctl -u mission-control --since "-5 min" -o cat | grep -E 'SONNET_MODEL_ID override|\[mc\] Tool source "builtin"'
sqlite3 -readonly /root/claude/mission-control/data/mc.db "SELECT id, created_at, agent_type, model, cost_usd FROM cost_ledger ORDER BY id DESC LIMIT 3;"
```
- `SONNET_MODEL_ID override` should read `claude-sonnet-5-5` (the `.env` default since 10-07 02:44 UTC).
- `Tool source "builtin" initialized (162 tools)`.
- The first ledger row written after the restart should carry a real model id
  and `cost_usd` > 0. Send one Telegram chat message if no task runs.

### (i) Tool-search contract re-validation (paid, about $0.80)
```bash
npx tsx scripts/validate-tool-search.ts --run
```
All five phases must PASS. It validates `terminal_reason`, `deferred_tool_use`
and `_meta['anthropic/alwaysLoad']`, which are coupled to the SDK version.

### (j) Eval gate: BLOCKED
`npm run eval:gate -- --run` cannot give a verdict right now. The working
tree's scoring v3 (WIP) does not match the v2 incumbent baseline, so
`preSpendPopulationRefusal` exits 2 before spending anything. Record the bump
as "eval gate deferred until the scoring-v3 baseline is re-captured". Do not
pass `--update-baseline` to get past it.

### (k) Opus 5.5 reachability (paid, a few cents; cap $1)
```bash
npx tsx scripts/benchmark-opus-tier.ts --models=claude-opus-5-5 --configs=A --tasks=b8e2700a --run --max-usd=1
```
This is stage 1 on one single-goal task: plan, reflect and selfAssess, with no
tools. Before the bump this returned the 400 version refusal. PASS means no
`does not support this model` in the output, and the rows in the results dir
show the model as `claude-opus-5-5`.

## Rollback

Before step (f) (nothing committed):
```bash
cd /root/claude/mission-control
git apply --cached -R $P/sdk-bump.patch 2>/dev/null; patch -R -p1 < $P/sdk-bump.patch
git checkout -- package.json package-lock.json      # safe: neither file carries WIP
systemctl stop mission-control && npm ci && npm install-scripts ls && ./scripts/deploy.sh
```

After step (f) (`<sha>` = the bump commit). Do not use `git revert`: it refuses
because `claude-sdk.ts` carries WIP.
```bash
cd /root/claude/mission-control
git show --format= <sha> | git apply -R --cached && git show --format= <sha> | patch -R -p1
git commit -m "Revert SDK bump <sha> (0.3.285 -> 0.3.245)"
systemctl stop mission-control && npm ci && npm install-scripts ls && ./scripts/deploy.sh
```
Both flows were verified in a scratch git repo: the working tree returns
byte-identical to the live WIP. Rolling back the patch is optional. It is
harmless on 0.3.245 (it typechecks there, and the skills opt-out is honored
there too), so you can roll back only package.json and package-lock.json.
