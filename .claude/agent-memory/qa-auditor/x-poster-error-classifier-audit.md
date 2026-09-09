# x-poster error classifier audit (2026-06-23)

PASS WITH WARNINGS. Fix for the 2026-06-23 `tweet_post` confabulation (model invented "daily limit code 344"; 344≠185 the real daily-limit code; tweet was 213ch, cookies valid, first post of day). Files: `src/lib/x-poster/x-errors.ts` (NEW classifier) + .test, `types.ts` (+xErrorCode/xErrorLabel on PostResult), `cookie-backend.ts` + `api-backend.ts` (classify+structured pino log), `src/tools/builtin/x-post.ts` (surface code/label in attempts + "relay verbatim" directive).

## Verified-correct invariants (the load-bearing safety properties)
- **Precedence**: `x-errors.ts:90` `mapped ?? "unknown"`; status-fallback branch gated on `if (label==="unknown")` (L93). A recognized NON-auth code (64=suspended, 187=dup) on a 401/403 keeps its label, `authExpired=false` → suspension never triggers cookie-refresh wall. This is the key anti-regression property.
- **Cookie-expiry preserved**: bare 401/403 no code → label unknown → status branch → authExpired=true → propagates `cookie-backend.ts:189` → `router.ts:62 attempts.every(a=>a.authExpired===true)` → `x-post.ts:161 REFRESH_GUIDANCE`.
- **Unknown code surfaces verbatim**: 344 → {code:344, label:"unknown", message:X's text, authExpired:false}. Confabulation now structurally impossible from the tool result.
- **Secret safety**: logged fields are scalars only (account,status,code,label,message). `message`=X's OWN response JSON (cookies go out in request headers via `authHeaders()`/`cookiePayload()`, never echoed back). pino logger (`src/lib/logger.ts`) has NO serializers that expand objects; no call site passes creds/headers. `raw.slice(0,240)` slices X's RESPONSE body not request. Clean.

## Warnings found (both low-risk, dormant)
- W1 `parseXError` regex fallback `x-errors.ts:77` `raw.match(/"code"\s*:\s*(\d+)/)` is UNSCOPED — grabs first `"code":N` anywhere in a malformed body (fires when JSON parse fails OR parsed JSON lacks errors[]). If that N is a known auth code (32/89) → false auth_expired. Real risk near-zero (X returns clean JSON). Untested false-positive path.
- W2 `describeXError` echoes `info.message` UNCAPPED into PostResult.error → relayed to model. The 200-no-id paths have slice(0,240); classified-error path has no bound. Cosmetic (X msgs short).

## Test-coverage gaps (recommendations, not blockers)
- No regex false-positive test (body with `"code":32` outside errors[] should NOT be auth_expired).
- No router-level test proving a suspension (code 64 both backends) yields allAuthExpired=false → attempts shown, NOT REFRESH_GUIDANCE. Unit test proves classifier sets authExpired=false but doesn't wire through router.post→x-post.

## Doctrine
- When auditing an error-CLASSIFIER fix: the load-bearing property is the PRECEDENCE rule (known code beats status fallback) AND that the status fallback still fires for the bare case. Verify BOTH directions: known-non-auth-code-on-403 must NOT set authExpired; bare-403-no-code MUST. Both have tests here.
- Secret-leak check for a "we now log failures" fix: (1) what fields go in the log object (scalars vs objects), (2) does the logger have auto-serializers that expand objects, (3) can the logged string field (X's message/raw) contain OUR secret — answer is no when the secret is sent in REQUEST headers and the logged value is the RESPONSE body.
- 16/16 tests genuinely assert the confabulation-prevention behavior (344→verbatim, 64→not-auth-expiry, bare-401→auth-expiry). Good adversarial coverage; gaps are regex-FP + router-wiring only.
