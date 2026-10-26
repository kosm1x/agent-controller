---
name: stalwart-upgrade-0-16-27-r3-audit
description: 2026-10-25 R3 confirmation audit of /root/upgrade-stalwart-0.16.27.sh; PASS, all 10 R2 items FIXED; static only, no signals; the agent shell's grep is a ugrep function, but the script resolves GNU grep 3.11
metadata:
  type: project
---

R3 verdict PASS (0 Crit, 0 Warn, 3 low Recs). Fixed: W1 (line 646), W2 (recovery_options at line 437, called from lines 420 and 431), W3 (line 13 header), W4 (line 326), S1 (lines 559-566), S2 (line 384), Rec2 (line 310), Rec3 (lines 466-475), Rec4 (line 619), Rec5 (line 121). Every diff hunk traces to an R2 item.

Key check: `tar -tzf | grep -x ... >/dev/null` under pipefail with PIPE ignored is safe ONLY because GNU grep >= 2.28 reads all of a non-seekable stdin unless given -q/-l/-L/-m (NEWS.gz). The agent's Bash tool defines `grep` as a ugrep shell function (`type -a grep`), so `grep --version` in a Claude session prints ugrep 7.8.4. The script and systemd PATH get /usr/bin/grep, which is GNU 3.11. Verify with `env -i PATH=... bash -c 'grep --version'`.

Open (low): Rec3 `sleep 5` may be too short, so revert_oauth refuses a unit that is still "activating" and reports it DOWN. recovery_options trusts a pre-existing `stalwart.0.16.27` without a --version check. A TERM between line 646 and the mv rolls back untouched data while calling it "post-upgrade data".

CLASS: in an agent session, a tool's version banner can come from a shell function; resolve the binary the TARGET process will exec before reasoning about its flags. Related: [[stalwart-upgrade-0-16-27-r2-audit]], [[perf-sec-batchAB-r4-audit]] (rg not on the service PATH).
