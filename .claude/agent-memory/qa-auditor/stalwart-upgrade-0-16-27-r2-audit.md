---
name: stalwart-upgrade-0-16-27-r2-audit
description: 2026-10-25 R2 audit of /root/upgrade-stalwart-0.16.27.sh; PASS WITH WARNINGS, C1+C2 FIXED, fully static (no signals, no container). Open: PHASE=installed set after the mv, a recovery line that pairs 0.16.27 data with the 0.16.12 binary, a 90 s SIGKILL budget under systemd-run
metadata:
  type: project
---

R2 verdict PASS WITH WARNINGS, 0 Critical. Everything was static: bash -n, shellcheck 0.9.0 (-S warning clean), reading the code, and read-only host probes. No container was used and no signal was sent. This round was run under the hard no-signal rule, because the previous R2 harness took the host down on 2026-10-24.

- C1 FIXED (line 162): `exec > >(trap '' INT HUP TERM PIPE; exec tee --output-error=warn -a LOG)`. SIG_IGN survives execve, and tee in warn mode drops the dead tty and keeps writing the log. `say` (line 170) falls back to `exec >>LOG` on EPIPE because PIPE is ignored. critical_signals (line 583) runs before PHASE=stopped (line 584). Children also inherit the ignored HUP and INT, so Ctrl-C cannot kill a backup tar halfway through.
- C2 FIXED: every step in harden_oauth and revert_oauth has an explicit `|| { say; return 1; }`. The callers are `if harden_oauth` (lines 506 and 613). verify_all and rollback use explicit fail flags.
- R1 W/R item text was never saved. R1 memory recorded only C1 and C2, so R2 could check only the author's claimed fixes.
- Verified live: the API digest equals the pin. The 0.16.12 WebUI bundle builds its redirect as `origin+base+/oauth/callback` and its post-logout redirect as `origin+base+/login`, with base `/admin` or `/account`. The meta tag is empty, so the client id is `stalwart-webui`. This matches the script's 8 URIs. The only vhost is mail.eurekams.net. eurekams-mail-ui uses Basic auth (not affected by --harden-oauth). Retained stalwart logs contain 0 oauth lines, so no OAUTHBEARER client is in use. The cert timer is Mon 04:40 UTC, about 28 h away.
- Open warnings:
  - W1: PHASE=installed is set after `mv -f`. A TERM between the two starts 0.16.27 unverified under the message "unchanged 0.16.12".
  - W2: the recovery lines at lines 404 and 414 put the 0.16.27-written data back under the 0.16.12 binary without saying so, and offer no retry of the extract.
  - W3: under systemd-run, DefaultTimeoutStopSec=90s can SIGKILL the TERM-triggered rollback.
  - W4: `tarball_ok` writes to $WORK, so a full disk reads as "tarball invalid".

CLASS: the PHASE marker must move BEFORE the irreversible step it describes, not after; the trap trusts the marker ([[ritual-boot-retry-arm-r1-audit]]).
CLASS: a recovery line printed after a partial rollback is a claim about WHICH binary and WHICH data pair up; check that the pairing is stated.

**How to apply:** for any later round on this script or a sibling operator script, re-check the order of PHASE against mv/install, and audit signal handling statically only (see [[stalwart-upgrade-0-16-27-r1-audit]]).
