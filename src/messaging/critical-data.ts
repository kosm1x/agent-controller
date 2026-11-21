/**
 * The critical-data safety net: after a chat task completes, the values in
 * the user's message that match a credential or identifier pattern are
 * stored as user facts, unless the run called the fact tool itself.
 *
 * This module must not import the message router: the router imports
 * `ensureCriticalDataPersisted` from here, so an import back would make the
 * two a cycle.
 */
import { getDatabase } from "../db/index.js";
import { setUserFact } from "../db/user-facts.js";

// ---------------------------------------------------------------------------
// Critical data persistence safety net
// ---------------------------------------------------------------------------

interface DetectedCredential {
  key: string;
  value: string;
}

/**
 * Scan user text for critical data patterns (API keys, IDs, credentials)
 * that should be persisted regardless of whether the LLM called user_fact_set.
 */
function detectCriticalData(text: string): DetectedCredential[] {
  const results: DetectedCredential[] = [];

  // Google API key: `googleApiKey` → fact key `google_api_key`
  const googleApiKey = text.match(/\b(AIzaSy[A-Za-z0-9_-]{33})\b/);
  if (googleApiKey) {
    results.push({ key: "google_api_key", value: googleApiKey[1] });
  }

  // GA4 measurement ID: `ga4Full` → fact key `ga4_measurement_id`
  const ga4Full = text.match(/\b(G-[A-Z0-9]{8,12})\b/);
  if (ga4Full) {
    results.push({ key: "ga4_measurement_id", value: ga4Full[1] });
  }
  // GA4 measurement ID: `ga4Labeled` → fact key `ga4_measurement_id`
  if (!ga4Full) {
    const ga4Labeled = text.match(
      /(?:m(?:e(?:asure)?)?s?rmnt|measurement)\s*id\s*[:\s]*([A-Z0-9]{8,12})\b/i,
    );
    if (ga4Labeled) {
      results.push({
        key: "ga4_measurement_id",
        value: `G-${ga4Labeled[1]}`,
      });
    }
  }

  // GA4 stream ID: `streamId` → fact key `ga4_stream_id`
  const streamId = text.match(/(?:stream\s*(?:id)?)\s*[:\s]*(\d{10,15})/i);
  if (streamId) {
    results.push({ key: "ga4_stream_id", value: streamId[1] });
  }

  // Labeled API key or token: `labeledSecret` → fact key `api_credential`
  const labeledSecret = text.match(
    /(?:api[_ ]?key|token|secret)\s*[:\s=]+\s*["']?([A-Za-z0-9_\-.]{20,})/i,
  );
  if (labeledSecret && !googleApiKey) {
    results.push({ key: "api_credential", value: labeledSecret[1] });
  }

  // Labeled password: `labeledPassword` → fact key `password`
  const labeledPassword = text.match(
    /(?:password|contraseña|pswd|pwd|pass)\s*[:\s=]+\s*["']?(\S{8,})/i,
  );
  if (labeledPassword) {
    results.push({ key: "password", value: labeledPassword[1] });
  }

  // Labeled login: `labeledLogin` → fact key `login`
  const labeledLogin = text.match(
    /(?:login|user(?:name)?|usuario)\s*[:\s=]+\s*["']?(\S{3,})/i,
  );
  if (labeledLogin) {
    results.push({ key: "login", value: labeledLogin[1] });
  }

  // WordPress application password: `wpAppPass` → fact key `wp_app_password`
  const wpAppPass = text.match(
    /(?:app(?:lication)?\s*pass(?:word)?|contraseña\s*de\s*aplicación)[^:=\n]*[:\s=]+\s*["']?([A-Za-z0-9]{4}(?:\s+[A-Za-z0-9]{4}){4,})/i,
  );
  if (wpAppPass) {
    results.push({ key: "wp_app_password", value: wpAppPass[1] });
  }

  // FTP host: `ftpHost` → fact key `ftp_host`
  const ftpHost = text.match(
    /(?:ftp|sftp)\s*(?:host)?\s*[:\s=]*\s*((?:s?ftp:\/\/)?[\d.]+|(?:s?ftp:\/\/)?[\w.-]+\.\w{2,})/i,
  );
  if (ftpHost) {
    results.push({ key: "ftp_host", value: ftpHost[1] });
  }

  return results;
}

/**
 * Post-execution safety net: if user message contained critical data
 * and the LLM didn't call user_fact_set, auto-store it.
 */
export function ensureCriticalDataPersisted(userText: string, taskId: string): void {
  const detected = detectCriticalData(userText);
  if (detected.length === 0) return;

  // Check if user_fact_set was called by this task
  try {
    const run = getDatabase()
      .prepare(
        "SELECT r.output FROM runs r WHERE r.task_id = ? ORDER BY r.created_at DESC LIMIT 1",
      )
      .get(taskId) as { output: string | null } | undefined;

    let toolCalls: string[] = [];
    if (run?.output) {
      try {
        const parsed = JSON.parse(run.output);
        toolCalls = parsed.toolCalls ?? [];
      } catch {
        /* bare string output — no tools */
      }
    }

    if (toolCalls.includes("user_fact_set")) return; // LLM already stored it

    // Auto-store detected credentials
    for (const cred of detected) {
      if (!setUserFact("projects", cred.key, cred.value, "auto-detected")) {
        console.log("[router] Auto-persist skipped a mailbox password");
        continue;
      }
      console.log(
        `[router] Auto-persisted critical data: projects/${cred.key} (LLM missed user_fact_set)`,
      );
    }
  } catch (err) {
    console.error(`[router] Critical data persistence check failed: ${err}`);
  }
}
