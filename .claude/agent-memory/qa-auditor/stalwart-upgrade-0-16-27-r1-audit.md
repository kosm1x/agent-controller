---
name: stalwart-upgrade-0-16-27-r1-audit
description: 2026-10-24 R1 audit of /root/upgrade-stalwart-0.16.27.sh (operator-run binary upgrade + OAuth hardening); FAIL 2 Crit — tee-process-substitution kills the EXIT trap on SIGINT/SIGHUP, and errexit suppressed inside harden_oauth called via `||`
metadata:
  type: project
---

R1 verdict FAIL, 2 Critical.

C1 (measured in scratch): `exec > >(tee -a LOG)` + `trap on_exit EXIT`. A group signal (Ctrl-C, Panel disconnect = SIGHUP, TERM) kills tee too; the trap's FIRST `say` then dies of SIGPIPE, so the stopped-phase `systemctl start` / installed-phase rollback never runs. Trap entered = yes, line after echo = no, for INT/HUP/TERM; without tee all three complete.

C2: `harden_oauth || {...}` (line 494) disables errexit for the whole function body, so an H1 client-create failure still runs H2 (flags flipped) and prints "done". Same body called plainly at line 382 does exit.

Verified OK: pin == live API digest; `gh attestation verify` + its JSON parse returns refs/tags/v0.16.27 (gh is authenticated as root); WebUI bundle (card-*.js) falls back to client id `stalwart-webui` from `<meta name="oauth-client-id">` and redirect `${origin}${base}/oauth/callback` with base /admin or /account; `stalwart --version` prints bare `0.16.12`; log format `<iso> LEVEL ...`; `journalctl --since @epoch` works.

CLASS: a log tee via process substitution is in the same process group as the script; any cleanup trap that writes to stdout before acting is killed by SIGPIPE on the same signal that triggered it.
CLASS: a function relying on set -e for step ordering loses it when called from `||`/`if`/`&&`.

**Why:** operator-run infra scripts on this VPS run from a Panel terminal whose connection drops frequently.
**How to apply:** for any operator script with a stop/restore trap, check signal + tee interaction and every call site's errexit context. Related: [[multi-round-audit-until-pass]].
