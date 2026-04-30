# Xpoz Upstream API Key — Rotation + History Scrub Plan

**Status:** drafted 2026-04-30, awaiting execution.
**Trigger phrase next session:** "execute the xpoz secret rotation plan."
**Repo affected:** `EurekaMD-net/xpoz-intelligence-pipeline-manager` (PUBLIC).
**Asset at risk:** xpoz.ai upstream-scraper Bearer token, account `peter.blades@gmail.com`, no expiration.

## Why

`xpoz-pipeline/config.ts:7` hardcodes the upstream Bearer token. Repo is public, so the token has been indexed by GitHub search since at least commit `105f741` (initial Phase-1 commit). The token also lives in `xpoz-pipeline/.env` as `XPOZ_API_KEY`, but the running code reads from the hardcoded `XPOZ_CONFIG.apiKey` (xpoz-client.ts:41), not the env var. So the env mirror is dead code today.

This is a single-secret leak in a small repo (4 commits touch the file, 1.5 MB total `.git`, 3 refs) — fast to rewrite. Mitigation requires rotation AND history scrub AND force-push, in that order.

## Pre-flight (do once before execution, can do this session if you want)

- [ ] Confirm `mcp.xpoz.ai` dashboard supports self-service rotation. If not, contact support and adjust step 1 to "request a new key, get the old one revoked manually."
- [ ] Inventory clones — if the repo is cloned elsewhere (other VPS, laptop, collaborators), list them. Each will need re-clone after force-push.
- [ ] Confirm no CI/CD pipeline depends on the repo's git history (would break on force-push).

## Execution (next session, sequential — do not skip steps)

### Step 1 — Rotate the key on xpoz.ai (manual, user)

1. Log in to `mcp.xpoz.ai` dashboard with `peter.blades@gmail.com`.
2. Issue a new API key.
3. Capture the new key value — we'll need it in step 2.
4. **Do NOT revoke the old key yet** — we want pipeline continuity through step 5.

### Step 2 — Plant new key in `.env`

- Edit `/root/claude/projects/xpoz-pipeline/.env` and replace the `XPOZ_API_KEY=` value with the new key.
- Verify line ending matches existing format. Don't change `XPOZ_API_TOKEN` (different credential — local auth gate).

### Step 3 — Wire `config.ts` to read from env (fail-loud)

Replace `xpoz-pipeline/config.ts:7` from:

```ts
apiKey: "<LEAKED_KEY>",
```

to (recommended pattern, fails at startup if env not set):

```ts
apiKey: (() => {
  const k = process.env.XPOZ_API_KEY;
  if (!k) throw new Error("XPOZ_API_KEY missing — check xpoz-pipeline/.env");
  return k;
})(),
```

Trade-off: this evaluates at module load. Acceptable because the pipeline is a long-lived server, not a CLI tool. Alternative: read at request time in `xpoz-client.ts` instead.

### Step 4 — Restart and verify still works

```bash
systemctl restart xpoz-pipeline
sleep 2
systemctl is-active xpoz-pipeline
journalctl -u xpoz-pipeline --since "30 sec ago" | grep -i error  # should be empty
# probe with the LOCAL token (XPOZ_API_TOKEN, not the one we just rotated)
curl -sS -X POST http://localhost:8086/run \
  -H "Content-Type: application/json" \
  -H "X-Xpoz-Token: $LOCAL_TOKEN" \
  -d '{"label":"post-rotation-probe","subreddits":["longevity"],"keywords":["longevity"],"notify":false,"force":false}'
# expect: {"jobId":"…","status":"started",…}
# wait 90s, check /run/jobs/<jobId> shows status=completed
```

If rotation broke the upstream call, you'll see a 401 from `mcp.xpoz.ai` in the run result. Roll back: revert `.env` to old key, restart, debug.

### Step 5 — Revoke old key on xpoz.ai (manual, user)

After step 4 succeeds: go back to xpoz.ai dashboard and revoke the old key. From this point, the leaked history is dead — the only meaningful exposure is mitigated.

### Step 6 — Commit the env-loading change

```bash
cd /root/claude/projects/xpoz-pipeline
git add config.ts
git commit -m "fix(security): read XPOZ_API_KEY from env, drop hardcoded bearer

Old hardcoded token was leaked in this repo's history (public repo,
4 commits since 105f741). Token has been rotated and revoked on
mcp.xpoz.ai; this commit + the next history-scrub commit close the
exposure for current and future state. The leaked key is dead.

Co-Authored-By: <whoever>"
```

**Do not push yet** — push happens after history scrub in step 8.

### Step 7 — Scrub git history with `git-filter-repo`

Backup first:

```bash
cd /root/claude/projects/xpoz-pipeline
cp -r .git .git.bak-pre-filter-repo-$(date +%Y%m%d-%H%M%S)
```

Build replacement file. **Read the literal key value from `xpoz-pipeline/config.ts:7` at execution time** — do not paste it into this plan or any committed file in mc:

```bash
LEAKED_KEY=$(grep -oP 'apiKey: "\K[^"]+' /root/claude/projects/xpoz-pipeline/config.ts)
echo "$LEAKED_KEY==>***REMOVED-LEAKED-KEY***" > /tmp/xpoz-secret-replace.txt
unset LEAKED_KEY
```

Run filter-repo (this rewrites all matching commits across all refs):

```bash
git filter-repo --replace-text /tmp/xpoz-secret-replace.txt --force
```

Notes:

- `--force` is required because the working tree has uncommitted changes (your step-6 commit will be re-applied automatically — filter-repo preserves it as it's already in HEAD).
- filter-repo strips the `origin` remote as a safety net. Re-add it: `git remote add origin https://github.com/EurekaMD-net/xpoz-intelligence-pipeline-manager.git`.
- Verify scrub:

```bash
# Use the first 6 chars of the leaked key, read fresh from config.ts
PREFIX=$(grep -oP 'apiKey: "\K.{6}' /root/claude/projects/xpoz-pipeline/config.ts 2>/dev/null || echo "<<read from config.ts manually if the file is already updated>>")
git log -p --all -S "$PREFIX"   # should return nothing
git log -p --all -S "***REMOVED-LEAKED-KEY***" | head  # should show the redactions
unset PREFIX
```

Delete the replacement file: `rm /tmp/xpoz-secret-replace.txt`.

### Step 8 — Force-push to GitHub (THE DESTRUCTIVE STEP)

**Confirm before running:** make sure no other clones have unpushed commits, and tell collaborators (if any) that history is about to be rewritten.

```bash
git push --force-with-lease origin main
git push --force --tags origin
```

`--force-with-lease` aborts if the remote has commits we don't know about — safer than plain `--force`.

### Step 9 — Verify GitHub state

- Open the repo on github.com.
- Check that the commit graph length matches local (`git log --oneline | wc -l` vs UI commit count).
- Visit any old commit that historically contained the key — confirm it shows `***REMOVED-LEAKED-KEY***` instead.
- Search code with the first 6 chars of the leaked key as the query: `https://github.com/search?q=repo%3AEurekaMD-net%2Fxpoz-intelligence-pipeline-manager+<first-6-chars>` should return zero results (cache may take a few hours to update). Read those 6 chars from `xpoz-pipeline/config.ts` BEFORE running step 3.

### Step 10 — Re-clone any local clones, kill old caches

- Any other machine with this repo cloned: blow away the local clone and `git clone` fresh. Their history is irrecoverably diverged from origin.
- If the dist/ artifacts contain the old key, rebuild them: `cd /root/claude/projects/xpoz-pipeline && npm run build`.

## Rollback plan

If anything breaks before step 8, you can recover:

- Restore `.git.bak-pre-filter-repo-*` over `.git`.
- Roll the `.env` change back.
- Old key still works until you've revoked it (step 5).

After step 8 (force-push) there is no rollback — the old history is gone from origin. That's the intended state, but be sure before pressing execute.

## Risk assessment

| Risk                                                         | Likelihood       | Impact                              | Mitigation                                                                                                                                |
| ------------------------------------------------------------ | ---------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| xpoz.ai doesn't support self-service rotation                | Low-Med          | Plan stalls at step 1               | Pre-flight check; fall back to support ticket                                                                                             |
| Force-push collides with collaborator's pushed commits       | Low (solo repo?) | Their commits get orphaned          | `--force-with-lease`; pre-flight inventory                                                                                                |
| Leak scanners (truffleHog, GitGuardian, etc.) cached the key | High             | None after step 5 — old key revoked | Rotation is the real fix; scrub is hygiene                                                                                                |
| dist/ build artifacts contain old key                        | Low              | Local-only                          | Rebuild after step 9                                                                                                                      |
| Other commits in mc git history referencing the key value    | Unknown          | Depends on findings                 | Run `git log -p --all -S "$LEAKED_PREFIX"` in mc repo before fire (read prefix from config.ts) — if hits, this plan needs to expand scope |

## Out of scope (deliberate)

- Migrating from the upstream xpoz.ai service — this plan keeps the same provider, just rotates and hides the key.
- Rotating the LOCAL `XPOZ_API_TOKEN` (the auth-gate token in `mission-control/.env`). That's a different credential, not leaked publicly, no action needed.
- Adding leak-detection hooks (truffleHog pre-commit, etc.) — that's a follow-up hardening item.
- Switching `XPOZ_CONFIG.apiKey` to be lazy-evaluated per-request rather than module-load. Current pattern is fine for a long-lived server.
