---
name: session-close
description: Close a working session on agent-controller by recording it in docs/ROADMAP.md (Session log row) and, for shipped code, a docs/PROJECT-STATUS.md Recent Changes row. Use at the end of every session, before opening or finalizing the PR.
---

# Session close: ROADMAP and status entries

`CLAUDE.md` says every session starts by reading `docs/ROADMAP.md` and ends by adding a Session log row there. A session that has not updated ROADMAP has not finished.

## 1. ROADMAP (every session)

1. Re-read `docs/ROADMAP.md` from the branch you are on (another session may have changed it).
2. Append one row to the **Session log** table: `| YYYY-MM-DD | <brief id> <short name> | [#<PR>](https://github.com/kosm1x/agent-controller/pull/<PR>) | <outcome: what changed, with the one number that proves it> | <follow-ups, or the next brief> |`. If the PR does not exist yet, open it first or fill the link in the same branch before merge.
3. Update the rows your session moved: the **Active bets** row (gate, next step), **Blocked on Fede** (add a decision only the operator can make; remove one that was answered), and the "Last updated" note in the header line.
4. Keep the page to one page (~60 lines). If it grows, move detail into the linked doc; never into ROADMAP.
5. If the session stopped because a gate failed or a premise was wrong, the row says so and names what is needed. That is a valid outcome.

## 2. PROJECT-STATUS (only when code that changes Jarvis's behavior shipped)

Docs-only and Claude Code config sessions skip this (a rule new in S1, 2026-10-03; earlier config changes sometimes got a row).

1. Add a row at the top of the `## Recent Changes` table: `| YYYY-MM-DD | <short sha or PR> | <what changed for Jarvis, deploy state, proof> |`. Say plainly whether it is DEPLOYED or "committed, not deployed" (deploy is operator-run; sessions never run `scripts/deploy.sh`).
2. Add a `> Last updated: YYYY-MM-DD (**<sha> — <one-line summary, deploy state>**)` note above the previous one at the top of the file.
3. Retention: rows older than 21 days move byte-for-byte to `docs/archive/status-history-YYYY-MM.md`, one file per month. Move, never rewrite or delete.

## 3. Rules

- The repo is public. No secrets, tokens, private chat text or personal data in either file.
- Do not quote an aggregate metric (success rate, cost, latency, cache hit) without `./mc-ctl audit-claim` (VPS only); in a cloud session say the figure is unaudited or leave it out.
