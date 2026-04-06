---
name: v62-v1-tts-audit
description: v6.2 V1 TTS engine upgrade audit — listVoices dashes bug, splitText contract violation, orphaned _parts dirs, dead generatePerSceneTTS
type: project
---

v6.2 V1 TTS Engine Upgrade audit (2026-04-06). PASS WITH WARNINGS.

**Critical**: 2 issues

- `listVoices` `slice(1)` skips header but not dashes separator → garbage voice entry
- `splitTextAtSentences` returns oversized chunks when no sentence boundaries exist (contract violation)

**Warnings**: 6 issues

- `_parts` temp dirs never cleaned up after multi-chunk concat
- `probeAudioDuration` returns 0 on failure; `video_tts` tool reports it as real duration
- `video_tts` duplicates voice resolution logic instead of using `resolveVoice()`
- `video_list_voices` unfiltered result ~10.7KB, close to 12K `MAX_TOOL_RESULT_CHARS`
- `generatePerSceneTTS` exported but zero consumers (dead code)
- `edgeTtsSingle` fallback silently truncates at 2000 chars mid-word

**Key files**: `src/video/tts.ts`, `src/tools/builtin/video.ts`, `src/video/tts.test.ts`

**Why:** TTS upgrade for per-scene audio with voice selection. Edge-tts free provider.
**How to apply:** Fix C1 (slice(2) or skip-dashes guard) and C2 (hard-split fallback) before merge. W1 (temp cleanup) and R1 (async exec) are performance-critical for production.
