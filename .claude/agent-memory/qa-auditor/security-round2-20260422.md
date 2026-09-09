---
name: security-round2-20260422
description: Round 2 security audit verifying round-1 fixes — 3 residual criticals (pdf-read SSRF+path, gemini local-path, google-docs/drive/wp contentFile), 2 majors (shell cat bypass, XFF spoof)
type: project
---

# Round 2 Security Audit — 2026-04-22

**Why:** Methodology requires two rounds for Security. Round 1 fixed 7 findings; round 2 caught 3 residual criticals where round 1's fix was correct-but-incomplete (one exfil surface closed, neighbors on same tool left open) plus 2 majors in overlooked adjacent paths.

**How to apply:** When auditing round-1 fixes that add denylists/allowlists, ALWAYS grep for every caller of the guard — round 1 tends to fix the caller that triggered the audit, not the class of bug across all callers. Specifically: contentFile / local-path branches that parallel fixed URL branches (gemini-research, wordpress, google-docs, google-drive, pdf-read). Also always check shell.ts for a command that bypasses path-level denylists (`cat` reads any file and its output flows back to LLM unchanged).

## Key Residual Findings

1. **pdf-read.ts unguarded** — neither URL (SSRF) nor local-path (exfil) validated
2. **gemini-research.ts local-path branch** — round 1 guarded URL branch at line 266, local branch at line 298-306 still reads any path
3. **contentFile exfil pattern** — google-docs.ts:494/603, google-drive.ts:521, wordpress.ts:551 accept arbitrary absolute path and readFileSync; LLM can set contentFile=/root/.claude/.credentials.json and upload it
4. **shell_exec `cat` bypass** — READ_BLOCKED_PATHS defense-in-depth is moot because DENY_COMMANDS has no `cat`, `head`, `tail`, `less`, `xxd`, `od`. LLM does `shell_exec({ command: "cat /root/.claude/.credentials.json" })` → output in tool result
5. **symlink escape** — validatePathSafety uses `resolve()` not `realpathSync()`. `ln -s /root/.claude/.credentials.json /tmp/safe` + `file_read("/tmp/safe")` bypasses the denylist
6. **XFF spoof** — server binds 0.0.0.0, port 8080 UFW-open directly. Rate limiter trusts XFF first-token, attacker spoofs random IPs to defeat per-IP window
7. **admin drive-backfill** — X-Api-Key only, no X-Kill-Passphrase. Leaked key triggers mass Drive writes
